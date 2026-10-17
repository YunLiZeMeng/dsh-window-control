#!/usr/bin/env node
/**
 * dsh-window-control — 桥引擎命令行入口。
 *
 * 宿主半边在 DSH 启动时会自动调用同一套函数；本 CLI 只是把它做成可手动执行的
 * 形式，方便自检、排障和回滚。两者共用 `asar-bridge.js`，不存在第二套实现。
 *
 * 用法:
 *   node lib/bridge-cli.mjs status  [app.asar]
 *   node lib/bridge-cli.mjs check   [app.asar]   # 只构建 + 全量自检，不落盘
 *   node lib/bridge-cli.mjs install [app.asar] [--force]   # 备份 + 落盘（幂等）
 *   node lib/bridge-cli.mjs restore [app.asar] [--force]   # 从备份还原
 *   node lib/bridge-cli.mjs uninstall [app.asar]           # 还原 + 清掉备份（幂等）
 *   node lib/bridge-cli.mjs bench   [app.asar]             # 量一下读取/构建耗时
 *
 * `--force`：install 表示「已打过桥也先还原再重打一遍」；restore 表示「归档没打过桥
 * 也照写」—— 两者都在正常路径上不会有任何区别，只在需要强行覆盖时才有意义。
 */

import fs from 'node:fs'
import { backupPath, build, install, isRunning, locate, lockPath, restore, status, uninstall, verify } from './asar-bridge.js'

const action = process.argv[2] || 'status'
const args = process.argv.slice(3)
const force = args.includes('--force')
const explicit = args.filter((value) => !value.startsWith('--'))[0]

const found = locate({ explicit, argv: [], execPath: process.execPath })
if (!found) {
  console.error('找不到 app.asar。可以显式传路径，或设置环境变量 DSH_ASAR。')
  console.error('示例: node lib/bridge-cli.mjs status "C:/.../resources/app.asar"')
  process.exit(2)
}
const archive = found.archive

/**
 * 选一个「可以拿来做构建自检」的归档。
 *
 * 桥一旦装上，锚点注释就被注入代码整段吃掉了，`build()` 对着线上归档只会报
 * 「已经打过桥补丁」—— 而这恰恰是排障时最常见的状态（工具在需要它的时候用不了）。
 * 这种时候改看 `app.asar.orig`：它就是原版，对它的构建/自检结论同样证明
 * 「当前这个 DSH 版本还能不能被注入」。
 *
 * @returns `{ target, note }`；没有可用的构建对象时 `target` 为 null。
 */
function buildTarget() {
  const current = status(archive)
  if (!current.ok || !current.installed) return { target: archive, note: null }
  const backup = backupPath(archive)
  if (!fs.existsSync(backup)) {
    return { target: null, note: '归档已是打桥状态（v' + String(current.version) + '），且没有 .orig 备份可代替' }
  }
  return {
    target: backup,
    note:
      '归档已是打桥状态（v' + String(current.version) + '），无法原地构建；本次校验对象是原版备份 ' + backup,
  }
}

/**
 * 打印一行带状态标记的输出。
 * @param ok - 是否为通过项。
 * @param text - 说明文本。
 */
function line(ok, text) {
  console.log((ok ? '  [OK] ' : '  [!!] ') + text)
}

/**
 * 把哈希写入模式翻译成人话（只在 check / bench 的输出里用）。
 *
 * @param mode - `plain` / `offset` / `none`。
 * @returns 说明文本。
 */
function describeHashMode(mode) {
  if (mode === 'none') return '该条目没有完整性块（不写哈希）'
  if (mode === 'offset') return '旧哈希不只两处，已按 entry offset 精确定位'
  return '单块 SHA256（两处等长替换）'
}

/**
 * 打印桥状态。
 */
