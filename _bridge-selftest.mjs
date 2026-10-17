// dsh-window-control 桥引擎自测：在临时目录里造一个**微型假 asar**，跑完整链路。
//
// 为什么不用真的 app.asar：那是 115 MB 的系统文件，测试不能依赖它、更不能碰它。
// 假归档复刻了真归档的全部结构约束 —— 头部 pickle 长度字段、path→meta 的目录树、
// offset/size 是字符串、integrity 的 hash 在文本里出现两次（hash 与 blocks[0] 同值，
// 引擎正是靠「命中 2 次」来确认改对了地方）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engine = await import(pathToFileURL(path.join(here, 'lib', 'asar-bridge.js')).href)

const results = []
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra })
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 造一段长度精确为 `length` 字节、且锚点只出现一次的块注释。 */
function comment(anchor, length) {
  const head = anchor + '\n'
  const tail = '\n*/'
  const filler = length - Buffer.byteLength(head, 'utf8') - Buffer.byteLength('* ', 'utf8') - Buffer.byteLength(tail, 'utf8')
  if (filler < 0) throw new Error('长度不够放下锚点')
  return head + '* ' + 'x'.repeat(filler) + tail
}

/**
 * 造一个微型 asar。
 * @param dir - 输出目录。
 * @param options - `{ main, preload, extra?, noIntegrity? }`：两个目标条目正文；
 *   `extra` 是额外的 `[文件名, 内容]`（放在 /lib 下），`noIntegrity` 列出不写 integrity 的文件名。
 * @returns 归档路径。
 */
