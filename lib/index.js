/**
 * dsh-window-control — 宿主半边（Host half）。
 *
 * ## 它做什么
 *
 * DSH 的宿主进程跑在 `ELECTRON_RUN_AS_NODE=1` 的独立 Node 子进程里，**没有任何
 * Electron 能力**（整个宿主包里 `BrowserWindow` 出现 0 次），所以窗口全屏 / 最大化
 * / 退出这三件事宿主侧做不到，必须由渲染端调主进程通道。而主进程原本一条窗口通道
 * 都没开（测绘结论见 `asar-bridge.js` 顶部），因此必须补一次宿主补丁：
 *
 *   dsh-desktop:window-state            读取 { fullscreen, maximized, minimized, top }
 *   dsh-desktop:window-fullscreen-set   设置窗口全屏
 *   dsh-desktop:window-maximize         最大化 / 还原
 *   dsh-desktop:window-minimize         最小化 / 唤醒（v3）
 *   dsh-desktop:window-top              窗口置顶 / 取消置顶（v3）
 *   dsh-desktop:app-quit                退出应用（先弹原生确认对话框）
 *
 * 宿主半边就是那次补丁的**安装器**：每次 DSH 启动时延迟检查一次 app.asar，没打桥就
 * 自动打上（幂等、带备份、带自检），打过就什么都不做。反过来，当 `autoInstall` 被设为
 * `false`（也就是用户关掉了这个插件）时，它做的是**撤桥** —— 把归档还原成原版并清掉备份，
 * 让 DSH 回到没打过补丁的样子。桥本体是纯 Node 实现（`asar-bridge.js`），不依赖 Python，
 * 也不含任何写死的用户名或安装路径。
 *
 * ## 为什么放在运行时而不是 postinstall
 *
 * 插件市场的红线里明确有「runs code at install time (postinstall)」。把改宿主的动作
 * 放在 `postinstall` 会被标记，也违背「先让用户看到再动手」的常识。所以这里只在
 * **用户已经装好并启动过一次 DSH** 之后才执行，并且：
 *   - 首次改动前一定先备份到 `app.asar.orig`
 *   - 注入前做完整自检，不通过绝不动线上文件
 *   - 过程只写日志，异常只吞不抛，绝不影响 profile 启动
 *
 * ## 为什么用动态 import
 *
 * 桥引擎是独立的纯函数模块，便于单测；但宿主插件加载器对相对导入的支持没有公开约定，
 * 所以这里用动态 import 并整段 try/catch —— 万一加载方式变了，最坏结果是「自动安装
 * 不可用」，而不会连带把插件本身拖挂。
 *
 * @packageDocumentation
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名。 */
export const name = 'window-control'

/** 本插件不注入任何宿主服务。 */
export const inject = []

/**
 * 首次安装前的等待时间。
 *
 * 避开发动机启动的关键路径：此时 Web 服务和插件树都已就位、界面已可用，复制备份
 * （约 121 MB）不会拖慢任何人的启动体验。
 */
const START_DELAY_MS = 1500

/** 桥引擎模块缓存。 */
let engine = null

/**
 * 加载桥引擎（只加载一次）。
 *
 * @returns 引擎模块，或 null（加载失败时）。
 */
async function loadEngine() {
  if (engine) return engine
  try {
    engine = await import('./asar-bridge.js')
    return engine
  } catch (error) {
    emit(null, 'warn', '桥引擎加载失败: ' + describe(error))
    return null
  }
}

/**
 * 把未知异常转成一行文本。
 *
 * @param error - 任意异常值。
 * @returns 字符串描述。
 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 输出一条日志：优先走 Cordis logger，退回 console。
 *
 * 两种调用形态都试一遍 —— 宿主侧 logger 是 `ctx.logger(name)` 返回带方法的对象，
 * 其它上下文习惯直接挂 `info` 方法。
 *
 * @param ctx - 宿主上下文（可为 null）。
 * @param level - 'info' | 'warn'。
 * @param message - 日志正文。
 */
