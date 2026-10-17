// dsh-window-control 沙箱自测：在 vm 里用最小 mock 跑一遍 client.js。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const code = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

// ---------------- mocks ----------------
const store = new Map()
/** 模拟 sessionStorage：DSH 重启即清空（测试里手动 clear 就是「重启一次」）。 */
const sessionStore = new Map()
/** 复制进剪贴板的文本。 */
const clipboardWrites = []
const keyListeners = []
const winListeners = new Map()
const quitCalls = []
const fsCalls = []
const mxCalls = []
const mnCalls = []
const topCalls = []
/** 每次调桥 `state()` 时的快照，用来验证「收敛后是否还在轮询」。 */
const stateCalls = []
/** 模拟的窗口状态，由 mock 桥读写，用于验证启动铺满逻辑。 */
const hw = { fullscreen: false, maximized: false, minimized: false, top: false }

const mockReact = {
  createElement(type, props, ...children) {
    const node = { type, props: props || {}, children }
    if (typeof type === 'function' && type.prototype && type.prototype.render) {
      // class 组件：实例化并调用 render，模拟一次渲染
      const inst = new type(node.props)
      inst.props = node.props
      inst.state = inst.state || {}
      try {
        node.rendered = inst.render()
      } catch (e) {
        node.renderError = e
      }
    } else if (typeof type === 'function') {
      try {
        node.rendered = type({ ...node.props, children })
      } catch (e) {
        node.renderError = e
      }
    }
    return node
  },
  useState(init) {
    const value = typeof init === 'function' ? init() : init
    return [value, () => {}]
  },
  useEffect() {},
  useRef(v) {
    return { current: v }
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(patch) {
      this.state = { ...this.state, ...patch }
    }
  },
}

class MockEvent {
  constructor(type, opts) {
    this.type = type
    this.detail = opts && opts.detail
    this.defaultPrevented = false
    this.key = opts && opts.key
    this.ctrlKey = false
    this.altKey = false
    this.metaKey = false
    this.shiftKey = false
    this.isComposing = false
  }
  preventDefault() {
    this.defaultPrevented = true
  }
}

const sandbox = {
  console,
  Promise,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Date,
  Math,
  RegExp,
  Set,
  Map,
  isNaN,
  parseInt,
  parseFloat,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  CustomEvent: MockEvent,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  navigator: {
    language: 'zh-CN',
    userAgent: 'MockBrowser/1.0 (selftest)',
    clipboard: {
      writeText: (t) => {
        clipboardWrites.push(String(t))
        return Promise.resolve()
      },
    },
  },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  sessionStorage: {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  },
  clipboard: {
    writeText: (t) => {
      clipboardWrites.push(String(t))
      return Promise.resolve()
    },
  },
}
sandbox.window = {
  localStorage: sandbox.localStorage,
  sessionStorage: sandbox.sessionStorage,
  navigator: sandbox.navigator,
  clipboard: sandbox.clipboard,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, [])
    winListeners.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    const list = winListeners.get(type) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  },
  dispatchEvent(event) {
    const list = winListeners.get(event.type) || []
    list.slice().forEach((fn) => fn(event))
  },
  dshWindowControl: {
    v: 3,
    setFullscreen(v) {
      fsCalls.push(v)
      hw.fullscreen = !!v
      if (v) hw.maximized = false
      return Promise.resolve(!!v)
    },
    setMinimized(v) {
      mnCalls.push(v)
      hw.minimized = !!v
      return Promise.resolve(!!v)
    },
    setTop(v) {
      topCalls.push(v)
      hw.top = !!v
      return Promise.resolve(!!v)
    },
    setMaximized(v) {
      mxCalls.push(v)
      hw.maximized = !!v
      if (v) hw.fullscreen = false
      return Promise.resolve(!!v)
    },
    state() {
      stateCalls.push({ ...hw })
      return Promise.resolve({ ...hw })
    },
    quit(options) {
      quitCalls.push(options)
      return Promise.resolve(0)
    },
  },
}
sandbox.window.confirm = () => false
sandbox.document = {
  documentElement: {
    setAttribute() {},
    getAttribute() {
      return null
    },
  },
  activeElement: null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}
sandbox.globalThis = sandbox
sandbox.window.document = sandbox.document

