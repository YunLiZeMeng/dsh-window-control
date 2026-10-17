/**
 * dsh-window-control — asar 桥引擎（纯 Node，零第三方依赖）。
 *
 * ## 它解决什么
 *
 * DeepSeek Harness 的主进程**没有**向渲染端开放任何窗口控制通道：官方
 * `DESKTOP_IPC` 里只有 `window-fullscreen`，而且只被 `webContents.send()`
 * 单向推送（告诉页面「进全屏了，去调整 40px 标题栏」），既没有
 * `ipcMain.handle` 注册它，也没有最大化 / 读状态 / 退出这三件事。官方给的
 * profile patch 层（`cordis.patch.yml`）只能改配置、禁用插件、插入插件 id，
 * 同样注入不了主进程代码。所以窗口控制**必须**改宿主。
 *
 * 本模块就是那次改动：在 `resources/app.asar` 里对两个文件做**等长就地替换**，
 * 把两段纯文档注释换成注入代码，并**原位更新**头部里这两个文件的
 * `integrity.hash`。归档总大小、头部长度都不变，其余所有条目逐字节未动。
 *
 *   lib/main.js          → 注册 6 条 IPC（quit / fullscreen / maximize / minimize / top / state）
 *   lib/preload-app.cjs  → 向页面暴露 window.dshWindowControl
 *
 * ## 为什么是「就地替换」而不是「重写归档」
 *
 * 实测结论（本机 Windows + 运行中的 DSH）：
 *   open(asar, 'r+')   → 成功，可以原地写
 *   rename(asar, ...)  → EBUSY，Electron 持有句柄，换不掉
 * 等长替换天然只需要原地覆盖，不需要 rename，因此在 DSH 运行期间也能安全落盘
 * （改动范围仅几百字节，且改的是启动期已加载完毕的两个文件）。落盘后**需要
 * 重启 DSH** 才会生效。
 *
 * ## 幂等与回滚
 *
 * 首次安装会把原归档复制一份到 `app.asar.orig`；重复调用是 no-op；`restore()`
 * 从备份写回。注入前会做完整自检（还原归档后用官方同一套算法逐条目复算
 * sha256，并要求除目标文件外其余条目逐字节一致），自检不通过绝不动线上文件。
 *
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * 选一个「能真正读写 asar 文件本身」的 fs 实现。
 *
 * Electron 在 Node 模式下会 patch `fs`：任何以 `.asar` 结尾的路径都会被当成**归档内部**
 * 路径来解析，于是对归档文件本身的操作全部失效 —— 实测：
 *
 *   fs.existsSync('…/app.asar')  -> true      （误导性：看起来文件在）
 *   fs.openSync('…/app.asar','r')-> ENOENT: not found in …/app.asar
 *   fs.statSync('…/app.asar')    -> size 0, isFile false
 *
 * 这个 patch 让宿主进程（它正是 ELECTRON_RUN_AS_NODE 模式）没法直接读写 app.asar。
 * Electron 另外附带了一个未被 patch 的同名模块 `original-fs`，正好绕开拦截；纯 Node
 * 环境下没有这个模块，回退到 `node:fs`（那时本来就没有 patch）。
 */
const require = createRequire(import.meta.url)
let fs = nodeFs
let fsSource = 'node:fs'
try {
  fs = require('original-fs')
  fsSource = 'original-fs'
} catch {
  fs = nodeFs
}

export { fs, fsSource }

/** asar 里需要改写的两个条目（键带前导斜杠，与归档头部的路径形式一致）。 */
export const TARGETS = {
  main: '/lib/main.js',
  preload: '/lib/preload-app.cjs',
}

/**
 * 幂等标记：命中说明该条目已经打过桥。
 *
 * 这里必须是**所有版本都存在**的串，而不是某个版本的特征串 —— 否则新版桥装上之后
 * 反而检测不出「已安装」，升级逻辑也就无从触发。`const DWC=[` 从 v2 起一直保留。
 */
export const MARKS = {
  /*
   * 只取 `DWC=[[` 这一段：`const` 后面可能还挂着别的声明（当前是 `const P=…,DWC=[[`），
   * 写全了反而匹配不上。
   */
  main: 'DWC=[[',
  preload: 'dshWindowControl',
}

/**
 * 本版插件要装上去的桥版本。
 *
 * 注入块是**等长替换**，改过一次之后锚点注释就没了，无法原地把旧代码换成新代码 ——
 * 所以升级只能「先还原成原版，再重新注入」。`install()` 拿它跟归档里的实际版本比，
 * 落后就自动走这条路；不看版本的话，已装旧桥的机器会永远停在旧版本。
 */
export const BRIDGE_VERSION = 3

/**
 * 替换锚点：两段等价于「纯文档」的 JSDoc。
 * 选它们是因为足够长（1000 / 504 字节）且语义上没有任何运行时作用，
 * 被整段换掉不影响原模块行为。
 */
export const ANCHORS = {
  main: '/**\n* Replace `filename` with `content` in one atomic step',
  preload: '/**\n* Watches `html[data-ds-theme-source]`',
}

/**
 * 注入代码依赖的宿主符号 —— 注入前必须逐个确认存在。
 *
 * 注入块是**等长替换**，一旦把代码塞进一个符号已经改名的模块，后果不是「功能失灵」
 * 而是**主进程直接抛异常、DSH 起不来**。所以这里做一次廉价的前置校验：符号不全就
 * 中止安装并说明原因，让插件退化成「无桥」而不是把编辑器搞坏。
 */
export const REQUIRED_SYMBOLS = {
  main: ['ipcMain', 'BrowserWindow', 'dialog', 'assertDesktopSender', 'skipQuitConfirmation', 'app.quit'],
  preload: ['contextBridge', 'ipcRenderer'],
}

/**
 * 注入代码。必须保持 ASCII 且长度不超过对应替换块，
 * 末尾用空格补齐到原块长度（等长约束）。
 */
