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
import { build, install, locate, lockPath, restore, status, uninstall, verify } from './asar-bridge.js'

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
 * 打印一行带状态标记的输出。
 * @param ok - 是否为通过项。
 * @param text - 说明文本。
 */
function line(ok, text) {
  console.log((ok ? '  [OK] ' : '  [!!] ') + text)
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
  const built = build(archive)
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
        ' 字节，填充 ' + String(block.padding) + ' 空格',
    )
  }
  const checked = verify(archive, built)
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
  for (let i = 0; i < runs; i += 1) bd = average(() => build(archive))
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