// 插件会 setInterval 轮询 + setTimeout 重试；这里接管计时器，方便测完一次性清理，
// 避免上一个模块实例的定时链污染后面的断言。
const pluginTimers = new Set()
const pluginIntervals = new Set()
sandbox.window.setTimeout = (fn, ms) => {
  const id = setTimeout(() => {
    pluginTimers.delete(id)
    fn()
  }, ms)
  pluginTimers.add(id)
  return id
}
sandbox.window.clearTimeout = (id) => {
  pluginTimers.delete(id)
  clearTimeout(id)
}
sandbox.window.setInterval = (fn, ms) => {
  const id = setInterval(fn, ms)
  pluginIntervals.add(id)
  return id
}
sandbox.window.clearInterval = (id) => {
  pluginIntervals.delete(id)
  clearInterval(id)
}
function killPluginTimers() {
  pluginTimers.forEach((id) => clearTimeout(id))
  pluginTimers.clear()
  pluginIntervals.forEach((id) => clearInterval(id))
  pluginIntervals.clear()
}

let loaded = null
sandbox.window.__ModuleLoader__ = {
  load(cfg) {
    loaded = cfg
  },
}

// ---------------- run ----------------
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

const results = []
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra })
}

check('模块被 __ModuleLoader__ 加载', loaded !== null)
check('插件 id 正确', loaded && loaded.id === 'dsh-window-control')

const req = (name) => {
  if (name === 'react') return mockReact
  throw new Error('unexpected require: ' + name)
}
const mod = loaded.factory(req)
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject=[slots]', Array.isArray(mod.inject) && mod.inject[0] === 'slots')

// 记录 effect / slots
const effects = []
const injected = []
const ctx = {
  slots: {
    inject(slot, fn) {
      injected.push(slot)
      return fn()
    },
    register(meta, component) {
      injected.push(meta.id)
      return component
    },
  },
  effect(fn, label) {
    effects.push({ label, dispose: fn() })
  },
}

let applyError = null
try {
  mod.apply(ctx)
} catch (e) {
  applyError = e
}
check('apply 无异常', applyError === null, applyError && applyError.message)
check('注册了 settings.section', injected.includes('settings.section'))
check('注册了 window-control 区块', injected.includes('window-control'))
check('注册了 4 个 effect', effects.length === 4, effects.map((e) => e.label).join(' | '))

// ---- Esc 行为 ----
const keydowns = winListeners.get('keydown') || []
check('已挂 keydown 监听', keydowns.length === 1)

const v2Bridge = sandbox.window.dshWindowControl

async function pressEscape(extra) {
  const e = new MockEvent('keydown', { key: 'Escape' })
  Object.assign(e, extra || {})
  keydowns[0](e)
  // 退出确认框是异步的，等一个宏任务让 quitPending 复位
  await new Promise((r) => setTimeout(r, 0))
  return e
}

quitCalls.length = 0
await pressEscape()
check('Esc 空闲时触发 quit', quitCalls.length === 1)
const quitArg = quitCalls[0]
check(
  '退出请求带原生确认框参数',
  !!quitArg &&
    Array.isArray(quitArg.buttons) &&
    quitArg.buttons.length === 2 &&
    quitArg.buttons[0] === '退出' &&
    quitArg.buttons[1] === '取消' &&
    quitArg.defaultId === 0 &&
    quitArg.cancelId === 1,
  quitArg && JSON.stringify(quitArg.buttons),
)
check(
  '确认框带标题/正文/说明',
  !!quitArg && !!quitArg.title && !!quitArg.message && !!quitArg.detail,
  quitArg && quitArg.title + ' | ' + quitArg.message,
)

// 输入框内不触发
quitCalls.length = 0
sandbox.document.activeElement = { tagName: 'INPUT', isContentEditable: false }
await pressEscape()
check('输入框聚焦时不触发 quit', quitCalls.length === 0)
sandbox.document.activeElement = null

// 有对话框时不触发
quitCalls.length = 0
const origQuery = sandbox.document.querySelector
sandbox.document.querySelector = (sel) => (sel.indexOf('dialog') >= 0 ? {} : null)
await pressEscape()
check('对话框打开时不触发 quit', quitCalls.length === 0)
sandbox.document.querySelector = origQuery

// 带修饰键不触发
quitCalls.length = 0
await pressEscape({ ctrlKey: true })
check('Ctrl+Esc 不触发 quit', quitCalls.length === 0)

// 关掉开关后不触发
quitCalls.length = 0
store.set('dsh-window-control:settings', JSON.stringify({ escQuit: false }))
await pressEscape()
check('开关关闭后不触发 quit', quitCalls.length === 0)

// 关掉"仅空闲"后，输入框内也触发
quitCalls.length = 0
store.set('dsh-window-control:settings', JSON.stringify({ escQuit: true, escGuarded: false }))
sandbox.document.activeElement = { tagName: 'TEXTAREA', isContentEditable: false }
await pressEscape()
check('关闭"仅空闲"后输入框内也触发', quitCalls.length === 1)
sandbox.document.activeElement = null
store.clear()

// ---- 总开关 ----
// 默认（无配置）应为启用
store.clear()
quitCalls.length = 0
await pressEscape()
check('总开关默认启用（Esc 有效）', quitCalls.length === 1)