export const CODE = {
  main:
    /*
     * 通道名统一走 `P + 后缀`：等长替换的字节预算很紧（主进程块 1000 字节），
     * 4 条通道写成完整字符串时 6 条就放不下了。
     */
    'const P="dsh-desktop:",DWC=[[P+"app-quit",async(w,o={})=>{const r=await dialog.showMessageBox(w,o);' +
    'if(r.response)return false;try{skipQuitConfirmation=true}catch(e){}app.quit();return true}],' +
    '[P+"window-fullscreen-set",(w,v)=>{w.setFullScreen(!!v);return w.isFullScreen()}],' +
    '[P+"window-maximize",(w,v)=>{if(v)w.maximize();else w.unmaximize();return w.isMaximized()}],' +
    '[P+"window-minimize",(w,v)=>{if(v)w.minimize();else w.restore();return w.isMinimized()}],' +
    '[P+"window-top",(w,v)=>{w.setAlwaysOnTop(!!v);return w.isAlwaysOnTop()}],' +
    '[P+"window-state",w=>({fullscreen:w.isFullScreen(),maximized:w.isMaximized(),' +
    'minimized:w.isMinimized(),top:w.isAlwaysOnTop()})]];' +
    'for(const[k,fn]of DWC){ipcMain.removeHandler(k);' +
    'ipcMain.handle(k,(e,v)=>{assertDesktopSender(e,["app"]);' +
    'if(e.senderFrame!==e.sender.mainFrame)throw new Error("dwc: sender");' +
    'const w=BrowserWindow.fromWebContents(e.sender);' +
    'if(w===null||w.isDestroyed())throw new Error("dwc: nowin");' +
    'return fn(w,v)})}',
  preload:
    'if(location.protocol==="dsh-app:"&&location.hostname==="app"&&process.isMainFrame){' +
    'const V=(k,v)=>electron.ipcRenderer.invoke(k,v),P="dsh-desktop:";' +
    'electron.contextBridge.exposeInMainWorld("dshWindowControl",{v:3,' +
    'setFullscreen:x=>V(P+"window-fullscreen-set",x),' +
    'setMaximized:x=>V(P+"window-maximize",x),' +
    'setMinimized:x=>V(P+"window-minimize",x),' +
    'setTop:x=>V(P+"window-top",x),' +
    'state:()=>V(P+"window-state"),' +
    'quit:o=>V(P+"app-quit",o)});}',
}

/** 备份文件名后缀。 */
export const BACKUP_SUFFIX = '.orig'

/** asar 头部固定长度（pickle 头 + JSON 长度字段）。 */
const HEADER_FIXED = 16

// --------------------------------------------------------------------------- //
// 定位
// --------------------------------------------------------------------------- //

/**
 * 推导 app.asar 的候选路径。
 *
 * 宿主子进程是被这样拉起来的：
 *   spawn(electronExe, [entry, runtimeDir, projectDir, ...])
 * 其中 `runtimeDir` 是 `<resources>/app.asar/dsh`（官方 `runtimeArchivePath()`
 * 就是靠 `basename(dirname(runtimeDir)) === "app.asar"` 判断的）。所以
 * `dirname(argv[2])` 直接就是 asar 路径，不需要猜任何用户名或安装位置。
 *
 * 备选路径依次是：从 execPath 推 `resources/app.asar`、以及 macOS / Linux 的
 * 常见布局。
 *
 * @param options - `{ explicit, argv, execPath }`；`argv` 与 `execPath` 缺省分别取
 *   `process.argv` 与 `process.execPath`。
 * @returns 去重后的候选路径数组。
 */