function makeAsar(dir, options) {
  const items = [
    ['main.js', '/lib/main.js', options.main],
    ['preload-app.cjs', '/lib/preload-app.cjs', options.preload],
  ]
  /* 额外条目：都放在 /lib 下，用来构造「同内容不同条目」这类边界情况。 */
  for (const [name, text] of options.extra || []) items.push([name, '/lib/' + name, text])
  const noIntegrity = options.noIntegrity || []

  let offset = 0
  const metas = {}
  const data = []
  for (const [file, key, text] of items) {
    const buf = Buffer.from(text, 'utf8')
    const digest = sha256(buf)
    const meta = { size: buf.length, offset: String(offset) }
    /* 真实归档里 integrity 可能存在也可能不存在（看打包方式），两种都得能装。 */
    if (!noIntegrity.includes(file)) {
      meta.integrity = { algorithm: 'SHA256', blocks: [digest], hash: digest }
    }
    metas[key] = meta
    offset += buf.length
    data.push(buf)
  }
  const header = {
    files: { lib: { files: Object.fromEntries(items.map(([file, key]) => [file, metas[key]])) } },
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(json.length + 8, 4)
  head.writeUInt32LE(json.length + 4, 8)
  head.writeUInt32LE(json.length, 12)
  const file = path.join(dir, 'app.asar')
  fs.writeFileSync(file, Buffer.concat([head, json, ...data]))
  return file
}

/** 造一份「符号齐全」的条目正文。 */
function goodMain() {
  return [
    comment(engine.ANCHORS.main, 1000),
    '',
    'import { ipcMain, BrowserWindow, dialog, app } from "electron";',
    'function assertDesktopSender(){}',
    'let skipQuitConfirmation = false;',
    'export function stop(){ app.quit(); }',
  ].join('\n')
}
function goodPreload() {
  return [comment(engine.ANCHORS.preload, 504), '', 'const contextBridge = 1; const ipcRenderer = 2;'].join('\n')
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwc-bridge-test-'))
try {
  // ---- 纯函数 ----
  const head16 = Buffer.alloc(16)
  head16.writeUInt32LE(1234, 12)
  check('parseHeader 读得出 JSON 长度', engine.parseHeader(head16).jsonLength === 1234)
  let parseThrew = false
  try {
    engine.parseHeader(Buffer.alloc(16))
  } catch {
    parseThrew = true
  }
  check('parseHeader 拒绝长度异常的头部', parseThrew)

  const buf = Buffer.from('abcdefgh')
  engine.replaceAsciiInPlace(buf, 'abcd', 'WXYZ')
  check('replaceAsciiInPlace 等长替换', buf.toString() === 'WXYZefgh')

  let threw = false
  try {
    engine.replaceAsciiInPlace(Buffer.from('ab'), 'a', 'bb')
  } catch {
    threw = true
  }
  check('replaceAsciiInPlace 拒绝不等长', threw)

  const small = path.join(dir, 'hash.txt')
  fs.writeFileSync(small, 'hello 世界')
  check('fileSha256 与 crypto 一致', engine.fileSha256(small) === sha256(fs.readFileSync(small)))

  check('REQUIRED_SYMBOLS 覆盖两个目标', Object.keys(engine.REQUIRED_SYMBOLS).sort().join(',') === 'main,preload')
  check('TARGETS 路径带前导斜杠', engine.TARGETS.main.startsWith('/') && engine.TARGETS.preload.startsWith('/'))

  // ---- 完整链路：安装 → 幂等 → 加锁 → 卸载 ----
  const archive = makeAsar(dir, { main: goodMain(), preload: goodPreload() })
  const originalBytes = fs.readFileSync(archive)

  const before = engine.status(archive)
  check('初始状态：未安装', before.ok && before.installed === false, 'entryCount=' + before.entryCount)
  check('初始状态：条目数 2', before.entryCount === 2)

  const first = engine.install(archive)
  check('install 成功', first.ok === true, first.message)
  check('install 报告 changed', first.changed === true)
  check('install 后自检通过', engine.status(archive).installed === true)
  check('install 生成了 .orig 备份', fs.existsSync(engine.backupPath(archive)))
  check('归档总大小不变（等长替换）', fs.readFileSync(archive).length === originalBytes.length)
  check('备份内容就是原版', engine.fileSha256(engine.backupPath(archive)) === sha256(originalBytes))

  const second = engine.install(archive)
  check('重复 install 幂等', second.ok === true && second.changed === false, second.message)

  // 锁：持有期间另一进程不得改动
  const held = engine.acquireLock(archive)
  check('acquireLock 成功', held.ok === true)
  const blocked = engine.install(archive, { force: true })
  check('持锁时 install 被拒绝', blocked.ok === false && /另一个进程/.test(blocked.message), blocked.message)
  const blockedRestore = engine.restore(archive)
  check('持锁时 restore 被拒绝', blockedRestore.ok === false && /另一个进程/.test(blockedRestore.message))
  check('被拒绝后归档未被改动', engine.status(archive).installed === true)
  engine.releaseLock(held)
  check('releaseLock 后锁文件消失', !fs.existsSync(engine.lockPath(archive)))

  const staleDir = path.join(dir, 'stale')
  fs.mkdirSync(staleDir)
  const staleArchive = path.join(staleDir, 'app.asar')
  fs.writeFileSync(staleArchive, 'x')
  fs.writeFileSync(engine.lockPath(staleArchive), '{}')
  const old = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(engine.lockPath(staleArchive), old, old)
  const reclaimed = engine.acquireLock(staleArchive)
  check('陈旧锁被回收', reclaimed.ok === true)
  engine.releaseLock(reclaimed)

  // 卸载：还原 + 清备份 + 幂等
  const removed = engine.uninstall(archive)
  check('uninstall 成功', removed.ok === true, removed.message)
  check('uninstall 报告 changed', removed.changed === true)
  check('uninstall 删掉了备份', removed.removedBackup === true && !fs.existsSync(engine.backupPath(archive)))
  check('卸载后归档逐字节回到原版', sha256(fs.readFileSync(archive)) === sha256(originalBytes))

  const again = engine.uninstall(archive)
  check('重复 uninstall 幂等且不写盘', again.ok === true && again.changed === false, again.message)

  // ---- 还原失败必须如实报告：归档读不出来 ≠ 还原成功 ----
  const brokenDir = path.join(dir, 'broken')
  fs.mkdirSync(brokenDir)
  const brokenArchive = makeAsar(brokenDir, { main: goodMain(), preload: goodPreload() })
  engine.install(brokenArchive)
  /*
   * 把备份弄成「长度字段就是坏的」：还原时不管走「整文件覆盖」还是「运行中原地覆盖」
   * 那条路，归档头部都会变成不可解析 —— 而这正是必须被报成失败的那种局面。
   */
  fs.writeFileSync(engine.backupPath(brokenArchive), Buffer.alloc(64, 0))
  const brokenRestore = engine.restore(brokenArchive, { force: true })
  check(
    '备份损坏时 restore 报失败（而不是假装还原成功）',
    brokenRestore.ok === false && /无法解析/.test(brokenRestore.message),
    brokenRestore.message,
  )

  // ---- DSH 升级把归档换回原版后，残留的 .orig 也要能清掉 ----
  const orphanDir = path.join(dir, 'orphan')
  fs.mkdirSync(orphanDir)
  const orphanArchive = makeAsar(orphanDir, { main: goodMain(), preload: goodPreload() })
  const orphanOriginal = fs.readFileSync(orphanArchive)
  engine.install(orphanArchive)
  fs.writeFileSync(orphanArchive, orphanOriginal) // 模拟升级：归档回到原版，.orig 还在
  const orphan = engine.uninstall(orphanArchive)
  check(
    '归档已是原版时 uninstall 仍清掉孤儿备份',
    orphan.ok === true &&
      orphan.changed === false &&
      orphan.removedBackup === true &&
      !fs.existsSync(engine.backupPath(orphanArchive)),
    orphan.message,
  )

  // ---- 归档里有「内容完全相同的另一个条目」时，不能改坏别人的完整性哈希 ----
  const dupDir = path.join(dir, 'dup')
  fs.mkdirSync(dupDir)
  const dupArchive = makeAsar(dupDir, {
    main: goodMain(),
    preload: goodPreload(),
    extra: [['dup.js', goodMain()]],
  })
  const dupInstalled = engine.install(dupArchive)
  check('同内容条目共存时 install 仍能成功', dupInstalled.ok === true, dupInstalled.message)
  const dupBlocks = (dupInstalled.report && dupInstalled.report.blocks) || []
  const dupMainBlock = dupBlocks.find((block) => block.target === '/lib/main.js')
  const dupPreloadBlock = dupBlocks.find((block) => block.target === '/lib/preload-app.cjs')
  check(
    '旧哈希命中 4 次时按 entry offset 定位',
    !!dupMainBlock && dupMainBlock.hashMode === 'offset',
    dupBlocks.map((block) => block.target + '=' + block.hashMode).join(' | '),
  )
  check(
    '正常条目仍走「两处等长替换」',
    !!dupPreloadBlock && dupPreloadBlock.hashMode === 'plain',
    dupPreloadBlock && dupPreloadBlock.hashMode,
  )
  const dupLoaded = engine.readArchive(dupArchive)
  const dupMeta = dupLoaded.entries.get('/lib/dup.js')
  check(
    '没有改坏同内容条目的完整性哈希',
    dupMeta.integrity.hash === sha256(Buffer.from(goodMain(), 'utf8')),
  )
  check('同内容条目本身逐字节未动', engine.entryBuffer(dupLoaded, dupMeta).toString('utf8') === goodMain())
  check('同内容场景下安装后自检通过', engine.status(dupArchive).installed === true)

  // ---- 条目没有 integrity 块时不能永久拒装 ----
  const plainDir = path.join(dir, 'nointegrity')
  fs.mkdirSync(plainDir)
  const plainArchive = makeAsar(plainDir, {
    main: goodMain(),
    preload: goodPreload(),
    noIntegrity: ['main.js'],
  })
  const plainInstalled = engine.install(plainArchive)
  check('条目缺 integrity 时仍能安装', plainInstalled.ok === true, plainInstalled.message)
  const plainBlocks = (plainInstalled.report && plainInstalled.report.blocks) || []
  const plainMainBlock = plainBlocks.find((block) => block.target === '/lib/main.js')
  check(
    '缺 integrity 的条目标记为 none（不写哈希）',
    !!plainMainBlock && plainMainBlock.hashMode === 'none',
    plainBlocks.map((block) => block.target + '=' + block.hashMode).join(' | '),
  )
  const plainStatus = engine.status(plainArchive)
  check('缺 integrity 时安装后状态正常', plainStatus.ok === true && plainStatus.installed === true)
  check('缺 integrity 时备份仍已生成', fs.existsSync(engine.backupPath(plainArchive)))

  // ---- 符号预检：缺符号时必须拒绝，且不产生任何副作用 ----
  const driftDir = path.join(dir, 'drift')
  fs.mkdirSync(driftDir)
  const driftArchive = makeAsar(driftDir, {
    main: goodMain().replace('assertDesktopSender', 'assertXesktopSender'),
    preload: goodPreload(),
  })
  const driftBytes = fs.readFileSync(driftArchive)
  const rejected = engine.install(driftArchive)
  check(
    '缺符号时 install 被拒绝',
    rejected.ok === false && /缺少注入所需符号/.test(rejected.message),
    rejected.message,
  )
  check('被拒绝后归档未改动', sha256(fs.readFileSync(driftArchive)) === sha256(driftBytes))
  check('被拒绝后不留备份', !fs.existsSync(engine.backupPath(driftArchive)))
  check('被拒绝后不留锁文件', !fs.existsSync(engine.lockPath(driftArchive)))

  // ---- 锚点漂移：改了锚点也必须拒绝 ----
  const anchorDir = path.join(dir, 'anchor')
  fs.mkdirSync(anchorDir)
  const anchorArchive = makeAsar(anchorDir, { main: goodMain().replace('one atomic step', 'two atomic steps'), preload: goodPreload() })
  const anchorRejected = engine.install(anchorArchive)
  check(
    '锚点漂移时 install 被拒绝',
    anchorRejected.ok === false && /锚点/.test(anchorRejected.message),
    anchorRejected.message,
  )

  // ---- 权限预检：写不进去时要讲人话，且不能动归档 ----
  const permDir = path.join(dir, 'perm')
  fs.mkdirSync(permDir)
  const permArchive = makeAsar(permDir, { main: goodMain(), preload: goodPreload() })
  const beforePerm = sha256(fs.readFileSync(permArchive))
  check('可写归档 writable() 通过', engine.writable(permArchive).ok === true)
  fs.chmodSync(permArchive, 0o444)
  const permProbe = engine.writable(permArchive)
  check('只读归档 writable() 判定为不可写', permProbe.ok === false, permProbe.code || '(无 code)')
  const permResult = engine.install(permArchive)
  check(
    '权限不足时 install 带 permission 标记并给出可操作提示',
    permResult.ok === false &&
      permResult.permission === true &&
      /权限|提权|autoInstall/.test(permResult.message),
    permResult.message.slice(0, 60) + '…',
  )
  check('权限不足时不改动归档', sha256(fs.readFileSync(permArchive)) === beforePerm)
  check('权限不足时不留备份', !fs.existsSync(engine.backupPath(permArchive)))
  fs.chmodSync(permArchive, 0o644)

  // ---- 平台分支：Linux 必须有兜底候选（execPath 分支覆盖不到的场景）----
  const realPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const linuxCandidates = engine.candidates({ argv: [], execPath: '' })
    check(
      'Linux 平台给出兜底候选路径',
      linuxCandidates.some((p) => p.includes('/opt/') || p.includes('.local/share')),
      linuxCandidates.filter((p) => p.includes('/opt/') || p.includes('.local/share')).length + ' 条',
    )
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
  check('平台还原为 ' + realPlatform, process.platform === realPlatform)

  // ---- 版本升级：机器上装的是旧版桥时必须自动升级 ----
  const upDir = path.join(dir, 'upgrade')
  fs.mkdirSync(upDir)
  const upArchive = makeAsar(upDir, { main: goodMain(), preload: goodPreload() })
  const firstInstall = engine.install(upArchive)
  check('首次安装成功', firstInstall.ok === true, firstInstall.message)
  const vNow = engine.status(upArchive)
  check(
    '装好后版本 = 目标版本',
    vNow.version === engine.BRIDGE_VERSION,
    'v' + vNow.version + ' / 目标 v' + engine.BRIDGE_VERSION,
  )
  check('已是目标版本时不标记可升级', vNow.upgradable === false)

  // 把 preload 里的 `v:N` 改小（等长），模拟「这台机器装的是旧版桥」
  const raw = fs.readFileSync(upArchive)
  const at = raw.indexOf(Buffer.from('v:' + String(engine.BRIDGE_VERSION), 'utf8'))
  check('能在归档里定位到版本号', at >= 0)
  if (at >= 0) {
    raw[at + 2] = 0x32 // ASCII '2'
    fs.writeFileSync(upArchive, raw)
  }
  const vOld = engine.status(upArchive)
  check('模拟旧版桥成功', vOld.installed === true && vOld.version === 2, 'v' + vOld.version)
  check('旧版桥被标记为可升级', vOld.upgradable === true)

  const upgraded = engine.install(upArchive)
  check('旧版桥自动升级', upgraded.ok === true && upgraded.changed === true, upgraded.message)
  check('升级来源被记录', upgraded.upgradedFrom === 2, String(upgraded.upgradedFrom))
  const vAfter = engine.status(upArchive)
  check(
    '升级后版本回到目标版本',
    vAfter.version === engine.BRIDGE_VERSION,
    'v' + vAfter.version,
  )
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? '  [OK] ' : '  [FAIL] '}${r.name}${r.extra ? '  -> ' + r.extra : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过（桥引擎）`)
process.exit(failed === 0 ? 0 : 1)