// 总开关关闭后，即使在空闲状态也不触发
quitCalls.length = 0
store.set('dsh-window-control:settings', JSON.stringify({ enabled: false }))
await pressEscape()
check('总开关关闭后 Esc 不触发 quit', quitCalls.length === 0)

// 总开关关闭时，即使输入框守卫关闭也不触发
quitCalls.length = 0
store.set(
  'dsh-window-control:settings',
  JSON.stringify({ enabled: false, escQuit: true, escGuarded: false }),
)
await pressEscape()
check('总开关关闭优先于其他开关', quitCalls.length === 0)

// 显式 enabled:true 依然有效（与旧配置兼容）
quitCalls.length = 0
store.set('dsh-window-control:settings', JSON.stringify({ enabled: true }))
await pressEscape()
check('显式启用后 Esc 恢复有效', quitCalls.length === 1)
store.clear()

// ---- 旧桥（无 v 标记）：退回浏览器 confirm，仍然必须先确认 ----
const oldBridge = {
  setFullscreen: () => Promise.resolve(true),
  setMaximized: () => Promise.resolve(true),
  state: () => Promise.resolve({ fullscreen: false, maximized: false, minimized: false }),
  quit: () => {
    quitCalls.push('raw-quit')
    return Promise.resolve(true)
  },
}
sandbox.window.dshWindowControl = oldBridge
let confirms = 0
let confirmAnswer = false
sandbox.window.confirm = () => {
  confirms += 1
  return confirmAnswer
}

quitCalls.length = 0
await pressEscape()
check('旧桥下也是先确认（取消则不退出）', confirms === 1 && quitCalls.length === 0)

confirmAnswer = true
quitCalls.length = 0
await pressEscape()
check('旧桥下确认后才退出', quitCalls.length === 1)

sandbox.window.dshWindowControl = v2Bridge
sandbox.window.confirm = () => false

// ---- 启动自动铺满（重启加载一次 client.js 来真正跑 effect） ----
/** 用给定配置重新加载插件，并等启动铺满的重试链跑完。 */
async function bootWith(config, frames = 6, initialState = null) {
  killPluginTimers()
  if (config === null) store.clear()
  else store.set('dsh-window-control:settings', JSON.stringify(config))
  hw.fullscreen = !!(initialState && initialState.fullscreen)
  hw.maximized = !!(initialState && initialState.maximized)
  fsCalls.length = 0
  mxCalls.length = 0
  let registered = null
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  const m = loaded.factory(req)
  m.apply({
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, component) {
        registered = component
        return component
      },
    },
    effect(fn) {
      fn()
    },
  })
  for (let i = 0; i < frames; i += 1) await new Promise((r) => setTimeout(r, 5))
  return registered
}