function emit(ctx, level, message) {
  try {
    const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dsh-window-control') : ctx?.logger
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
    if (fn) {
      fn(message)
      return
    }
  } catch {
    /* 落到 console */
  }
  try {
    const text = '[dsh-window-control] ' + message
    if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    /* 彻底静默 */
  }
}

/**
 * 插件状态文件路径（尽力而为，写不了就算了）。
 *
 * 写它只是为了让排障时能直接看到「上一次启动到底装没装、为什么没装」。渲染端读不到
 * 文件，所以它不是功能依赖。
 *
 * @returns 绝对路径。
 */
function statusFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  /*
   * profile 名不再写死：本机默认是 desktop，但别人可能用别的 profile（或企业镜像里
   * 指定了自定义名）。拿不到就退回 desktop，反正这个文件只用于排障。
   */
  const profile = process.env.DSH_PROFILE || 'desktop'
  return path.join(home, 'profiles', profile, '.dsh-window-control.json')
}

/**
 * 记录一次自动安装的结果。
 *
 * @param payload - 要写入的对象。
 */
function writeStatus(payload) {
  try {
    const file = statusFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2))
  } catch {
    /* 状态文件是纯诊断用途，失败不影响任何功能 */
  }
}

/**
 * 主流程：定位归档 -> 看状态 -> 需要时安装。
 *
 * @param ctx - 宿主上下文。
 * @returns 结果对象（供日志与测试使用）。
 */
export async function runOnce(ctx) {
  const module = await loadEngine()
  if (!module) {
    writeStatus({ ok: false, message: '桥引擎不可用' })
    return { ok: false, message: '桥引擎不可用' }
  }

  const found = module.locate()
  if (!found) {
    /* 定位失败时把现场信息留下来 —— 不同安装方式下 argv / execPath 差异很大。 */
    let candidates = []
    try {
      const probeFs = module.fs || fs
      candidates = module.candidates().map((p) => {
        const item = { path: p, exists: false, isFile: false, error: null }
        try {
          item.exists = probeFs.existsSync(p)
          if (item.exists) item.isFile = probeFs.statSync(p).isFile()
        } catch (error) {
          item.error = describe(error)
        }
        return item
      })
    } catch {
      candidates = []
    }
    const diagnostics = {
      argv: process.argv.slice(0, 8),
      execPath: process.execPath,
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA || null,
      fsSource: module.fsSource || 'node:fs',
      candidates,
    }
    emit(
      ctx,
      'warn',
      '找不到 app.asar；候选: ' +
        candidates
          .map((c) => c.path + (c.isFile ? ' [文件]' : c.exists ? ' [存在但非文件]' : ' [无]'))
          .join(' | '),
    )
    writeStatus({ ok: false, message: '找不到 app.asar', diagnostics })
    return { ok: false, message: '找不到 app.asar', diagnostics }
  }

  const before = module.status(found.archive)
  if (!before.ok) {
    emit(ctx, 'warn', '无法读取归档: ' + String(before.error))
    writeStatus({ ok: false, archive: found.archive, message: String(before.error) })
    return { ok: false, message: String(before.error) }
  }

  const target = module.BRIDGE_VERSION || 0
  if (before.installed && before.version >= target) {
    emit(ctx, 'info', '窗口通道已就位 (v' + String(before.version) + ')，无需处理')
    writeStatus({
      ok: true,
      archive: found.archive,
      installed: true,
      version: before.version,
      targetVersion: target,
      changed: false,
    })
    return { ok: true, changed: false, message: '已就位' }
  }
  if (before.installed) {
    /*
     * 版本落后：桥是等长替换，没法原地换代码，只能「还原 + 重打」。
     * 引擎会自己先回滚再注入，所以这里照常调 install 即可。
     */
    emit(ctx, 'info', '窗口通道 v' + String(before.version) + ' → v' + String(target) + '，正在升级')
  }

  const result = module.install(found.archive)
  emit(ctx, result.ok ? 'info' : 'warn', result.message)
  writeStatus({
    ok: result.ok,
    archive: found.archive,
    installed: Boolean(result.ok),
    version: result.version === undefined ? before.version : result.version,
    targetVersion: target,
    changed: Boolean(result.changed),
    running: Boolean(result.running),
    /* 从旧版本桥升级上来时记一笔，排障时能看到这次到底做了什么。 */
    upgradedFrom: result.upgradedFrom || undefined,
    /* 写入失败时引擎会自动用备份还原，把这件事记下来，排障时一眼能看到。 */
    rolledBack: Boolean(result.rolledBack),
    message: result.message,
  })
  return result
}