function showStatus() {
  const current = status(archive)
  console.log('归档        : ' + archive)
  console.log('备份 .orig  : ' + (current.backupExists ? '存在' : '不存在'))
  console.log('并发锁      : ' + (lockExists() ? '被占用' : '空闲'))
  console.log('条目数      : ' + String(current.entryCount))
  /* 写入策略取决于它：运行中只能等长就地覆盖，未运行才用整档替换。 */
  console.log('DSH 进程    : ' + (isRunning(archive) ? '运行中（就地覆盖）' : '未运行（整档替换）'))
  if (!current.ok) {
    console.log('读取失败    : ' + String(current.error))
    return
  }
  let state = '未安装'
  if (current.installed) {
    state =
      '已安装 v' +
      String(current.version) +
      (current.version >= 3 ? '（含最小化 / 窗口置顶）' : current.version >= 2 ? '（退出前弹原生确认框）' : '（退出无确认）')
    if (current.upgradable) {
      state += '  ← 可升级到 v' + String(current.targetVersion) + '（启动 DSH 会自动升级）'
    }
  }
  console.log('桥状态      : ' + state)
  console.log('目标版本    : v' + String(current.targetVersion))
}

/**
 * 归档旁边是否有锁文件。
 * @returns 布尔值。
 */
function lockExists() {
  try {
    return fs.existsSync(lockPath(archive))
  } catch {
    return false
  }
}

if (action === 'status') {
  showStatus()
  process.exit(0)
}

if (action === 'check') {
  const opened = buildTarget()
  if (!opened.target) {
    line(false, opened.note)
    process.exit(1)
  }
  if (opened.note) console.log('  [..] ' + opened.note)
  const target = opened.target
  const built = build(target)
  if (!built.ok) {
    line(false, '构建失败: ' + String(built.error))
    process.exit(1)
  }
  for (const block of built.report.blocks) {
    line(
      true,
      block.target +
        ': 替换块 ' + String(block.blockLength) +
        ' 字节，注入 ' + String(block.codeLength) +
        ' 字节，填充 ' + String(block.padding) + ' 空格，完整性：' + describeHashMode(block.hashMode),
    )
  }
  const checked = verify(target, built)
  line(checked.ok, checked.ok ? '自检通过（哈希自洽、头部等长、其余条目未动）' : '自检失败: ' + String(checked.error))
  if (checked.ok) for (const note of checked.notes) console.log('        · ' + note)
  showStatus()
  process.exit(checked.ok ? 0 : 1)
}

if (action === 'install') {
  const result = install(archive, { force })
  line(result.ok, result.message)
  if (!result.ok) process.exit(1)
  showStatus()
  process.exit(0)
}

if (action === 'restore') {
  const result = restore(archive, { force })
  line(result.ok, result.message)
  showStatus()
  process.exit(result.ok ? 0 : 1)
}

if (action === 'uninstall') {
  const result = uninstall(archive)
  line(result.ok, result.message)
  showStatus()
  process.exit(result.ok ? 0 : 1)
}

if (action === 'bench') {
  /* 只读、不落盘：量一下「每次 DSH 启动都要跑一遍」的那几步到底花多久。 */
  const opened = buildTarget()
  if (!opened.target) {
    line(false, opened.note)
    process.exit(1)
  }
  if (opened.note) console.log('  [..] ' + opened.note)
  const runs = 5
  const average = (fn) => {
    const start = process.hrtime.bigint()
    const value = fn()
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    return { value, ms }
  }
  let st = null
  for (let i = 0; i < runs; i += 1) st = average(() => status(archive))
  let bd = null
  for (let i = 0; i < runs; i += 1) bd = average(() => build(opened.target))
  const size = fs.statSync(archive).size
  console.log('归档大小      : ' + (size / 1048576).toFixed(1) + ' MB')
  console.log('status 平均   : ' + st.ms.toFixed(1) + ' ms（读头部 + 两个目标条目）')
  console.log('build  平均   : ' + bd.ms.toFixed(1) + ' ms（含符号预检与锚点定位）')
  const rss = process.memoryUsage().rss / 1048576
  console.log('进程 RSS      : ' + rss.toFixed(0) + ' MB（整档读取时代此值会额外多出 ~115 MB）')
  if (!bd.value.ok) line(false, 'build 失败: ' + String(bd.value.error))
  process.exit(bd.value.ok ? 0 : 1)
}

console.error('未知动作: ' + action + '（可用: status | check | install | restore | uninstall | bench）')
process.exit(2)