await bootWith(null)
check(
  '默认启动行为是「最大化」而不是真全屏（保留右上角窗口按钮）',
  mxCalls.includes(true) && !fsCalls.includes(true),
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// 旧配置只有 startFullscreen:true（旧的真全屏默认值）→ 迁移为最大化
await bootWith({ startFullscreen: true })
check(
  '旧配置 startFullscreen:true 迁移为最大化',
  mxCalls.includes(true) && !fsCalls.includes(true),
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// 旧配置显式关掉过 → 迁移为「不自动」
await bootWith({ startFullscreen: false })
check(
  '旧配置 startFullscreen:false 迁移为「不自动」',
  fsCalls.length === 0 && mxCalls.length === 0,
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// 显式选真全屏仍然可用
await bootWith({ startMode: 'fullscreen' })
check(
  'startMode:fullscreen 仍然会真全屏',
  fsCalls.includes(true) && !mxCalls.includes(true),
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// 已经是全屏时改成最大化：先退全屏再最大化
await bootWith({ startMode: 'maximized', enabled: true }, 6, { fullscreen: true })
check(
  '全屏状态下切最大化：先退全屏',
  fsCalls.includes(false) && mxCalls.includes(true),
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// 总开关关闭时什么都不做
await bootWith({ enabled: false, startMode: 'fullscreen' })
check(
  '总开关关闭后不自动铺满',
  fsCalls.length === 0 && mxCalls.length === 0,
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

// ---- 置顶偏好：启动时要补应用（早先只写进 localStorage、没有任何地方读）----
hw.top = false
topCalls.length = 0
await bootWith({ alwaysOnTop: true })
check('启动时按配置补应用窗口置顶', topCalls.includes(true), `top=${JSON.stringify(topCalls)}`)

hw.top = false
topCalls.length = 0
await bootWith({ alwaysOnTop: false, startMode: 'off' })
check('没勾置顶时启动不碰置顶', topCalls.length === 0, `top=${JSON.stringify(topCalls)}`)

// ---- 启动铺满收敛后必须停手 ----
// 早先那条重试链无条件重跑 10 轮（每轮一次 window-state IPC），贴满之后还在白跑 9 轮。
hw.fullscreen = false
hw.maximized = false
stateCalls.length = 0
await bootWith({ startMode: 'maximized' }, 2)
const stateCallsAfterApply = stateCalls.length
await new Promise((r) => setTimeout(r, 500))
check(
  '铺满成功后就停手（不再重复查询窗口状态）',
  stateCallsAfterApply > 0 && stateCalls.length === stateCallsAfterApply,
  `应用后=${stateCallsAfterApply}，500ms 后=${stateCalls.length}`,
)

// ---- 回归：启动选「不自动」后，再切「最大化」必须立刻生效 ----
// 早先 reapplyNow() 对三个方向共用一个 `appliedMode` 守卫，而启动不铺满时它是空的，
// 于是界面切过去了、窗口纹丝不动。
const offBoot = await bootWith({ startMode: 'off' })
check(
  '启动选「不自动」时不碰窗口',
  fsCalls.length === 0 && mxCalls.length === 0,
  `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
)

/** 从渲染树里找出带 options + onChange 的控件回调。 */
function findModeControl(node, found = { fn: null }) {
  if (node === null || node === undefined || typeof node !== 'object') return found.fn
  if (Array.isArray(node)) {
    node.forEach((n) => findModeControl(n, found))
    return found.fn
  }
  if (
    !found.fn &&
    node.props &&
    Array.isArray(node.props.options) &&
    typeof node.props.onChange === 'function' &&
    node.props.options.some((o) => o && o.value === 'maximized')
  ) {
    found.fn = node.props.onChange
  }
  if (node.rendered) findModeControl(node.rendered, found)
  if (Array.isArray(node.children)) node.children.forEach((c) => findModeControl(c, found))
  return found.fn
}

const offTree = offBoot ? offBoot() : null
const modeOnChange = findModeControl(offTree && offTree.rendered ? offTree.rendered : offTree)
check('能从面板找到「启动模式」控件', typeof modeOnChange === 'function')

if (typeof modeOnChange === 'function') {
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 5))
  }

  // 插件没铺满过时再切一次「不自动」：不该去动用户自己摆好的窗口
  fsCalls.length = 0
  mxCalls.length = 0
  modeOnChange('off')
  await settle()
  check(
    '插件没铺满过时切「不自动」不动用户窗口',
    fsCalls.length === 0 && mxCalls.length === 0,
    `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
  )

  // 核心回归：这次必须真的把窗口最大化
  fsCalls.length = 0
  mxCalls.length = 0
  modeOnChange('maximized')
  await settle()
  check(
    '启动为「不自动」后切「最大化」，窗口立刻最大化',
    mxCalls.includes(true),
    `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
  )

  // 切真全屏同样要立刻生效
  fsCalls.length = 0
  mxCalls.length = 0
  modeOnChange('fullscreen')
  await settle()
  check(
    '切「真全屏」立刻生效',
    fsCalls.includes(true),
    `fs=${JSON.stringify(fsCalls)} mx=${JSON.stringify(mxCalls)}`,
  )
}
store.clear()

// ---- 渲染 Panel（走真实组件函数） ----
const section = injected.find((x) => typeof x === 'function')
// 上面的 injected 混入了字符串，找注册的组件本身
let rendered = null
let renderError = null
let renderTree = null
const ctx2 = {
  slots: {
    inject(slot, fn) {
      return fn()
    },
    register(meta, component) {
      rendered = component
      return component
    },
  },
  effect() {},
}
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' }) // 重新加载，清空状态
  const mod2 = loaded.factory(req)
  mod2.apply(ctx2)
  if (rendered) {
    renderTree = rendered()
    renderError = renderTree && renderTree.renderError
  }
} catch (e) {
  renderError = e
}
check('设置区块组件已注册', typeof rendered === 'function')
check('区块可渲染（无异常）', !renderError, renderError && renderError.message)

/** 递归收集渲染树里的文本节点。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collectText(n, out))
    return out
  }
  if (typeof node === 'object') {
    if (node.rendered) collectText(node.rendered, out)
    if (node.children) collectText(node.children, out)
  }
  return out
}

const panelTexts = renderTree ? collectText(renderTree) : []
check(
  'UI 有「启动时自动铺满窗口」一行',
  panelTexts.some((t) => t.indexOf('启动时自动铺满') >= 0),
  panelTexts.length + ' 段文本',
)
check(
  'UI 有三种启动模式可选',
  ['最大化', '真全屏', '不自动'].every((t) => panelTexts.includes(t)),
)
check(
  'UI 有「按 Esc 退出全屏」开关',
  panelTexts.some((t) => t.indexOf('按 Esc 退出全屏') === 0),
)
check(
  'UI 有「最小化」「窗口置顶」「退出快捷键」',
  ['最小化', '窗口置顶', '退出快捷键'].every((t) => panelTexts.includes(t)),
)

// ---- v3 新能力：点「最小化」/「窗口置顶」要真的打到桥上 ----
/** 按可见文本找渲染树里的按钮。 */
function findButton(node, label, found = { el: null }) {
  if (node === null || node === undefined || typeof node !== 'object') return found.el
  if (Array.isArray(node)) {
    node.forEach((n) => findButton(n, label, found))
    return found.el
  }
  if (!found.el && node.type === 'button' && Array.isArray(node.children) && node.children.includes(label)) {
    found.el = node
  }
  if (node.rendered) findButton(node.rendered, label, found)
  if (Array.isArray(node.children)) node.children.forEach((c) => findButton(c, label, found))
  return found.el
}

/** 按旁边那行标题找开关（SwitchRow 是「文本 + Switch」两栏结构）。 */
function findSwitchByTitle(node, title, found = { el: null }) {
  if (node === null || node === undefined || typeof node !== 'object') return found.el
  if (Array.isArray(node)) {
    node.forEach((n) => findSwitchByTitle(n, title, found))
    return found.el
  }
  if (!found.el && Array.isArray(node.children)) {
    const texts = []
    node.children.forEach((c) => collectText(c, texts))
    if (texts.some((t) => t === title)) {
      /*
       * Switch 是函数组件：`role="switch"` 在它**渲染出来的 button** 上，
       * 不在外层 createElement 的 props 里，所以两层都要看。
       */
      const pick = (c) => {
        if (!c) return null
        if (c.props && c.props.role === 'switch') return c
        if (c.rendered && c.rendered.props && c.rendered.props.role === 'switch') return c.rendered
        return null
      }
      for (const c of node.children) {
        const sw = pick(c)
        if (sw) {
          found.el = sw
          break
        }
      }
    }
  }
  if (node.rendered) findSwitchByTitle(node.rendered, title, found)
  if (Array.isArray(node.children)) node.children.forEach((c) => findSwitchByTitle(c, title, found))
  return found.el
}

mnCalls.length = 0
const mnBtn = findButton(renderTree, '最小化')
check('面板能找到「最小化」按钮', !!mnBtn)
if (mnBtn) {
  check('v3 桥下「最小化」可用（未禁用）', mnBtn.props.disabled !== true)
  mnBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  check('点「最小化」调用 setMinimized(true)', mnCalls.includes(true), JSON.stringify(mnCalls))
}

topCalls.length = 0
const topSw = findSwitchByTitle(renderTree, '窗口置顶')
check('面板能找到「窗口置顶」开关', !!topSw)
if (topSw) {
  check('v3 桥下「窗口置顶」可用（未禁用）', topSw.props.disabled !== true)
  topSw.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  check('切换「窗口置顶」调用 setTop', topCalls.includes(true), JSON.stringify(topCalls))
}

// ---- 无桥状态：文案必须引导「重启」，且不得再指向已被移除的外部脚本 ----
const savedBridge = sandbox.window.dshWindowControl
delete sandbox.window.dshWindowControl
let noBridgeTexts = []
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  let component = null
  loaded.factory(req).apply({
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, c) {
        component = c
        return c
      },
    },
    effect() {},
  })
  const tree = component()
  noBridgeTexts = collectText(tree && tree.rendered ? tree.rendered : tree)
} catch (e) {
  noBridgeTexts = []
}
sandbox.window.dshWindowControl = savedBridge
check(
  '无桥时给出「重启 DSH」的引导',
  noBridgeTexts.some((t) => t.indexOf('重启') >= 0 || t.indexOf('重新打开') >= 0),
  noBridgeTexts.filter((t) => t.indexOf('窗口通道') >= 0).join(' / ').slice(0, 120),
)
check(
  '无桥文案不再指向已移除的 dsh_window_bridge.py',
  !noBridgeTexts.some((t) => t.indexOf('dsh_window_bridge') >= 0),
)
store.clear()

// ---- 跨机首装体验：连续几次没读到桥时，界面要自己说清原因 ----
sessionStore.clear()
clipboardWrites.length = 0
const savedBridgeForLaunch = sandbox.window.dshWindowControl
delete sandbox.window.dshWindowControl

/**
 * 模拟一次「重启 DSH 后打开设置页」：sessionStorage 归零（= 新会话），
 * 重新加载模块（= 新的插件实例），返回渲染树。
 */
function launchWithoutBridge() {
  sessionStore.clear()
  let component = null
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  loaded.factory(req).apply({
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, c) {
        component = c
        return c
      },
    },
    effect() {},
  })
  const tree = component ? component() : null
  return tree && tree.rendered ? tree.rendered : tree
}

const launch1 = collectText(launchWithoutBridge())
check(
  '第 1 次没读到桥：只引导重启，不甩排障清单',
  (launch1.some((t) => t.indexOf('重启') >= 0 || t.indexOf('重新打开') >= 0)) &&
    !launch1.some((t) => t.indexOf('一直没生效') >= 0),
  launch1.filter((t) => t.indexOf('窗口通道') >= 0).join(' / ').slice(0, 100),
)
const launch2 = collectText(launchWithoutBridge())
check('第 2 次仍没读到桥：仍视为「还在生效的路上」，不误报', !launch2.some((t) => t.indexOf('一直没生效') >= 0))
const launch3 = collectText(launchWithoutBridge())
check(
  '第 3 次仍没读到桥：改为显示排障卡片',
  launch3.some((t) => t.indexOf('一直没生效') >= 0),
  launch3.filter((t) => t.indexOf('连续') >= 0).join(' / ').slice(0, 100),
)
check(
  '排障卡片列出四种常见原因（权限 / 签名 / 杀软 / DSH 升级）',
  ['Program Files', 'macOS', '杀毒', '升级'].every((k) => launch3.some((t) => t.indexOf(k) >= 0)),
)
check(
  '排障卡片给出状态文件位置与 CLI 命令',
  launch3.some((t) => t.indexOf('.dsh-window-control.json') >= 0) &&
    launch3.some((t) => t.indexOf('bridge-cli.mjs status') >= 0),
)

const tree4 = launchWithoutBridge()
const copyBtn = findButton(tree4, '复制排障信息')
check('排障卡片有「复制排障信息」按钮', !!copyBtn)
if (copyBtn) {
  clipboardWrites.length = 0
  copyBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  const copied = clipboardWrites.join('')
  check(
    '点复制后把版本 / 期望桥版本 / 未生效次数写进剪贴板',
    copied.indexOf('dsh-window-control v') >= 0 &&
      copied.indexOf('expected v3') >= 0 &&
      copied.indexOf('launches without bridge: 4') >= 0,
    JSON.stringify(copied.slice(0, 120)),
  )
}

// 桥恢复后必须清零，否则一次偶发失败会被长期误报成「装不上」
sandbox.window.dshWindowControl = savedBridgeForLaunch
sessionStore.clear()
let componentOk = null
vm.runInContext(code, sandbox, { filename: 'client.js' })
loaded.factory(req).apply({
  slots: {
    inject(slot, fn) {
      return fn()
    },
    register(meta, c) {
      componentOk = c
      return c
    },
  },
  effect() {},
})
if (componentOk) componentOk()
check('桥恢复正常后清空无桥计数', !store.has('dsh-window-control:nobridge'), [...store.keys()].join(','))
store.clear()
sessionStore.clear()

// 选「真全屏」时应出现「会隐藏右上角窗口按钮」的提示卡片
store.set('dsh-window-control:settings', JSON.stringify({ startMode: 'fullscreen' }))
let fsWarnTexts = []
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  let component = null
  loaded.factory(req).apply({
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, c) {
        component = c
        return c
      },
    },
    effect() {},
  })
  const tree = component()
  fsWarnTexts = collectText(tree && tree.rendered ? tree.rendered : tree)
} catch (e) {
  fsWarnTexts = []
}
check(
  '选真全屏时给出「会隐藏右上角按钮」提示',
  fsWarnTexts.some((t) => t.indexOf('隐藏右上角') >= 0),
  fsWarnTexts.filter((t) => t.indexOf('隐藏') >= 0).join(' / '),
)
store.clear()

// ---- 停用状态下的渲染 ----
store.set('dsh-window-control:settings', JSON.stringify({ enabled: false }))
let disabledTree = null
let disabledError = null
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  const mod3 = loaded.factory(req)
  const ctx3 = {
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, component) {
        disabledTree = component
        return component
      },
    },
    effect() {},
  }
  mod3.apply(ctx3)
  const tree = disabledTree()
  disabledError = tree && tree.renderError
} catch (e) {
  disabledError = e
}
check(
  '停用状态区块可渲染',
  typeof disabledTree === 'function' && !disabledError,
  disabledError && disabledError.message,
)
store.clear()

// ---- 真全屏下 Esc 先退全屏，不弹退出确认 ----
v2Bridge.state = () => Promise.resolve({ fullscreen: true, maximized: false, minimized: false })
store.set(
  'dsh-window-control:settings',
  JSON.stringify({ enabled: true, startMode: 'off', escQuit: true, escGuarded: false, escExitFullscreen: true }),
)
// 重新加载，让 installStatePoll 把 lastState 置为 fullscreen:true
await new Promise((r) => setTimeout(r, 0))
let keydown2 = null
const ctxFs = {
  slots: {
    inject(slot, fn) {
      return fn()
    },
    register(meta, component) {
      return component
    },
  },
  effect(fn) {
    fn()
  },
}
vm.runInContext(code, sandbox, { filename: 'client.js' })
loaded.factory(req).apply(ctxFs)
keydown2 = (winListeners.get('keydown') || []).slice(-1)[0]
await new Promise((r) => setTimeout(r, 5))
fsCalls.length = 0
quitCalls.length = 0
keydown2(new MockEvent('keydown', { key: 'Escape' }))
await new Promise((r) => setTimeout(r, 5))
check('真全屏下 Esc 退出全屏而不退出应用', fsCalls.includes(false) && quitCalls.length === 0,
  `fs=${JSON.stringify(fsCalls)} quit=${quitCalls.length}`)

// 关掉该开关后就回到「弹退出确认」
v2Bridge.state = () => Promise.resolve({ fullscreen: true, maximized: false, minimized: false })
store.set(
  'dsh-window-control:settings',
  JSON.stringify({ enabled: true, startMode: 'off', escQuit: true, escGuarded: false, escExitFullscreen: false }),
)
vm.runInContext(code, sandbox, { filename: 'client.js' })
loaded.factory(req).apply(ctxFs)
const keydown3 = (winListeners.get('keydown') || []).slice(-1)[0]
await new Promise((r) => setTimeout(r, 5))
fsCalls.length = 0
quitCalls.length = 0
keydown3(new MockEvent('keydown', { key: 'Escape' }))
await new Promise((r) => setTimeout(r, 5))
check('关掉「Esc 退出全屏」后仍然弹退出确认', !fsCalls.includes(false) && quitCalls.length === 1,
  `fs=${JSON.stringify(fsCalls)} quit=${quitCalls.length}`)
v2Bridge.state = () => Promise.resolve({ fullscreen: false, maximized: false, minimized: false })
store.clear()

// ---- 长按 Esc（键盘 repeat）不应重复弹退出确认 ----
store.set(
  'dsh-window-control:settings',
  JSON.stringify({ enabled: true, startMode: 'off', escQuit: true, escGuarded: false, escExitFullscreen: false }),
)
vm.runInContext(code, sandbox, { filename: 'client.js' })
loaded.factory(req).apply(ctxFs)
const keydown4 = (winListeners.get('keydown') || []).slice(-1)[0]
await new Promise((r) => setTimeout(r, 5))
quitCalls.length = 0
const repeated = new MockEvent('keydown', { key: 'Escape' })
repeated.repeat = true
keydown4(repeated)
await new Promise((r) => setTimeout(r, 5))
check('长按 Esc（repeat）不重复触发退出确认', quitCalls.length === 0, `quit=${quitCalls.length}`)
store.clear()

// ---- 退出快捷键可配置（Esc / 双击 Esc / Ctrl+Q / 关闭）----
const keyBase = {
  enabled: true,
  startMode: 'off',
  escQuit: true,
  escGuarded: false,
  escExitFullscreen: false,
}
async function bootKey(config) {
  store.set('dsh-window-control:settings', JSON.stringify(config))
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  loaded.factory(req).apply(ctxFs)
  const fn = (winListeners.get('keydown') || []).slice(-1)[0]
  await new Promise((r) => setTimeout(r, 5))
  quitCalls.length = 0
  return async function (init) {
    // MockEvent 把修饰键写死成 false，这里按需改回来
    const e = new MockEvent('keydown', init)
    if (init.ctrlKey) e.ctrlKey = true
    if (init.altKey) e.altKey = true
    if (init.metaKey) e.metaKey = true
    if (init.shiftKey) e.shiftKey = true
    fn(e)
    await new Promise((r) => setTimeout(r, 5))
  }
}

let pressKey = await bootKey({ ...keyBase, quitKey: 'escape' })
await pressKey({ key: 'Escape' })
check('quitKey=escape：单击 Esc 触发退出', quitCalls.length === 1, `quit=${quitCalls.length}`)

pressKey = await bootKey({ ...keyBase, quitKey: 'double-escape' })
await pressKey({ key: 'Escape' })
check('quitKey=double-escape：第一下不触发', quitCalls.length === 0, `quit=${quitCalls.length}`)
await pressKey({ key: 'Escape' })
check('quitKey=double-escape：第二下触发', quitCalls.length === 1, `quit=${quitCalls.length}`)

pressKey = await bootKey({ ...keyBase, quitKey: 'ctrl+q' })
await pressKey({ key: 'Escape' })
check('quitKey=ctrl+q：Esc 不触发', quitCalls.length === 0, `quit=${quitCalls.length}`)
await pressKey({ key: 'q', ctrlKey: true })
check('quitKey=ctrl+q：Ctrl+Q 触发', quitCalls.length === 1, `quit=${quitCalls.length}`)

pressKey = await bootKey({ ...keyBase, quitKey: 'off' })
await pressKey({ key: 'Escape' })
await pressKey({ key: 'q', ctrlKey: true })
check('quitKey=off：两种方式都不触发', quitCalls.length === 0, `quit=${quitCalls.length}`)

pressKey = await bootKey({ ...keyBase, quitKey: 'bogus' })
await pressKey({ key: 'Escape' })
check('quitKey 非法值回落为 escape', quitCalls.length === 1, `quit=${quitCalls.length}`)
store.clear()

// ---------------- 容错路径：locale 接入 / 插槽未就绪 ----------------
// 清单里声明了 dsh.client.immediately，本模块可能在插槽服务就绪前就被加载；
// 下面三条钉住「这些锦上添花的东西坏掉时，插件主体必须照常工作」。

// ① 接入 DSH locale 服务后，文案改走 t()
const tCalls = []
let registeredLocale = null
let componentFromLocale = null
vm.runInContext(code, sandbox, { filename: 'client.js' })
loaded.factory(req).apply({
  locale: {
    register(ns, dict) {
      registeredLocale = { ns, dict }
    },
    bind(ns) {
      return (key) => {
        tCalls.push(key)
        return 'T:' + key
      }
    },
  },
  slots: {
    inject(slot, fn) {
      return fn()
    },
    register(meta, c) {
      componentFromLocale = c
      return c
    },
  },
  effect() {},
})
check(
  'locale 服务被注册（命名空间 = 插件 id）',
  !!registeredLocale && registeredLocale.ns === 'dsh-window-control',
  registeredLocale && registeredLocale.ns,
)
check(
  '注册了 zh / en 两套字典',
  !!registeredLocale && !!registeredLocale.dict.zh && !!registeredLocale.dict.en,
)

let localeTexts = []
try {
  const tree = componentFromLocale()
  localeTexts = collectText(tree && tree.rendered ? tree.rendered : tree)
} catch (e) {
  localeTexts = []
}
check(
  '接入 locale 后文案来自 t()',
  localeTexts.some((t) => t.indexOf('T:') === 0),
  localeTexts.slice(0, 3).join(' / '),
)

// ② locale 服务抛异常时必须静默退回内置字典
let fallbackTexts = []
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  let component = null
  loaded.factory(req).apply({
    locale: {
      register() {
        throw new Error('locale service exploded')
      },
      bind() {
        throw new Error('locale service exploded')
      },
    },
    slots: {
      inject(slot, fn) {
        return fn()
      },
      register(meta, c) {
        component = c
        return c
      },
    },
    effect() {},
  })
  const tree = component()
  fallbackTexts = collectText(tree && tree.rendered ? tree.rendered : tree)
} catch (e) {
  fallbackTexts = []
}
check(
  'locale 服务异常时退回内置字典',
  fallbackTexts.some((t) => t.indexOf('启动时自动铺满') >= 0),
  fallbackTexts.slice(0, 3).join(' / '),
)

// ③ 插槽服务缺失/抛错时，apply 不得抛异常，且四个行为仍要注册（轮询 / 铺满 / 置顶 / Esc）
const behaviorLabels = []
let slotsError = null
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  loaded.factory(req).apply({
    slots: {
      inject() {
        throw new Error('slots not ready')
      },
    },
    effect(fn, label) {
      behaviorLabels.push(label)
    },
  })
} catch (e) {
  slotsError = e
}
check(
  '插槽未就绪时 apply 不抛异常',
  slotsError === null,
  slotsError && slotsError.message,
)
check(
  '插槽未就绪时仍注册四个行为',
  behaviorLabels.length === 4,
  behaviorLabels.join(' | '),
)

let noSlotsError = null
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  loaded.factory(req).apply({ effect() {} })
} catch (e) {
  noSlotsError = e
}
check(
  '完全没有 slots 服务时 apply 也不抛异常',
  noSlotsError === null,
  noSlotsError && noSlotsError.message,
)

// ---------------- 版本号一致性（诊断信息里要报版本，不能写错） ----------------
const pkgJson = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
const versionInClient = /var PLUGIN_VERSION = '([^']+)'/.exec(code)
check(
  'client.js 里的 PLUGIN_VERSION 与 package.json 一致',
  !!versionInClient && versionInClient[1] === pkgJson.version,
  `client=${versionInClient && versionInClient[1]} pkg=${pkgJson.version}`,
)

// ---------------- report ----------------
killPluginTimers()
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? '  [OK] ' : '  [FAIL] '}${r.name}${r.extra ? '  -> ' + r.extra : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