/**
 * 撤桥流程：把归档还原成原版，并把本插件留下的痕迹清干净。
 *
 * 这是 `autoInstall: false` 时的动作 —— 也就是「关掉这个插件」。
 *
 * 为什么必须是「关掉即撤桥」而不是「什么都不做」：桥是写进 DSH 安装目录的，
 * 插件一旦不再使用它，留在那里的就是一段**不会有人维护的死代码**。用户关掉插件
 * 的语义就是「让 DSH 回到没打过补丁的样子」，所以这里主动还原。
 *
 * 卸载场景做不到自动还原（插件被卸载后已经不在运行，没有任何代码会执行），
 * 因此 README 明确要求「卸载前先关掉这个开关」。
 *
 * 幂等且带保护：归档本来就是原版时**不写任何字节**。
 *
 * @param ctx - 宿主上下文。
 * @returns 结果对象（供日志与测试使用）。
 */
export async function rollbackOnce(ctx) {
  const module = await loadEngine()
  if (!module) {
    writeStatus({ ok: false, message: '桥引擎不可用' })
    return { ok: false, message: '桥引擎不可用' }
  }

  const found = module.locate()
  if (!found) {
    emit(ctx, 'warn', '找不到 app.asar，无法确认是否需要撤桥')
    writeStatus({ ok: false, message: '找不到 app.asar' })
    return { ok: false, message: '找不到 app.asar' }
  }

  const before = module.status(found.archive)
  if (!before.ok) {
    emit(ctx, 'warn', '无法读取归档: ' + String(before.error))
    writeStatus({ ok: false, archive: found.archive, message: String(before.error) })
    return { ok: false, message: String(before.error) }
  }

  /*
   * 归档已经是原版时也照走一趟 uninstall：它会顺手删掉可能还留着的 app.asar.orig。
   * 典型场景是 DSH 自动升级把 app.asar 整体换掉（桥随之消失）之后，用户才来关这个插件 ——
   * 早先这里直接 return，那个 115 MB 的备份就成了没人管的孤儿文件。
   */
  const result = module.uninstall(found.archive)
  emit(ctx, result.ok ? 'info' : 'warn', result.ok ? result.message : '撤桥失败: ' + result.message)
  writeStatus({
    ok: result.ok,
    archive: found.archive,
    installed: result.ok ? false : Boolean(before.installed),
    changed: Boolean(result.changed),
    removedBackup: Boolean(result.removedBackup),
    message: result.message,
  })
  return result
}

/**
 * Cordis 入口。
 *
 * @param ctx - 宿主上下文。
 * @param config - 可选配置。
 *   - `autoInstall`（默认 `true`）：每次启动自动检查并补上窗口通道；设为 `false`
 *     则相反 —— 不只是「不装」，还会把已经打上的桥**撤掉**，让 DSH 保持原版。
 *     卸载插件之前请先把它设为 `false`（插件卸载后已不再运行，没法自己善后）。
 */
export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const disabled = options.autoInstall === false

  try {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        const task = disabled ? rollbackOnce(ctx) : runOnce(ctx)
        void task.catch((error) => {
          emit(ctx, 'warn', (disabled ? '撤桥过程异常: ' : '自动安装过程异常: ') + describe(error))
        })
      }, START_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    })
  } catch (error) {
    emit(ctx, 'warn', '注册启动自检失败: ' + describe(error))
  }
}

export default apply