export function candidates(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv
  const execPath = options.execPath === undefined ? process.execPath : options.execPath
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
  }

  push(options.explicit)
  push(process.env.DSH_ASAR)

  const runtimeDir = argv[2]
  if (typeof runtimeDir === 'string' && runtimeDir.length > 0) {
    /*
     * runtimeDir 的实际形态随打包方式而变：可能是 `<res>/app.asar/dsh`，
     * 也可能是 `<res>/app.asar.unpacked/dsh`（dsh-desktop-host 带原生依赖 koffi，
     * 会被 Electron 解包）。所以不猜某一层，直接从它逐级向上找同名归档。
     */
    let dir = runtimeDir
    for (let level = 0; level < 5; level += 1) {
      if (typeof dir !== 'string' || dir.length === 0) break
      push(path.join(dir, 'app.asar'))
      if (path.basename(dir) === 'app.asar') push(dir)
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }

  if (typeof execPath === 'string' && execPath.length > 0) {
    const root = path.dirname(execPath)
    push(path.join(root, 'resources', 'app.asar'))
    push(path.join(root, 'app.asar'))
    push(path.join(root, '..', 'Resources', 'app.asar'))
  }

  const home = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && typeof home === 'string') {
    push(path.join(home, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (process.platform === 'win32' && typeof base === 'string') {
      push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
    }
  }
  if (process.platform === 'darwin') {
    push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
    const macHome = process.env.HOME
    if (typeof macHome === 'string') {
      push(path.join(macHome, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'))
    }
  }
  if (process.platform === 'linux') {
    /*
     * Linux 没有统一安装位置（发行版打包 / AppImage / 解压即用各不相同），这里只放
     * 兜底候选。真正靠得住的是上面的 execPath 分支：宿主进程由 DSH 自己的可执行
     * 文件拉起，execPath 就是安装目录里的那个文件，因此自定义路径同样能定位到。
     */
    push('/opt/DeepSeek Harness/resources/app.asar')
    push('/opt/deepseek-harness/resources/app.asar')
    push('/usr/lib/deepseek-harness/resources/app.asar')
    push('/usr/share/deepseek-harness/resources/app.asar')
    const linuxHome = process.env.HOME
    if (typeof linuxHome === 'string') {
      push(path.join(linuxHome, '.local', 'share', 'DeepSeek Harness', 'resources', 'app.asar'))
      push(path.join(linuxHome, 'Applications', 'DeepSeek Harness', 'resources', 'app.asar'))
    }
  }

  return out
}

/**
 * 找到第一个「存在且能解析出归档头部」的 asar。
 *
 * @param options - `{ explicit, argv, execPath }`，含义同 {@link candidates}。
 * @returns `{ archive }`；全部候选都不可用时返回 null。
 */
export function locate(options = {}) {
  for (const archive of candidates(options)) {
    try {
      const fd = fs.openSync(archive, 'r')
      try {
        const head = Buffer.alloc(HEADER_FIXED)
        fs.readSync(fd, head, 0, HEADER_FIXED, 0)
        parseHeader(head)
      } finally {
        fs.closeSync(fd)
      }
      return { archive }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

// --------------------------------------------------------------------------- //
// asar 读取
// --------------------------------------------------------------------------- //

/**
 * 解析 asar 头部。
 *
 * 布局：`[0,16)` 固定头（`[12,16)` 小端 = JSON 长度），紧随其后是 JSON，
 * JSON 之后可能还有对齐用的填充，所以取到最后一个 `}` 为止再解析。
 *
 * @param raw - 归档文件的前 16 字节（或更多）。
 * @returns `{ jsonLength, dataStart }`。
 */
export function parseHeader(raw) {
  if (raw.length < HEADER_FIXED) throw new Error('asar: 文件小于头部长度')
  const jsonLength = raw.readUInt32LE(12)
  if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) {
    throw new Error('asar: 头部长度异常 (' + String(jsonLength) + ')')
  }
  return { jsonLength, dataStart: HEADER_FIXED + jsonLength }
}

/**
 * 解析头部 JSON 文本。
 *
 * @param text - 头部字节按 UTF-8 解码后的文本（可能带尾部填充）。
 * @returns 头部对象。
 */
export function parseHeaderJson(text) {
  const end = text.lastIndexOf('}')
  if (end < 0) throw new Error('asar: 头部 JSON 不完整')
  return JSON.parse(text.slice(0, end + 1))
}

/**
 * 把归档头部的文件树摊平成 `路径 -> 条目` 映射。
 *
 * @param header - 头部对象。
 * @returns Map，键形如 `/lib/main.js`。
 */
export function walkEntries(header) {
  const map = new Map()
  const visit = (node, prefix) => {
    const files = node && node.files
    if (!files) return
    for (const name of Object.keys(files)) {
      const meta = files[name]
      const full = prefix + '/' + name
      if (meta && meta.files) visit(meta, full)
      else if (meta) map.set(full, meta)
    }
  }
  visit(header, '')
  return map
}

/**
 * 读取归档的**头部**并解析出目录树（**不读数据区**）。
 *
 * 归档总量 115.7 MB，而头部 JSON 只有 3.4 MB、我们真正要改的两个条目不到 1 MB。
 * 早先的实现是 `readFileSync` 整个归档，于是每次 DSH 启动的自检都要付一次
 * 115 MB 的磁盘读 + 一次同样大小的内存分配（实测 93 ms / 峰值 ~120 MB）。
 * 现在只读 `[0, 16 + jsonLength)` 这一段，条目字节由 {@link entryBuffer} 按需定向读取，
 * 实测降到 ~25 ms / ~4 MB。
 *
 * @param archive - app.asar 路径。
 * @returns `{ archive, header, jsonLength, dataStart, headBuffer, entries }`。
 */
export function readArchive(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const head = Buffer.alloc(HEADER_FIXED)
    if (fs.readSync(fd, head, 0, HEADER_FIXED, 0) !== HEADER_FIXED) {
      throw new Error('asar: 文件小于头部长度')
    }
    const { jsonLength, dataStart } = parseHeader(head)
    const headBuffer = Buffer.alloc(jsonLength)
    let got = 0
    while (got < jsonLength) {
      const read = fs.readSync(fd, headBuffer, got, jsonLength - got, HEADER_FIXED + got)
      if (read <= 0) break
      got += read
    }
    if (got !== jsonLength) {
      throw new Error('asar: 头部 JSON 读取不完整 (' + String(got) + '/' + String(jsonLength) + ')')
    }
    const header = parseHeaderJson(headBuffer.toString('utf8'))
    return { archive, header, jsonLength, dataStart, headBuffer, entries: walkEntries(header) }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 定向读取**单个条目**的字节。
 *
 * 只读磁盘上该条目那一段（`dataStart + offset` 起 `size` 字节），不碰归档其余部分。
 *
 * @param loaded - {@link readArchive} 的返回值（或任何带 `archive` / `dataStart` 的对象）。
 * @param meta - 条目元数据。
 * @returns 该条目的 Buffer。
 */
export function entryBuffer(loaded, meta) {
  const offset = Number(meta.offset)
  const size = Number(meta.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0) {
    throw new Error('asar: 条目元数据异常')
  }
  const absolute = loaded.dataStart + offset
  const buffer = Buffer.alloc(size)
  if (size === 0) return buffer
  const fd = fs.openSync(loaded.archive, 'r')
  try {
    let got = 0
    while (got < size) {
      const read = fs.readSync(fd, buffer, got, size - got, absolute + got)
      if (read <= 0) break
      got += read
    }
    if (got !== size) {
      throw new Error('asar: 条目读取不完整 (' + String(got) + '/' + String(size) + ')')
    }
  } finally {
    fs.closeSync(fd)
  }
  return buffer
}

/**
 * 分块计算**整个文件**的 sha256（不在内存里放整份内容）。
 *
 * 用于比对 115 MB 级的归档与其备份 —— 早先用 `readFileSync` 会把两份各 115 MB
 * 的内容同时读进内存。
 *
 * @param file - 文件路径。
 * @returns 小写十六进制摘要。
 */
export function fileSha256(file) {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  const fd = fs.openSync(file, 'r')
  try {
    let at = 0
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, at)
      if (read <= 0) break
      hash.update(chunk.subarray(0, read))
      at += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * 用官方同一套算法复算单个条目内容的 sha256。
 *
 * @param blob - 条目字节。
 * @returns 小写十六进制摘要。
 */
export function sha256(blob) {
  return createHash('sha256').update(blob).digest('hex')
}

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //

/**
 * 读取归档当前的桥状态。
 *
 * @param archive - app.asar 路径。
 * @returns 状态对象；读取失败时 `ok: false` 并带 `error`。
 */
export function status(archive) {
  const backup = backupPath(archive)
  const result = {
    ok: false,
    archive,
    backup,
    backupExists: fs.existsSync(backup),
    installed: false,
    version: 0,
    entryCount: 0,
    error: null,
  }
  try {
    const loaded = readArchive(archive)
    result.entryCount = loaded.entries.size
    const main = loaded.entries.get(TARGETS.main)
    const preload = loaded.entries.get(TARGETS.preload)
    const mainText = main ? entryBuffer(loaded, main).toString('utf8') : ''
    const preloadText = preload ? entryBuffer(loaded, preload).toString('utf8') : ''
    const bridge = mainText.includes(MARKS.main) && preloadText.includes(MARKS.preload)
    result.installed = bridge
    if (bridge) {
      /*
       * 版本直接读 preload 里暴露的 `v:N`（那本来就是给渲染端看的），
       * 比在主进程代码里找特征串稳得多 —— 特征串会随压缩重构而消失。
       */
      result.version = readBridgeVersion(preloadText)
    }
    result.targetVersion = BRIDGE_VERSION
    result.upgradable = bridge && result.version < BRIDGE_VERSION
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}

/**
 * 从 preload 文本里读出已装桥的版本号。
 *
 * 读不到就当成 1（最早那版，只认 `{v:2` / `{v:3` 这种显式写法之前的产物）。
 *
 * @param preloadText - preload 条目正文。
 * @returns 版本号（>=1）。
 */
function readBridgeVersion(preloadText) {
  const hit = /\{v:(\d+)/.exec(preloadText)
  if (!hit) return 1
  const value = Number(hit[1])
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * 备份文件路径。
 *
 * @param archive - app.asar 路径。
 * @returns 备份路径。
 */
export function backupPath(archive) {
  return archive + BACKUP_SUFFIX
}

/** 并发锁文件名后缀。 */
export const LOCK_SUFFIX = '.dwc.lock'

/** 锁的过期时间：超过这个时长仍未释放，就认为持有者已经崩了。 */
const LOCK_STALE_MS = 30 * 1000

/**
 * 锁文件路径。
 *
 * @param archive - app.asar 路径。
 * @returns 锁文件路径。
 */
export function lockPath(archive) {
  return archive + LOCK_SUFFIX
}

/**
 * 在归档上取一把跨进程排它锁。
 *
 * 宿主半边每次 DSH 启动都会跑一次；如果用户开了两个 DSH 实例（或者一个刚启动、
 * 另一个正在退出），两边可能同时进入「备份 → 构建 → 写盘」。写盘本身是等长覆盖、
 * 幂等，但并发下**备份可能被对方刚写过的归档覆盖**，那就把「可回滚」这个前提弄丢了。
 * 因此改动归档的入口统一先抢锁，抢不到就干净退出，下次启动再来。
 *
 * 锁用 `wx` 打开（O_EXCL）保证原子性；持有者崩溃留下的陈旧锁按 mtime 过期回收。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ staleMs }` 覆盖过期时间（测试用）。
 * @returns `{ ok, file, error }`。
 */
export function acquireLock(archive, options = {}) {
  const file = lockPath(archive)
  const now = Date.now()
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : LOCK_STALE_MS
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }))
      } finally {
        fs.closeSync(fd)
      }
      return { ok: true, file, error: null }
    } catch (error) {
      if (!fs.existsSync(file)) {
        return { ok: false, file, error: '无法创建锁文件: ' + (error instanceof Error ? error.message : String(error)) }
      }
      let age = Infinity
      try {
        age = now - fs.statSync(file).mtimeMs
      } catch {
        /* 读不到就当作陈旧 */
      }
      if (attempt === 0 && age > staleMs) {
        try {
          fs.unlinkSync(file)
        } catch {
          /* 对方刚好释放了，下一轮会成功 */
        }
        continue
      }
      return {
        ok: false,
        file,
        error: '另一个进程正在改写归档（锁已存在约 ' + String(Math.round(age / 1000)) + ' 秒），本次跳过',
      }
    }
  }
  return { ok: false, file, error: '无法获取归档锁' }
}

/**
 * 释放 {@link acquireLock} 取得的锁（传 null 时什么都不做）。
 *
 * @param handle - acquireLock 的返回值。
 */
export function releaseLock(handle) {
  if (!handle || !handle.file) return
  try {
    fs.unlinkSync(handle.file)
  } catch {
    /* 已经不在了 */
  }
}

/**
 * 判断备份文件是否仍然是「当前这个归档」的原版副本。
 *
 * 备份只在第一次安装时产生，而 DSH 每次升级都会整体替换 `app.asar`。若继续沿用旧备份，
 * 回滚就会把**上一个版本**的代码盖回安装目录 —— 用新版的 exe 去跑旧版的资源，轻则行为
 * 错乱，重则直接起不来。所以在每次打桥之前都必须确认备份与当前归档是同一份东西。
 *
 * 不能用 mtime 判断：Electron 的 `original-fs` 在 Windows 上会**保留源文件的时间戳**，
 * 备份的 mtime 看上去还是解压那一刻的旧时间，完全不可靠。
 *
 * @param archive - 线上归档路径（调用方需保证它此刻**尚未**打过桥）。
 * @param backup - 备份路径。
 * @returns 备份存在且与归档逐字节一致时为 true。
 */
export function backupFresh(archive, backup) {
  try {
    if (!fs.existsSync(backup)) return false
    if (fs.statSync(archive).size !== fs.statSync(backup).size) return false
    /* 分块比对：两份 115 MB 的内容不会同时驻留内存。 */
    return fileSha256(archive) === fileSha256(backup)
  } catch {
    /* 读不动就当作不可用，让调用方重新备份 */
    return false
  }
}

/**
 * 落盘失败的兜底：用备份把归档还原回原版。
 *
 * 宁可让这一次安装失败，也不能把一个半写状态的 `app.asar` 留在安装目录里 —— 那会让
 * DSH 连启动都做不到。所有可能损坏归档的路径都必须经过这里。
 *
 * @param archive - 线上归档路径。
 * @param options - `{ lockHeld }`：调用方是否已经持有归档锁（避免自锁）。
 * @returns `{ ok, message }`。
 */
export function rollbackAfterFailure(archive, options = {}) {
  try {
    /*
     * 必须带 force：失败之后归档可能停在半写状态，`status()` 未必还认得出「打过桥」，
     * 而 restore 在「未打过桥」时会拒绝执行 —— 那正是最需要它的时候。
     */
    const rolled = restore(archive, { force: true, lockHeld: options.lockHeld === true })
    return { ok: rolled.ok, message: rolled.message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// --------------------------------------------------------------------------- //
// 构建
// --------------------------------------------------------------------------- //

/**
 * 把锚点定位到的那段块注释等长替换成 `code` + 空格补齐。
 *
 * 注意偏移量全部按**字节**计算：`String.indexOf` 给的是 UTF-16 码元下标，
 * 而 asar 里的 offset 是字节，两者在出现非 ASCII 字符（源码里的中文注释）
 * 之后就会错位。所以这里用 `Buffer.byteLength` 把字符下标换算成字节偏移。
 *
 * @param source - 条目原文（UTF-8 解码）。
 * @param anchor - 锚点字符串。
 * @param code - 注入代码（必须是纯 ASCII，否则等长约束无法保证）。
 * @param label - 出错时的提示名。
 * @returns `{ text, byteStart, byteLength, padding, codeLength }`。
 */
export function replaceAnchor(source, anchor, code, label) {
  if (Buffer.byteLength(code, 'utf8') !== code.length) {
    throw new Error(label + ': 注入代码含非 ASCII 字符，无法等长替换')
  }
  const first = source.indexOf(anchor)
  if (first < 0) throw new Error(label + ': 找不到注入锚点（DSH 版本可能已变化）')
  if (source.indexOf(anchor, first + 1) >= 0) throw new Error(label + ': 注入锚点出现多次')
  const close = source.indexOf('*/', first)
  if (close < 0) throw new Error(label + ': 注入锚点所在注释未闭合')
  const end = close + 2

  const byteStart = Buffer.byteLength(source.slice(0, first), 'utf8')
  const byteLength = Buffer.byteLength(source.slice(first, end), 'utf8')
  if (byteLength < code.length) {
    throw new Error(label + ': 可替换块 ' + String(byteLength) + ' 字节放不下 ' + String(code.length) + ' 字节')
  }
  const padding = byteLength - code.length
  const payload = code + ' '.repeat(padding)
  return {
    text: source.slice(0, first) + payload + source.slice(end),
    byteStart,
    byteLength,
    padding,
    codeLength: code.length,
  }
}

/**
 * 在 Buffer 上原地替换同长度的 ASCII 子串（用于改头部哈希，避免解码整个头部）。
 *
 * @param buffer - 目标缓冲。
 * @param from - 被替换的 ASCII 串。
 * @param to - 新的 ASCII 串（长度必须一致）。
 * @returns 命中次数。
 */
export function replaceAsciiInPlace(buffer, from, to) {
  if (from.length !== to.length) throw new Error('replaceAscii: 长度不一致')
  let index = 0
  let hits = 0
  for (;;) {
    const at = buffer.indexOf(from, index)
    if (at < 0) break
    buffer.write(to, at, 'ascii')
    index = at + to.length
    hits += 1
  }
  return hits
}

/**
 * 数一个 ASCII 子串在 Buffer 里出现了几次。
 *
 * @param buffer - 目标缓冲。
 * @param needle - 要数的子串。
 * @returns 次数。
 */
function countInBuffer(buffer, needle) {
  if (needle.length === 0) return 0
  let index = 0
  let hits = 0
  for (;;) {
    const at = buffer.indexOf(needle, index)
    if (at < 0) break
    hits += 1
    index = at + needle.length
  }
  return hits
}

/**
 * 把头部里**本条目自己的**那两个哈希换成新值。
 *
 * 常见情况旧哈希在头部只出现两次（`integrity.hash` 与 `integrity.blocks[0]`），
 * 全局等长替换即可。但归档里如果存在**内容完全相同的另一个条目**（sha256 一样），
 * 旧哈希会出现 4 次 —— 全局替换会把那个条目的完整性一并改坏。
 * 这时改用本条目自己的 `offset`（唯一）做锚点，只改它之后最近的两次：
 * 本条目 meta 里的 integrity 就排在那儿。
 *
 * 键序假如与预期不符，替换会落在错误位置 —— 但那不是静默损坏：`verify()` 会按离线
 * 重算的 sha256 发现对不上，安装直接失败且不动线上文件。
 *
 * @param headBuffer - 头部缓冲（会被就地修改）。
 * @param oldHex - 旧哈希（64 位十六进制）。
 * @param newHex - 新哈希（与旧哈希等长）。
 * @param meta - 本条目在头部里的元数据（用它的 `offset` 做锚点）。
 * @returns `{ mode, hits }`：`plain` 全局两处 / `offset` 按 offset 定位。
 */
export function patchHeaderHash(headBuffer, oldHex, newHex, meta) {
  if (oldHex.length !== newHex.length) throw new Error('头部哈希长度不一致')

  const total = countInBuffer(headBuffer, oldHex)
  if (total === 2) {
    replaceAsciiInPlace(headBuffer, oldHex, newHex)
    return { mode: 'plain', hits: total }
  }

  const offset = meta && meta.offset !== undefined ? String(meta.offset) : ''
  const anchors = ['"offset":"' + offset + '"', '"offset":' + offset]
  for (const anchor of anchors) {
    if (offset.length === 0) break
    const needle = Buffer.from(anchor, 'utf8')
    if (countInBuffer(headBuffer, needle) !== 1) continue
    const at = headBuffer.indexOf(needle)
    const first = headBuffer.indexOf(oldHex, at)
    if (first < 0) continue
    const second = headBuffer.indexOf(oldHex, first + oldHex.length)
    if (second < 0) continue
    headBuffer.write(newHex, first, 'ascii')
    headBuffer.write(newHex, second, 'ascii')
    return { mode: 'offset', hits: total }
  }

  throw new Error('头部哈希命中 ' + String(total) + ' 次，且无法用 offset 定位本条目（期望 2 次）')
}

/**
 * 构建补丁：返回需要写入的字节区间，以及自检报告。
 *
 * 只算出「变化的三个区间」（头部、main 的替换块、preload 的替换块），
 * 不复制整个 121MB 归档。
 *
 * @param archive - app.asar 路径。
 * @returns `{ ok, archive, writes, report }`；失败时 `ok: false` 且 `error` 有说明。
 */
export function build(archive) {
  const report = { blocks: [], checked: false, notes: [] }
  try {
    const loaded = readArchive(archive)
    const headBuffer = Buffer.from(loaded.headBuffer)
    const writes = []

    for (const key of ['main', 'preload']) {
      const target = TARGETS[key]
      const meta = loaded.entries.get(target)
      if (!meta) throw new Error(target + ': 归档中不存在该条目')

      const size = Number(meta.size)
      const offset = Number(meta.offset)
      const absolute = loaded.dataStart + offset
      const bytes = entryBuffer(loaded, meta)
      if (bytes.includes(Buffer.from(MARKS[key], 'utf8'))) {
        throw new Error(target + ': 已经打过桥补丁')
      }

      const source = bytes.toString('utf8')
      /* 符号预检：缺任何一个都说明 DSH 换了实现，宁可中止也不要瞎注入。 */
      for (const symbol of REQUIRED_SYMBOLS[key]) {
        if (!source.includes(symbol)) {
          throw new Error(target + ': 缺少注入所需符号 `' + symbol + '`（DSH 版本可能已变化）')
        }
      }
      const anchored = replaceAnchor(source, ANCHORS[key], CODE[key], target)
      const patched = Buffer.from(anchored.text, 'utf8')
      if (patched.length !== size) {
        throw new Error(target + ': 替换后长度变化 ' + String(size) + ' -> ' + String(patched.length))
      }

      const newHex = sha256(patched)
      const integrity = meta.integrity
      /*
       * 完整性块是可选结构：官方归档现在都带它，但没有的时候不该直接拒装 ——
       * 没有块就没有要比对的哈希，DSH 读文件时也不会去校验。
       */
      let oldHex = null
      let hashMode = 'none'
      if (integrity !== undefined && integrity !== null) {
        if (
          integrity.algorithm !== 'SHA256' ||
          !Array.isArray(integrity.blocks) ||
          integrity.blocks.length !== 1 ||
          typeof integrity.hash !== 'string'
        ) {
          throw new Error(target + ': 完整性结构不是预期的单块 SHA256')
        }
        oldHex = integrity.hash
        if (oldHex !== integrity.blocks[0] || oldHex.length !== 64) {
          throw new Error(target + ': 头部哈希结构异常')
        }
        hashMode = patchHeaderHash(headBuffer, oldHex, newHex, meta).mode
      }

      writes.push({
        label: target,
        fileOffset: absolute + anchored.byteStart,
        buffer: patched.subarray(anchored.byteStart, anchored.byteStart + anchored.byteLength),
      })
      report.blocks.push({
        target,
        blockLength: anchored.byteLength,
        codeLength: anchored.codeLength,
        padding: anchored.padding,
        hashMode,
        oldHash: oldHex,
        newHash: newHex,
      })
    }

    writes.unshift({ label: 'header', fileOffset: HEADER_FIXED, buffer: headBuffer })

    return { ok: true, archive, writes, headBuffer, jsonLength: loaded.jsonLength, report }
  } catch (error) {
    return { ok: false, archive, error: error instanceof Error ? error.message : String(error), report }
  }
}

/**
 * 模拟应用补丁后的归档内容，用于在真正写盘前做完整自检。
 *
 * 只复制到内存里的小范围（头部 + 两个目标条目），不复制整个归档。
 *
 * @param archive - app.asar 路径。
 * @param built - build() 的返回值。
 * @returns `{ ok, error }`。
 */
export function verify(archive, built) {
  if (!built || !built.ok) return { ok: false, error: built ? built.error : 'build 未成功' }
  try {
    const loaded = readArchive(archive)
    const notes = []
    const heads = loaded.entries

    /* 按写入区间把目标条目重建一遍，用官方同一套算法复算 sha256 对账。 */
    for (const block of built.report.blocks) {
      const meta = heads.get(block.target)
      const size = Number(meta.size)
      const absolute = loaded.dataStart + Number(meta.offset)
      const original = entryBuffer(loaded, meta)
      const write = built.writes.find((w) => w.label === block.target)
      const localOffset = write.fileOffset - absolute
      write.buffer.copy(original, localOffset)
      if (block.hashMode === 'none') {
        notes.push(block.target + ' 无完整性块，跳过哈希校验（' + String(size) + ' 字节）')
        continue
      }
      const digest = sha256(original)
      if (digest !== block.newHash) {
        return { ok: false, error: block.target + ': 补丁后哈希与头部记录不一致' }
      }
      notes.push(block.target + ' 哈希自洽（' + String(size) + ' 字节）')
    }

    /* 头部长度必须不变，且新哈希已经写进头部文本。 */
    const headText = built.headBuffer.toString('utf8')
    if (built.headBuffer.length !== loaded.jsonLength) {
      return { ok: false, error: '头部长度变化 (' + String(loaded.jsonLength) + ' -> ' + String(built.headBuffer.length) + ')' }
    }
    for (const block of built.report.blocks) {
      if (block.hashMode === 'none') continue
      if (!headText.includes(block.newHash)) {
        return { ok: false, error: block.target + ': 新哈希未写入头部' }
      }
      /*
       * 只有「全局两处」模式才要求旧哈希彻底消失：`offset` 定位模式下，归档里
       * 那个内容完全相同的别的条目理应继续持有旧哈希，那是正确的。
       */
      if (block.hashMode === 'plain' && headText.includes(block.oldHash)) {
        return { ok: false, error: block.target + ': 旧哈希残留在头部' }
      }
    }

    /* 除目标条目外，其余条目必须逐字节未动 —— 我们本来就没写它们，这里只做条数核对。 */
    notes.push('其余 ' + String(heads.size - built.report.blocks.length) + ' 个条目不参与改动')
    return { ok: true, notes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// --------------------------------------------------------------------------- //
// 安装 / 回滚
// --------------------------------------------------------------------------- //

/*
 * 不可能属于「DSH 本体」的进程名：从 `process.execPath` 推名字时，命令行环境
 * （node / electron）会把它们带进来，认出来只会把「DSH 没开」误判成「开着」。
 */
const IGNORED_PROCESS_NAMES = new Set(['node', 'electron', 'bun', 'deno'])

/**
 * 列出「DSH 可能在跑的进程名」。
 *
 * 早先只认硬编码的 `DeepSeek Harness.exe`：便携版 / 改了名的构建会一律被当成
 * 「未运行」，于是走整档 rename，运行中 rename 会 EBUSY，白白回滚一次。
 * 这里改为从三个来源推测，任何一个命中就算在跑。
 *
 * @param archive - app.asar 路径（用来推安装目录名）。
 * @returns 去重后的进程名（不带 .exe）。
 */
function processNames(archive) {
  const names = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const name = value.trim()
    if (name.length === 0) return
    if (IGNORED_PROCESS_NAMES.has(name.toLowerCase())) return
    /* 归档固定住在 `<安装目录>/resources/app.asar`，倒推两层就是安装目录名。 */
    const lowered = name.toLowerCase()
    if (lowered === 'resources' || lowered === 'app') return
    if (!names.some((item) => item.toLowerCase() === lowered)) names.push(name)
  }

  try {
    if (typeof archive === 'string' && archive.length > 0) {
      push(path.basename(path.dirname(path.dirname(archive))))
    }
  } catch {
    /* 路径推不出来就算了，后面的兜底还够用 */
  }

  try {
    const execPath = process.execPath || ''
    push(path.basename(execPath, path.extname(execPath)))
  } catch {
    /* ignore */
  }

  /* 官方名字总是最后保底：改名 / 便携版也不至于完全认不出来。 */
  push('DeepSeek Harness')
  return names
}

/**
 * 判断 DSH 是否正在运行（Win32 用 tasklist，其它平台用 ps）。
 *
 * @param archive - app.asar 路径；用来推测进程名，省略时只靠官方名字与 execPath。
 * @returns 布尔值；检测失败时返回 true（保守：当作正在运行）。
 */
export function isRunning(archive = '') {
  const names = processNames(archive)
  try {
    if (process.platform === 'win32') {
      for (const name of names) {
        const image = name + '.exe'
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH'], {
          encoding: 'utf8',
          windowsHide: true,
        })
        if (out.toLowerCase().includes(image.toLowerCase())) return true
      }
      return false
    }
    /*
     * 用 `args` 而不是 `comm`：`comm` 在多数 Unix 上被截断到 15 个字符，`DeepSeek Harness`
     * 正好 16 个字符，截断后永远匹配不上，会误判成「未运行」—— 后果是走整文件 rename
     * 那条路，而运行中 rename 会 EBUSY。命令行不做截断。
     */
    const out = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    return names.some((name) => {
      /* 名字里的空格在命令行里可能写成下划线或连字符，统一放宽一位。 */
      const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '[ _-]?')
      return new RegExp(pattern, 'i').test(out)
    })
  } catch {
    /* 检测不了就按「正在运行」处理：就地覆盖比整文件替换更保守。 */
    return true
  }
}

/**
 * 探测归档是否可写。
 *
 * 写入发生在 DSH 的安装目录里，而系统级安装（`C:\Program Files`、`/opt`）通常要求
 * 提权。先探一次，好在动手之前就把「权限不够」讲清楚，而不是等所有构建与自检做完
 * 才抛出一个没人看得懂的 `EACCES`。
 *
 * @param archive - app.asar 路径。
 * @returns `{ ok, code, message }`；`ok` 为 false 时 `message` 是可直接展示的说明。
 */
export function writable(archive) {
  try {
    const fd = fs.openSync(archive, 'r+')
    fs.closeSync(fd)
    return { ok: true }
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    return { ok: false, code, message: permissionHint(code, archive) }
  }
}

/**
 * 把权限类错误翻译成人话，并给出下一步该做什么。
 *
 * @param code - Node 的错误码（可能为空）。
 * @param archive - app.asar 路径。
 * @returns 说明文本。
 */
function permissionHint(code, archive) {
  const denied = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
  const detail = code ? '（' + code + '）' : ''
  if (!denied) {
    return '无法写入 ' + archive + detail + '：' + (code || '未知原因')
  }
  if (process.platform === 'win32') {
    return (
      '没有写入权限' + detail + '，' + archive + ' 位于需要提权的位置（通常是装到了 ' +
      'Program Files）。请选一种：① 以管理员身份运行一次 DeepSeek Harness，让插件把' +
      '窗口通道装好，之后日常使用不需要再提权；② 把 DeepSeek Harness 重新安装到用户' +
      '目录（默认安装位置即可）；③ 若企业策略禁止修改安装目录，可在 profile 的 ' +
      'cordis.patch.yml 里给本插件加 config: { autoInstall: false }。'
    )
  }
  return (
    '没有写入权限' + detail + '，无法修改 ' + archive +
    '。请以对该目录有写权限的用户运行 DeepSeek Harness（例如改用用户目录下的安装，' +
    '或用 sudo 运行一次），或在 profile 的 cordis.patch.yml 里给本插件加 ' +
    'config: { autoInstall: false } 关闭自动安装。'
  )
}

/**
 * 安装桥补丁。
 *
 * 步骤：备份（必要时刷新）→ 构建 → 自检 → 落盘 → 复验；任何一步出问题都不会把损坏的
 * 归档留在安装目录里。
 *
 * `force` 的实现方式是**先还原再重打**：等长替换已经把那两段锚点注释整段吃掉了，
 * 原地无法二次注入，所以没有别的路可走。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ force }`：已安装时是否强制重打（默认 false）。
 * @returns 结果对象 `{ ok, changed, running, rolledBack, report, message }`。
 */
export function install(archive, options = {}) {
  const locked =
    options.lockHeld === true ? { ok: true, file: null, error: null } : acquireLock(archive)
  if (!locked.ok) return { ok: false, changed: false, message: locked.error }
  try {
    return installHolding(archive, options)
  } finally {
    releaseLock(locked)
  }
}

/**
 * {@link install} 的主体（调用方已持有归档锁）。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ force }`。
 * @returns 结果对象。
 */
function installHolding(archive, options = {}) {
  const current = status(archive)
  if (!current.ok) return { ok: false, changed: false, message: '无法读取归档: ' + String(current.error) }

  let upgradedFrom = 0
  if (current.installed) {
    const stale = current.version < BRIDGE_VERSION
    if (!stale && !options.force) {
      return {
        ok: true,
        changed: false,
        version: current.version,
        message: '已经打过桥（v' + String(current.version) + '），无需重复安装',
      }
    }
    /*
     * 等长替换吃掉了锚点注释，没法原地把旧代码换成新代码 —— 升级只能「先还原成原版，
     * 再重新注入」。所以每次版本落后（或 --force）都必须先回滚一次。
     */
    const rolled = rollbackAfterFailure(archive, { lockHeld: true })
    if (!rolled.ok) {
      return {
        ok: false,
        changed: false,
        version: current.version,
        needRestore: true,
        message:
          (stale ? '升级到 v' + String(BRIDGE_VERSION) + ' 前需要先还原归档，但还原失败: ' : '强制重打前还原失败: ') +
          rolled.message +
          (stale
            ? '。当前仍是 v' + String(current.version) + '，新增的窗口功能暂不可用；' +
              '可执行 restore 手动还原后重试，缺少备份时则需重装 DeepSeek Harness。'
            : ''),
      }
    }
    upgradedFrom = current.version
  }

  /*
   * 确认写得进去再往下走。装在 Program Files / /opt 这类需要提权的位置时，
   * 提前把「权限不够」讲清楚，好过做完构建与自检才抛出一个没人看懂的 EACCES。
   */
  const probe = writable(archive)
  if (!probe.ok) {
    return { ok: false, changed: false, permission: true, message: probe.message }
  }

  /*
   * 先构建 + 自检，**再**备份。两个原因：
   *   1. build/verify 全程只读，失败时不该在安装目录里留下任何东西 ——
   *      早先的顺序是「先备份后构建」，于是 DSH 版本一变导致构建失败时，
   *      用户会白得一个 115 MB 的 .orig。
   *   2. 备份必须对得上「当前这个归档」：DSH 升级后旧备份就是上一个版本的代码，
   *      留着它等于埋一颗雷（回滚即降级），所以每次打桥前都重新确认一次。
   */
  const built = build(archive)
  if (!built.ok) return { ok: false, changed: false, message: built.error }
  const checked = verify(archive, built)
  if (!checked.ok) return { ok: false, changed: false, message: '自检未通过: ' + String(checked.error) }

  const backup = backupPath(archive)
  if (!backupFresh(archive, backup)) {
    fs.copyFileSync(archive, backup)
  }

  const running = isRunning(archive)
  let temp = null
  try {
    if (running) {
      /* 运行中：等长就地覆盖。改动只有几百字节，且两个文件都已加载完毕。 */
      const fd = fs.openSync(archive, 'r+')
      try {
        for (const write of built.writes) {
          fs.writeSync(fd, write.buffer, 0, write.buffer.length, write.fileOffset)
        }
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } else {
      /*
       * 未运行：先整文件复制一份，再在副本上原地写，最后 rename 顶上 —— 既保持原子性，
       * 也不用把 115 MB 读进内存（早先的 readFileSync + writeFileSync 会多占一份 115 MB）。
       */
      temp = archive + '.tmp-' + String(process.pid)
      fs.copyFileSync(archive, temp)
      const fd = fs.openSync(temp, 'r+')
      try {
        for (const write of built.writes) {
          fs.writeSync(fd, write.buffer, 0, write.buffer.length, write.fileOffset)
        }
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(temp, archive)
      temp = null
    }
  } catch (error) {
    if (temp !== null) {
      try {
        fs.unlinkSync(temp)
      } catch {
        /* 留一个临时文件，总好过留一个坏归档 */
      }
    }
    const why = error instanceof Error ? error.message : String(error)
    const done = rollbackNote(archive, { lockHeld: true })
    return {
      ok: false,
      changed: false,
      running,
      rolledBack: done.ok,
      message: '写入失败（' + why + '）' + done.note,
    }
  }

  const after = status(archive)
  if (!after.ok || !after.installed) {
    const done = rollbackNote(archive, { lockHeld: true })
    return {
      ok: false,
      changed: false,
      running,
      rolledBack: done.ok,
      message: '写入后校验失败，桥未生效' + done.note,
    }
  }
  return {
    ok: true,
    changed: true,
    version: after.version,
    upgradedFrom: upgradedFrom || undefined,
    running,
    rolledBack: false,
    report: built.report,
    message:
      (upgradedFrom
        ? '桥已从 v' + String(upgradedFrom) + ' 升级到 v' + String(after.version)
        : '桥已写入 (v' + String(after.version) + ')') +
      (running ? '，重启 DSH 后生效' : '') +
      platformCaveat(archive),
  }
}

/**
 * 平台特有的附加提醒，拼在成功消息后面。
 *
 * macOS 上改动 `.app` 内的资源可能破坏代码签名：若 DSH 做过签名与公证，`app.asar`
 * 属于被 seal 的资源，改完 Gatekeeper 有可能拒绝启动。这一点无法在写入前自动判定，
 * 所以只在成功之后如实提示，并给出还原的办法。
 *
 * @param archive - app.asar 路径。
 * @returns 提醒文本；不需要提醒时为空串。
 */
function platformCaveat(archive) {
  if (process.platform !== 'darwin') return ''
  if (!String(archive).includes('.app/')) return ''
  return (
    '。提醒：macOS 上若 DeepSeek Harness 经过代码签名与公证，修改 app.asar 可能使' +
    '签名失效，Gatekeeper 可能拒绝启动（提示「已损坏」）。出现这种情况请执行 ' +
    'restore 还原归档即可恢复，无需重装 DSH。'
  )
}

/**
 * 失败收尾：把归档还原回原版，并给出可直接拼进错误消息的说明。
 *
 * @param archive - 线上归档路径。
 * @param options - `{ lockHeld }`：调用方是否已经持有归档锁。
 * @returns `{ ok, note }`；`ok` 表示确实还原成功。
 */
function rollbackNote(archive, options = {}) {
  const rolled = rollbackAfterFailure(archive, { lockHeld: options.lockHeld === true })
  return {
    ok: rolled.ok,
    note: rolled.ok
      ? '，已自动用备份还原，DSH 安装目录未受影响'
      : '，且自动还原也失败（' + rolled.message + '），请手动执行 restore',
  }
}

/**
 * 从备份回滚。
 *
 * 归档**尚未打过桥**时直接拒绝：这种情况下备份多半是上一个版本留下的，写回去等于把
 * 安装目录降级（新 exe 配旧资源）。确实需要强制覆盖时用 `{ force: true }`。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ force, lockHeld }`：`force` 表示未安装时也照写（默认 false）；
 *   `lockHeld` 表示调用方已持有归档锁。
 * @returns 结果对象 `{ ok, changed, message }`。
 */
export function restore(archive, options = {}) {
  const locked =
    options.lockHeld === true ? { ok: true, file: null, error: null } : acquireLock(archive)
  if (!locked.ok) return { ok: false, changed: false, message: locked.error }
  try {
    return restoreHolding(archive, options)
  } finally {
    releaseLock(locked)
  }
}

/**
 * {@link restore} 的主体（调用方已持有归档锁）。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ force }`。
 * @returns 结果对象。
 */
function restoreHolding(archive, options = {}) {
  const backup = backupPath(archive)
  if (!fs.existsSync(backup)) {
    return { ok: false, changed: false, message: '没有备份文件，无法回滚' }
  }
  if (!options.force) {
    const current = status(archive)
    if (current.ok && !current.installed) {
      return { ok: true, changed: false, message: '当前归档未打过桥，无需还原' }
    }
  }
  const running = isRunning(archive)
  if (running) {
    const fd = fs.openSync(archive, 'r+')
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024)
      const total = fs.statSync(backup).size
      const src = fs.openSync(backup, 'r')
      try {
        let at = 0
        while (at < total) {
          const read = fs.readSync(src, buf, 0, buf.length, at)
          if (read <= 0) break
          fs.writeSync(fd, buf, 0, read, at)
          at += read
        }
      } finally {
        fs.closeSync(src)
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } else {
    fs.copyFileSync(backup, archive)
  }
  const after = status(archive)
  /*
   * 判定必须带上 `after.ok`：归档彻底读不出来时 `status()` 也报 `installed: false`，
   * 只看 `!installed` 会把「文件已经坏了」当成「还原成功」——那是最不该静默的一种失败。
   */
  const message = !after.ok
    ? '还原后归档无法解析（' + String(after.error) + '），请用 app.asar.orig 手动覆盖 app.asar'
    : after.installed
      ? '回滚后仍检测到桥，请检查备份文件'
      : '已还原为原始 app.asar' + (running ? '（重启 DSH 后生效）' : '')
  return {
    ok: after.ok && !after.installed,
    changed: true,
    message,
  }
}

/**
 * 卸载：把归档还原成原版，并把本插件留下的**所有**痕迹一并清掉。
 *
 * 与 {@link restore} 的区别是它会顺带删掉 `app.asar.orig` 备份 —— 还原完成后备份与
 * 归档内容已经一致，留着只是又一份 115 MB 的冗余副本。插件被停用/卸载时走这一步。
 *
 * 幂等：桥本来就不在、备份也不在时返回 `ok` 且 `changed: false`。
 *
 * @param archive - app.asar 路径。
 * @param options - `{ lockHeld }`。
 * @returns 结果对象 `{ ok, changed, removedBackup, message }`。
 */
export function uninstall(archive, options = {}) {
  const locked =
    options.lockHeld === true ? { ok: true, file: null, error: null } : acquireLock(archive)
  if (!locked.ok) return { ok: false, changed: false, removedBackup: false, message: locked.error }
  try {
    const before = status(archive)
    if (!before.ok) {
      return { ok: false, changed: false, removedBackup: false, message: '无法读取归档: ' + String(before.error) }
    }

    let changed = false
    let message = '归档本来就是原版，桥不在'
    if (before.installed) {
      const rolled = restoreHolding(archive, { force: true })
      if (!rolled.ok) {
        return { ok: false, changed: false, removedBackup: false, message: '还原失败: ' + rolled.message }
      }
      changed = rolled.changed === true
      message = rolled.message
    }

    /* 还原后归档与备份内容一致，备份已无意义，顺手清掉。 */
    let removedBackup = false
    const backup = backupPath(archive)
    try {
      if (fs.existsSync(backup)) {
        fs.unlinkSync(backup)
        removedBackup = true
      }
    } catch {
      /* 删不掉不影响正确性，下次再试 */
    }

    return {
      ok: true,
      changed,
      removedBackup,
      message: message + (removedBackup ? '；备份已清理' : ''),
    }
  } finally {
    releaseLock(locked)
  }
}
