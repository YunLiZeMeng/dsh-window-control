/**
 * dsh-window-control — 浏览器半边（Client half）。
 *
 * 在「设置」里注册一个「窗口与退出」区块，并提供：
 *
 *   0. 插件总开关         —— 关闭后本插件不产生任何效果（不自动铺满、Esc 不退出、
 *      其余控件全部隐藏），行为等同「未安装本插件」
 *   1. 全屏 / 退出全屏     —— 真窗口全屏（盖住任务栏），不是网页全屏
 *   2. 最大化 / 还原
 *   3. 退出 DeepSeek Harness —— **先弹原生确认对话框**，确认后才退出
 *      （DSH 自带的确认只在有任务/定时提醒时才弹，空闲时会静默退出，
 *        所以这里无条件自己弹一次）
 *   4. 启动时自动铺满（可选：最大化 / 真全屏 / 不自动）
 *   5. 按 Esc 退出应用（可选，需原生确认）
 *
 * ## 为什么默认是「最大化」而不是「真全屏」
 *
 * DSH 主窗口在 Windows 上用的是 `titleBarStyle: "hidden"` +
 * `titleBarOverlay`，也就是「无系统标题栏，但由系统在右上角画 40px 覆盖层」
 * 的最小化 / 最大化 / 关闭按钮。**一旦进入真全屏，Windows 会连同这个覆盖层
 * 一起隐藏**（任何应用都如此），右上角按钮就没了，用户在全屏里也找不到出口。
 * 最大化同样铺满屏幕，但保留覆盖层，按钮照旧可用，因此作为默认值。
 *
 * 依赖插件自带的 asar 桌面桥暴露的 `window.dshWindowControl`（由 `lib/index.js`
 * 在运行时自动安装、`lib/asar-bridge.js` 注入）。
 * 未打桥时区间降级为提示文案，不会报错、不会白屏。
 *
 * 配置存 localStorage（origin = dsh-app://app），页面加载时同步可读，
 * 因此"启动自动全屏"能在最早时机生效。
 */

window.__ModuleLoader__.load({
  id: 'dsh-window-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ------------------------------------------------------------------ //
    // 配置
    // ------------------------------------------------------------------ //
    var CFG_KEY = 'dsh-window-control:settings'

    /**
     * 插件版本号。只用于「复制排障信息」，让报障的人一眼能说清自己装的是哪一版；
     * 必须与 package.json 的 version 一致（自测里有这条一致性断言，改一处忘一处会红）。
     */
    var PLUGIN_VERSION = '1.4.2'

    /** 期望的桥版本（与 `lib/asar-bridge.js` 的 BRIDGE_VERSION 对齐）。 */
    var EXPECTED_BRIDGE = 3

    /** 「连续几次启动没读到桥」的计数键（localStorage，跨重启保留）。 */
    var NOBRIDGE_KEY = 'dsh-window-control:nobridge'

    /** 同一次运行内的去重标记键（sessionStorage，DSH 重启即清空）。 */
    var NOBRIDGE_SEEN_KEY = 'dsh-window-control:nobridge:seen'

    /** 宿主半边写诊断结果的位置。渲染端读不到文件，只能告诉用户去哪儿看。 */
    var STATUS_FILE = '~/.dsh/profiles/<profile>/.dsh-window-control.json'

    /** 连续几次启动没读到桥，就认为自动安装没成功（正常只需重启一次）。 */
    var NOBRIDGE_ALARM = 3

    /** Client locale 的命名空间（同时也等于插件 id）。 */
    var NS = 'dsh-window-control'
    /**
     * 默认值：插件启用、启动即铺满（最大化，保留右上角窗口按钮）、Esc 退出、带空闲守卫。
     * `enabled` 是总开关：为 false 时插件不做任何事，等同未安装。
     */
    var DEFAULT_CFG = {
      enabled: true,
      startMode: 'maximized',
      escQuit: true,
      escGuarded: true,
      escExitFullscreen: true,
      /** 退出快捷键：`escape` 单击 Esc / `double-escape` 双击 / `ctrl+q` / `off` 关闭。 */
      quitKey: 'escape',
      alwaysOnTop: false,
    }

    /** 双击 Esc 的判定窗口（毫秒）。 */
    var DOUBLE_ESCAPE_MS = 1200

    /** 合法的退出快捷键取值。 */
    var QUIT_KEYS = ['escape', 'double-escape', 'ctrl+q', 'off']

    /** 本插件本次会话里真正改动过的窗口状态（用于停用时精确撤销）。 */
    var appliedMode = null

    /** 最近一次读到的窗口状态（Esc 处理需要同步判断是否处于真全屏）。 */
    var lastState = { fullscreen: false, maximized: false, minimized: false, top: false }

    /** 退出确认框是否已在等待用户选择（防止重复弹框）。 */
    var quitPending = false

    /** 上一次按下 Esc 的时刻（双击判定用）。 */
    var lastEscapeAt = 0

    /** 读布尔开关：非布尔值（含缺失）一律回落到默认值。 */
    function booleanish(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    /**
     * 规整配置，并兼容旧版本。
     *
     * 旧版本只有布尔量 `startFullscreen`，且默认为 true —— 那是**真全屏**，
     * 会隐藏右上角窗口按钮。现在改判为「最大化」：同样铺满屏幕，但保留
     * 最小化 / 最大化 / 关闭。只有曾经显式关掉过（`false`）才迁移成「不自动」。
     *
     * @param parsed - localStorage 里读出的原始对象（可能为空）。
     * @returns 完整且合法的配置对象。
     */
    function normalizeConfig(parsed) {
      var src = parsed || {}
      var mode = src.startMode
      if (mode !== 'maximized' && mode !== 'fullscreen' && mode !== 'off') {
        mode = src.startFullscreen === false ? 'off' : DEFAULT_CFG.startMode
      }
      var key = src.quitKey
      if (QUIT_KEYS.indexOf(key) < 0) key = DEFAULT_CFG.quitKey
      return {
        enabled: booleanish(src.enabled, DEFAULT_CFG.enabled),
        startMode: mode,
        escQuit: booleanish(src.escQuit, DEFAULT_CFG.escQuit),
        escGuarded: booleanish(src.escGuarded, DEFAULT_CFG.escGuarded),
        escExitFullscreen: booleanish(src.escExitFullscreen, DEFAULT_CFG.escExitFullscreen),
        quitKey: key,
        alwaysOnTop: booleanish(src.alwaysOnTop, DEFAULT_CFG.alwaysOnTop),
      }
    }

    function readConfig() {
      try {
        var raw = window.localStorage.getItem(CFG_KEY)
        return normalizeConfig(raw ? JSON.parse(raw) : {})
      } catch (error) {
        return normalizeConfig(null)
      }
    }

    function writeConfig(next) {
      try {
        window.localStorage.setItem(CFG_KEY, JSON.stringify(next))
      } catch (error) {
        /* 存储不可用时仅本次生效 */
      }
      try {
        window.dispatchEvent(new CustomEvent('dsh-window-control:changed', { detail: next }))
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 取桌面桥。桥由 asar 补丁注入到 main world，因此这里能直接读到。
     * @returns {{setFullscreen:Function,setMaximized:Function,state:Function,quit:Function}|null}
     */
    function bridge() {
      var direct = window.dshWindowControl
      if (direct && typeof direct.state === 'function' && typeof direct.setMaximized === 'function') {
        return direct
      }
      var desktop = window.dshDesktop
      if (
        desktop &&
        desktop.windowControl &&
        typeof desktop.windowControl.state === 'function' &&
        typeof desktop.windowControl.setMaximized === 'function'
      ) {
        return desktop.windowControl
      }
      return null
    }

    // ------------------------------------------------------------------ //
    // 桥没生效时的自证：连续几次启动没读到桥？
    //
    // 桥是在 DSH 启动后由宿主半边写进 app.asar 的，而主进程的代码在启动时就已载入
    // 内存 —— 所以「装上」和「生效」之间必然差一次重启。本机早就跨过了这一步，
    // 但别人刚从市场装完看到的是：按钮全灰 + 一句「请重启」。
    //
    // 麻烦在于渲染端读不到宿主的状态文件，没法直接知道「是还没生效」还是「压根
    // 没装成功」（装在 Program Files 没权限、macOS 签名、杀软拦截、DSH 版本变了
    // 导致拒绝注入……）。所以这里用一个能自己维护的信号：跨重启累计「没读到桥」
    // 的会话数。正常情况最多累计 2 次（装 + 生效），第 3 次还说没读到，基本可以
    // 判定自动安装失败 —— 这时把排障信息直接摆在界面上，而不是让用户无限重启。
    // ------------------------------------------------------------------ //

    /** 本次会话的计数结果（-1 表示还没算过）。 */
    var missesCached = -1

    /**
     * 本次启动到底第几次没读到桥。
     *
     * 放在渲染期而不是 useEffect 里，是因为「页面一打开就该知道自己是第几次」，
     * 晚一帧只会让卡片闪一下；而且计数本身是幂等的（内存 + sessionStorage 双层去重，
     * StrictMode 的双次渲染也只会算一次）。
     *
     * @returns 累计次数；桥正常时为 0。
     */
    function countNoBridge() {
      if (missesCached >= 0) return missesCached
      if (bridge()) {
        clearNoBridge()
        missesCached = 0
      } else {
        missesCached = noteNoBridge()
      }
      return missesCached
    }

    /**
     * 读累计次数。
     * @returns 次数（0 表示没有记录）。
     */
    function readNoBridge() {
      try {
        var raw = window.localStorage.getItem(NOBRIDGE_KEY)
        if (!raw) return 0
        var parsed = JSON.parse(raw)
        var n = parsed && typeof parsed.sessions === 'number' ? parsed.sessions : 0
        return n > 0 ? n : 0
      } catch (error) {
        return 0
      }
    }

    /**
     * 记一次「本次启动没读到桥」。
     *
     * 同一次运行只记一次：先按 sessionStorage 判断（页面重载不算重启），
     * 再兜一层内存标记（sessionStorage 不可用时也不会重复累加）。
     *
     * @returns 累计次数。
     */
    function noteNoBridge() {
      /* 本次运行已经算过就别再累加（`missesCached` 同时充当内存去重标记）。 */
      if (missesCached >= 0) return readNoBridge()
      var seen = false
      try {
        seen = window.sessionStorage.getItem(NOBRIDGE_SEEN_KEY) === '1'
        if (!seen) window.sessionStorage.setItem(NOBRIDGE_SEEN_KEY, '1')
      } catch (error) {
        /* 没有 sessionStorage 就只靠内存标记 */
      }
      if (seen) return readNoBridge()
      var next = readNoBridge() + 1
      try {
        window.localStorage.setItem(NOBRIDGE_KEY, JSON.stringify({ sessions: next, at: Date.now() }))
      } catch (error) {
        /* 存不下就只在本次生效 */
      }
      return next
    }

    /** 桥恢复正常后把计数清掉，免得下次偶发失败立刻误报。 */
    function clearNoBridge() {
      try {
        window.localStorage.removeItem(NOBRIDGE_KEY)
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 复制一段文本到剪贴板。
     *
     * 优先用异步 Clipboard API（需要安全上下文，`dsh-app://` 下未必有），
     * 失败退回「临时 textarea + execCommand」这条老路，再失败就如实告知。
     *
     * @param text - 要复制的文本。
     * @param done - 回调，收到 'ok' | 'fail'。
     */
    function copyText(text, done) {
      var fallback = function () {
        try {
          var el = document.createElement('textarea')
          el.value = text
          el.style.position = 'fixed'
          el.style.opacity = '0'
          document.body.appendChild(el)
          el.select()
          var ok = document.execCommand('copy')
          document.body.removeChild(el)
          done(ok ? 'ok' : 'fail')
        } catch (error) {
          done('fail')
        }
      }
      try {
        var clip = window.navigator && window.navigator.clipboard
        if (clip && typeof clip.writeText === 'function') {
          clip.writeText(text).then(
            function () {
              done('ok')
            },
            function () {
              fallback()
            },
          )
          return
        }
      } catch (error) {
        /* 落到 fallback */
      }
      fallback()
    }

    /**
     * 把模板里的 `{n}` / `{p}` 换成实际值。
     * @param template - 模板。
     * @param values - 替换表。
     * @returns 结果字符串。
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (_m, key) {
        return values[key] === undefined ? '{' + key + '}' : String(values[key])
      })
    }

    // ------------------------------------------------------------------ //
    // 文案
    // ------------------------------------------------------------------ //
    var ZH = {
      section: '窗口与退出',
      sectionEn: 'Window & Quit',
      intro: '控制应用窗口，或退出 DeepSeek Harness。',
      fullscreen: '全屏',
      exitFullscreen: '退出全屏',
      maximize: '最大化',
      maximizeNote: '铺满工作区，并保留右上角的最小化 / 最大化 / 关闭按钮。',
      restore: '还原窗口',
      windowGroup: '窗口',
      startupGroup: '启动行为',
      quitGroup: '退出',
      quit: '退出 DeepSeek Harness',
      quitNote: '点击后会弹出确认对话框，确认后才真正退出。',
      quitTitle: '退出 DeepSeek Harness',
      quitMessage: '确定要退出 DeepSeek Harness 吗？',
      quitDetail: '退出后正在运行的任务将会中断。',
      quitConfirm: '退出',
      cancel: '取消',
      startMode: '启动时自动铺满窗口',
      startModeNote: '最大化：铺满屏幕，并保留右上角的最小化 / 最大化 / 关闭按钮（推荐）。',
      modeMaximized: '最大化',
      modeFullscreen: '真全屏',
      modeOff: '不自动',
      modeMaximizedTip: '铺满屏幕，保留右上角窗口按钮',
      modeFullscreenTip: '真全屏（连任务栏一起遮住），Windows 会隐藏右上角窗口按钮',
      fullscreenWarnTitle: '真全屏会隐藏右上角窗口按钮',
      fullscreenWarnBody:
        '这是 Windows 的系统行为：真全屏时标题栏（含最小化 / 最大化 / 关闭）不再显示。想保留这些按钮，请把上面的选项改回「最大化」。全屏状态下按 Esc 可退出全屏。',
      escQuit: '按 Esc 退出应用',
      escQuitNote: '会弹出原生确认对话框，确认后才退出。',
      escGuarded: '仅在空闲时响应 Esc',
      escGuardedNote: '当光标在输入框内、或有对话框打开时不触发，避免误退。',
      escExitFullscreen: '按 Esc 退出全屏',
      escExitFullscreenNote: '真全屏下 Esc 先退出全屏（不再弹退出确认）；只有非全屏时才弹。',
      minimize: '最小化',
      minimizeNote: '把窗口收进任务栏。',
      alwaysOnTop: '窗口置顶',
      alwaysOnTopNote: '让 DeepSeek Harness 始终显示在其他窗口之上。',
      quitKey: '退出快捷键',
      quitKeyNote:
        '若某些界面里 Esc 有别的用途（例如关闭弹层），可改成双击 Esc 或 Ctrl+Q，避免误触退出。',
      keyEscape: 'Esc',
      keyDoubleEscape: '双击 Esc',
      keyCtrlQ: 'Ctrl+Q',
      keyOff: '关闭',
      noBridgeTitle: '窗口通道尚未生效',
      noBridgeBody:
        'DSH 主进程没有开放窗口与退出通道，需要装一次本插件自带的窗口通道。宿主半边会在每次 DSH 启动后自动检查并安装它；如果你刚装好本插件，请完全退出（托盘图标右键 → 退出）再重新打开 DSH，之后这里的按钮就会全部可用。',
      issueTitle: '窗口通道一直没生效',
      issueBody:
        '已经连续 {n} 次启动都没读到窗口通道。正常情况下装好插件后重启一次 DSH 就会自动装上，再重启一次即生效；到这个次数还读不到，多半是自动安装被挡住了。常见原因：',
      issuePerm: '安装目录没有写权限（装在 Program Files、/opt 这类位置时，需要以管理员身份运行一次 DSH）',
      issueMac: 'macOS 代码签名：DSH 若做过签名与公证，改 app.asar 可能让 Gatekeeper 拒绝启动',
      issueAv: '杀毒软件或企业管控拦截了对安装目录的写入',
      issueVersion:
        'DSH 刚升级：新版本里对应的代码变了时插件会主动拒绝注入（不会写坏归档，只会装不上）',
      diagWhere: '自动安装的结果都记在 {p}，里面的 message 字段会写明具体原因。',
      diagCmd: '也可以在插件目录执行：node lib/bridge-cli.mjs status',
      copyDiag: '复制排障信息',
      copied: '已复制到剪贴板',
      copyFailed: '复制失败，请手动截图上面的内容',
      stateNow: '当前状态',
      fs: '全屏',
      mx: '最大化',
      on: '是',
      off: '否',
      failed: '操作失败',
      working: '执行中…',
      master: '启用窗口控制',
      masterNote:
        '关闭后本插件不做任何事：不自动铺满窗口、Esc 不退出应用，其余开关全部隐藏，等同未安装。',
      disabledTitle: '插件已停用',
      disabledBody: '当前不会自动铺满窗口，Esc 也不会退出应用。打开上面的开关即可恢复。',
    }
    var EN = {
      section: 'Window & Quit',
      sectionEn: '窗口与退出',
      intro: 'Control the app window, or quit DeepSeek Harness.',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Leave fullscreen',
      maximize: 'Maximize',
      maximizeNote: 'Fill the work area while keeping the title-bar buttons in the top-right corner.',
      restore: 'Restore window',
      windowGroup: 'Window',
      startupGroup: 'On launch',
      quitGroup: 'Quit',
      quit: 'Quit DeepSeek Harness',
      quitNote: 'A confirmation dialog appears first; the app closes only after you confirm.',
      quitTitle: 'Quit DeepSeek Harness',
      quitMessage: 'Quit DeepSeek Harness?',
      quitDetail: 'Running tasks will be interrupted.',
      quitConfirm: 'Quit',
      cancel: 'Cancel',
      startMode: 'Fill the screen on launch',
      startModeNote: 'Maximize fills the screen while keeping the minimize / maximize / close buttons (recommended).',
      modeMaximized: 'Maximize',
      modeFullscreen: 'Fullscreen',
      modeOff: 'Off',
      modeMaximizedTip: 'Fill the work area, keep the caption buttons',
      modeFullscreenTip: 'True fullscreen (covers the taskbar); Windows hides the caption buttons',
      fullscreenWarnTitle: 'True fullscreen hides the caption buttons',
      fullscreenWarnBody:
        'This is Windows behavior: in true fullscreen the title bar (minimize / maximize / close) is not shown. Pick "Maximize" above to keep those buttons. Press Esc to leave fullscreen.',
      escQuit: 'Quit with Esc',
      escQuitNote: 'A native confirmation dialog appears first.',
      escGuarded: 'Only when idle',
      escGuardedNote: 'Ignored while typing or with a dialog open, to avoid accidental quits.',
      escExitFullscreen: 'Leave fullscreen with Esc',
      escExitFullscreenNote: 'While fullscreen, Esc leaves fullscreen instead of asking to quit.',
      minimize: 'Minimize',
      minimizeNote: 'Send the window to the taskbar.',
      alwaysOnTop: 'Keep window on top',
      alwaysOnTopNote: 'Keep DeepSeek Harness above other windows.',
      quitKey: 'Quit shortcut',
      quitKeyNote:
        'If Esc is used elsewhere in the UI (closing a popover, for example), switch to double Esc or Ctrl+Q to avoid quitting by accident.',
      keyEscape: 'Esc',
      keyDoubleEscape: 'Double Esc',
      keyCtrlQ: 'Ctrl+Q',
      keyOff: 'Disabled',
      noBridgeTitle: 'Window channel not active yet',
      noBridgeBody:
        'The DSH main process exposes no window or quit channel, so this plugin ships its own. The host half installs it automatically after each DSH launch. If you just installed the plugin, quit DSH completely (tray icon -> Quit) and open it again; the buttons below will then be enabled.',
      issueTitle: 'The window channel never became active',
      issueBody:
        'The channel has been missing for {n} launches in a row. Normally one relaunch after installing is enough for the host half to install it, and the next one activates it; at this count the automatic install is most likely being blocked. Usual causes:',
      issuePerm:
        'No write access to the install directory (Program Files, /opt, ...): run DSH once as administrator',
      issueMac:
        'macOS code signing: if DSH is signed and notarized, patching app.asar may make Gatekeeper refuse to launch it',
      issueAv: 'Antivirus or corporate policy blocking writes to the install directory',
      issueVersion:
        'DSH was just updated: when the anchor code changed, the plugin refuses to inject (it never corrupts the archive, it just cannot install)',
      diagWhere: 'The result of every automatic install is recorded in {p}; its message field says why.',
      diagCmd: 'You can also run, from the plugin directory: node lib/bridge-cli.mjs status',
      copyDiag: 'Copy diagnostics',
      copied: 'Copied to clipboard',
      copyFailed: 'Copy failed - please screenshot the above instead',
      stateNow: 'Current state',
      fs: 'Fullscreen',
      mx: 'Maximized',
      on: 'yes',
      off: 'no',
      failed: 'Action failed',
      working: 'Working…',
      master: 'Enable window control',
      masterNote:
        'When off this plugin does nothing: no auto-fill on launch, Esc will not quit, other switches are hidden — as if it were not installed.',
      disabledTitle: 'Plugin disabled',
      disabledBody:
        'No auto-fill on launch and Esc will not quit. Turn the switch above back on to restore.',
    }
    /**
     * 取文案字典。
     *
     * 优先用 DSH 的 locale 服务（跟随应用语言设置，见 installLocale），拿不到就退回
     * 按 `navigator.language` 选的内置字典 —— 两条路都可用，所以这个插件在任何
     * DSH 版本上都不会因为 locale 服务缺席而没文案。
     */
    function strings() {
      if (localeBound) return localeBound
      try {
        var lang = String(navigator.language || navigator.userLanguage || '')
        return lang.toLowerCase().indexOf('zh') === 0 ? ZH : EN
      } catch (error) {
        return ZH
      }
    }

    /** locale 服务返回的取词函数（包装成「取属性」的样子，见 installLocale）。 */
    var localeBound = null

    /**
     * 尽力接入 DSH 的 Client locale 服务。
     *
     * 接入后文案会跟随应用的语言设置（而不是浏览器上报的 `navigator.language`），
     * 也就能被 DSH 的界面语言切换统一带动。失败时静默退回内置字典 —— 这一步是
     * **锦上添花**，坏了绝不能影响插件本身。
     *
     * @param ctx - 插件上下文。
     */
    function installLocale(ctx) {
      localeBound = null
      try {
        if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return
        ctx.locale.register(NS, { zh: ZH, en: EN })
        if (typeof ctx.locale.bind !== 'function') return
        var translate = ctx.locale.bind(NS)
        if (typeof translate !== 'function' || typeof Proxy !== 'function') return
        /* 现有调用点都是 `L.section` 这种取属性的写法，用 Proxy 适配成取词调用。 */
        localeBound = new Proxy(
          {},
          {
            get: function (_target, key) {
              return translate(String(key))
            },
          },
        )
      } catch (error) {
        localeBound = null
      }
    }

    // ------------------------------------------------------------------ //
    // 状态判定
    // ------------------------------------------------------------------ //
    /** 取「真正持有焦点」的元素，穿透 shadow DOM（富文本编辑器常在内层）。 */
    function deepActiveElement() {
      var el = null
      try {
        el = document.activeElement
        var guard = 0
        while (el && el.shadowRoot && el.shadowRoot.activeElement && guard < 8) {
          el = el.shadowRoot.activeElement
          guard += 1
        }
      } catch (error) {
        return null
      }
      return el
    }

    function typingContext(event) {
      // 事件路径优先：能拿到真实目标，不受 shadow DOM 影响。
      try {
        if (event && typeof event.composedPath === 'function') {
          var path = event.composedPath()
          for (var i = 0; i < path.length; i += 1) {
            var node = path[i]
            if (node && node.tagName) {
              var t = node.tagName
              if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || node.isContentEditable === true) {
                return true
              }
            }
          }
        }
      } catch (error) {
        /* 回落到 activeElement */
      }
      var el = deepActiveElement()
      if (!el) return false
      var tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
    }

    function dialogOpen() {
      try {
        return !!document.querySelector('[role="dialog"],[aria-modal="true"]')
      } catch (error) {
        return false
      }
    }

    /** 状态订阅者（设置面板挂载期间登记），让面板不必自己再开一条轮询。 */
    var stateWatchers = []

    /** 把最近一次窗口状态推给订阅者。单个订阅者出错不能影响别人。 */
    function publishState() {
      for (var i = 0; i < stateWatchers.length; i += 1) {
        try {
          stateWatchers[i](lastState)
        } catch (error) {
          /* 某个订阅者坏了不影响其余 */
        }
      }
    }

    /** 读一次窗口状态并缓存，供 Esc 判断与设置页显示共用。 */
    function refreshState() {
      var api = bridge()
      if (!api) return Promise.resolve(lastState)
      try {
        return Promise.resolve(api.state()).then(
          function (value) {
            lastState = {
              fullscreen: !!(value && value.fullscreen === true),
              maximized: !!(value && value.maximized === true),
              /* v3 起桥才会回报这两项，旧桥上是 undefined —— 用 !! 兜成 false。 */
              minimized: !!(value && value.minimized === true),
              top: !!(value && value.top === true),
            }
            publishState()
            return lastState
          },
          function () {
            return lastState
          },
        )
      } catch (error) {
        return Promise.resolve(lastState)
      }
    }

    /**
     * 低频轮询窗口状态，让 Esc 与设置页始终有准确数据。
     *
     * 全插件只有这一处轮询：设置面板通过 `stateWatchers` 订阅它，不再自己开第二条
     * （面板打开时早先是两条并行轮询，等于每次刷新打两次 IPC）。页面隐藏时跳过 ——
     * 那时既没有 Esc 要判，也没人看设置页。
     */
    function installStatePoll() {
      refreshState()
      var timer = window.setInterval(function () {
        try {
          if (document.hidden) return
        } catch (error) {
          /* 没有 document.hidden 就照常轮询 */
        }
        if (!readConfig().enabled) return
        refreshState()
      }, 1500)
      return function () {
        window.clearInterval(timer)
        stateWatchers = []
      }
    }

    // ------------------------------------------------------------------ //
    // 行为：启动自动铺满（最大化 / 真全屏）
    // ------------------------------------------------------------------ //
    function applyStartMode() {
      var cfg = readConfig()
      if (!cfg.enabled || cfg.startMode === 'off') return function () {}
      var want = cfg.startMode
      var attempts = 0
      var timer
      var stopped = false
      /**
       * 把一次桥调用包成「不抛」的 Promise，并用 `{ ok, value }` 区分两种结果：
       * `ok: false` 是调用失败（桥报错），与「桥返回了 falsy」是两回事 —— 后者在
       * 不同桥版本上含义不同（v2/v3 回传真实窗口状态），不能混为一谈。
       */
      var call = function (fn) {
        try {
          return Promise.resolve(fn()).then(
            function (value) {
              return { ok: true, value: value }
            },
            function () {
              return { ok: false, value: undefined }
            },
          )
        } catch (error) {
          return Promise.resolve({ ok: false, value: undefined })
        }
      }
      var run = function () {
        if (stopped) return
        var live = readConfig()
        if (!live.enabled || live.startMode !== want) return
        var api = bridge()
        if (api) {
          attempts += 1
          refreshState()
            .then(function (state) {
              // 先退掉与目标冲突的另一种状态，避免「全屏里最大化」这类叠加。
              if (want === 'maximized' && state.fullscreen) {
                return call(function () {
                  return api.setFullscreen(false)
                }).then(function () {
                  return { fullscreen: false, maximized: state.maximized }
                })
              }
              if (want === 'fullscreen' && state.maximized) {
                return call(function () {
                  return api.setMaximized(false)
                }).then(function () {
                  return { fullscreen: state.fullscreen, maximized: false }
                })
              }
              return state
            })
            .then(function (state) {
              if (stopped || !state) return false
              if (want === 'maximized' && !state.maximized) {
                return call(function () {
                  return api.setMaximized(true)
                }).then(function (done) {
                  /* 调用失败、或桥明确说「没成」都要重试；其余视为已到位（新版桥可能不回传值）。 */
                  if (!done.ok || done.value === false) return false
                  appliedMode = 'maximized'
                  return true
                })
              }
              if (want === 'fullscreen' && !state.fullscreen) {
                return call(function () {
                  return api.setFullscreen(true)
                }).then(function (done) {
                  if (!done.ok || done.value === false) return false
                  appliedMode = 'fullscreen'
                  return true
                })
              }
              return true
            })
            .then(function (converged) {
              /* 已经到位就停：早先这里无条件重试 10 轮，等于每次启动白打 9 次 IPC。 */
              if (stopped || converged === true) return
              if (attempts < 10) timer = window.setTimeout(run, 400)
            })
          return
        }
        attempts += 1
        // 无桥时没必要死等：桥不可能在本次运行中出现（它需要重启才生效）。
        if (attempts < 3) timer = window.setTimeout(run, 600)
      }
      run()
      return function () {
        stopped = true
        if (timer) window.clearTimeout(timer)
      }
    }

    // ------------------------------------------------------------------ //
    // 行为：启动时恢复「窗口置顶」
    // ------------------------------------------------------------------ //
    /**
     * 启动时补一次窗口置顶。
     *
     * 窗口状态不跨进程保留（重启后就是普通窗口），但配置里的 `alwaysOnTop` 是用户
     * 明确勾过的偏好。早先它只被写进 localStorage、没有任何地方读，于是重启后置顶
     * 悄悄消失、开关显示关闭，而配置里还写着 true —— 死配置。
     *
     * @returns {Function} 清理函数。
     */
    function applyAlwaysOnTop() {
      var cfg = readConfig()
      if (!cfg.enabled || !cfg.alwaysOnTop) return function () {}
      var attempts = 0
      var timer = null
      var stopped = false
      var retry = function () {
        if (stopped || attempts >= 5) return
        timer = window.setTimeout(run, 500)
      }
      /* 桥明确回传 false 才算失败；回传 undefined（未来官方通道）按成功处理。 */
      var done = function (value) {
        if (value !== false) {
          lastState = {
            fullscreen: lastState.fullscreen,
            maximized: lastState.maximized,
            minimized: lastState.minimized,
            top: true,
          }
          publishState()
          return
        }
        retry()
      }
      var run = function () {
        if (stopped) return
        var live = readConfig()
        /* 用户中途关掉了开关（或总开关）就不再补。 */
        if (!live.enabled || !live.alwaysOnTop) return
        var api = bridge()
        /* 旧桥没有这条通道：本次运行内不可能出现，不用等。 */
        if (!api || typeof api.setTop !== 'function') return
        attempts += 1
        try {
          Promise.resolve(api.setTop(true)).then(done, retry)
        } catch (error) {
          retry()
        }
      }
      run()
      return function () {
        stopped = true
        if (timer) window.clearTimeout(timer)
      }
    }

    /**
     * 停用插件时撤销它造成的窗口状态，让界面回到「未安装本插件」的样子。
     * 只撤销本插件自己改过的状态，不碰用户手动调过的窗口。
     */
    function revokePluginEffects() {
      var mode = appliedMode
      appliedMode = null
      var api = bridge()
      if (!api) return
      /*
       * 置顶跟「启动时铺满」是两回事：可能只开了置顶、从没铺满过。所以单独撤销，
       * 不能挂在 `mode` 那个分支下面，否则这种情况下停用了插件还留着置顶。
       */
      if (lastState.top && typeof api.setTop === 'function') {
        try {
          Promise.resolve(api.setTop(false)).then(
            function () {},
            function () {},
          )
        } catch (error) {
          /* ignore */
        }
      }
      if (!mode) return
      try {
        var result = mode === 'fullscreen' ? api.setFullscreen(false) : api.setMaximized(false)
        Promise.resolve(result).then(
          function () {},
          function () {},
        )
      } catch (error) {
        /* ignore */
      }
    }

    // ------------------------------------------------------------------ //
    // 行为：退出（永远先确认）
    // ------------------------------------------------------------------ //
    /**
     * 退出 DeepSeek Harness，**总是先让用户确认**。
     *
     * DSH 自带的退出确认是**有条件的**：只有存活的会话任务或已武装的定时提醒才会弹框，
     * 空闲时 `before-quit` 直接放行 → 按 Esc 会静默退出。所以这里自己弹一次：
     * 桥 v2 让主进程用 `dialog.showMessageBox` 弹**原生**框，确认后才退出（并且会置位
     * `skipQuitConfirmation`，避免 DSH 再弹第二次）；桥是 v1（没有原生确认能力）时退回
     * 浏览器原生 confirm。完全没有桥时这条通道根本无法执行，函数直接返回 false ——
     * 那种情况下窗口按钮是禁用的，不存在“绕过确认就退出”的路径。
     *
     * @returns {boolean} 是否真的发起了退出请求
     */
    function requestQuit() {
      if (quitPending) return false
      var api = bridge()
      if (!api) return false
      var L = strings()

      /*
       * v2 起才有「主进程弹原生确认框」的能力，所以判断是 >= 2 而不是 === 2：
       * 写死等于 2 的话，v3 桥装上之后反而会退化到下面的 window.confirm 兜底。
       */
      if (typeof api.v === 'number' && api.v >= 2) {
        quitPending = true
        var options = {
          type: 'question',
          noLink: true,
          defaultId: 0,
          cancelId: 1,
          buttons: [L.quitConfirm, L.cancel],
          title: L.quitTitle,
          message: L.quitMessage,
          detail: L.quitDetail,
        }
        var done = function () {
          quitPending = false
        }
        try {
          Promise.resolve(api.quit(options)).then(done, done)
        } catch (error) {
          done()
        }
        return true
      }

      // 旧桥 / 异常：仍要确认，用浏览器原生 confirm 兜底
      var ok = false
      try {
        ok = window.confirm(L.quitMessage + '\n\n' + L.quitDetail)
      } catch (error) {
        ok = false
      }
      if (!ok) return false
      try {
        api.quit()
      } catch (error) {
        /* ignore */
      }
      return true
    }

    // ------------------------------------------------------------------ //
    // 行为：Esc 退出
    // ------------------------------------------------------------------ //
    /**
     * 判断一次按键是否命中「退出快捷键」。
     *
     * @param event - 键盘事件。
     * @param cfg - 当前配置。
     * @returns 命中为 true。
     */
    function matchesQuitKey(event, cfg) {
      var mode = cfg.quitKey
      if (mode === 'off') return false
      if (mode === 'ctrl+q') {
        if (!(event.ctrlKey || event.metaKey)) return false
        if (event.altKey || event.shiftKey) return false
        return String(event.key || '').toLowerCase() === 'q'
      }
      if (event.key !== 'Escape' && event.key !== 'Esc') return false
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
      if (mode === 'double-escape') {
        /* 第一下只记时间，第二下（在窗口期内）才真正触发。 */
        var now = Date.now()
        if (now - lastEscapeAt > DOUBLE_ESCAPE_MS) {
          lastEscapeAt = now
          return false
        }
        lastEscapeAt = 0
        return true
      }
      return true
    }

    function installEscQuit() {
      var exitFullscreen = function () {
        var win = bridge()
        if (!win) return
        try {
          Promise.resolve(win.setFullscreen(false)).then(
            function () {},
            function () {},
          )
          lastState = {
            fullscreen: false,
            maximized: lastState.maximized,
            minimized: lastState.minimized,
            top: lastState.top,
          }
        } catch (error) {
          /* ignore */
        }
      }
      var onKey = function (event) {
        var cfg = readConfig()
        if (!cfg.enabled) return
        if (event.isComposing || event.repeat === true) return
        if (event.defaultPrevented === true) return
        var plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        var isEsc = event.key === 'Escape' || event.key === 'Esc'
        /*
         * 真全屏下 Windows 会隐藏右上角窗口按钮，此时 Esc 必须有出口 —— 这与
         * 「退出快捷键」配成什么无关，所以这里始终认 Esc。
         */
        if (isEsc && plain && cfg.escExitFullscreen && lastState.fullscreen) {
          exitFullscreen()
          return
        }
        if (!cfg.escQuit) return
        if (!matchesQuitKey(event, cfg)) return
        if (cfg.escGuarded && (typingContext(event) || dialogOpen())) return
        // 先弹确认框，确认后才真正退出；不 preventDefault，应用自身的 Esc 行为照旧。
        requestQuit()
      }
      window.addEventListener('keydown', onKey, true)
      return function () {
        window.removeEventListener('keydown', onKey, true)
      }
    }

    // ------------------------------------------------------------------ //
    // 样式
    // ------------------------------------------------------------------ //
    var wrap = {
      padding: '4px 16px 18px',
      fontSize: '14px',
      lineHeight: '22px',
    }
    var introStyle = {
      padding: '10px 16px 6px',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #999)',
    }
    var groupTitle = {
      padding: '16px 0 6px',
      fontSize: '12px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-secondary, #999)',
    }
    var row = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '12px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
    }
    var rowText = { display: 'flex', flexDirection: 'column', gap: '2px' }
    var note = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' }
    var btn = {
      padding: '6px 12px',
      fontSize: '13px',
      lineHeight: '18px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    var btnDanger = {
      padding: '6px 12px',
      fontSize: '13px',
      lineHeight: '18px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'transparent',
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    var card = {
      margin: '12px 0 4px',
      padding: '12px 14px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-state-warn-primary, #d9a441)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(217,164,65,0.08))',
    }
    /** 排障卡片里的原因列表：保持和 note 同样的字号，只补缩进与间距。 */
    var list = { margin: '6px 0', paddingLeft: '18px' }
    var listItem = { fontSize: '12px', lineHeight: '18px', marginBottom: '4px', color: 'var(--dsw-alias-label-secondary, #999)' }
    var segWrap = {
      display: 'inline-flex',
      flexShrink: 0,
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    }
    var segBtn = {
      padding: '5px 10px',
      fontSize: '13px',
      lineHeight: '18px',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    var segBtnActive = {
      padding: '5px 10px',
      fontSize: '13px',
      lineHeight: '18px',
      border: 'none',
      background: 'var(--dsw-alias-brand-primary, #4c8bf5)',
      color: '#fff',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function Switch(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked,
          onClick: function () {
            if (props.disabled) return
            props.onChange(!props.checked)
          },
          disabled: props.disabled === true,
          style: {
            position: 'relative',
            flexShrink: 0,
            width: '40px',
            height: '22px',
            borderRadius: '11px',
            border: 'none',
            cursor: props.disabled ? 'not-allowed' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
            background: props.checked
              ? 'var(--dsw-alias-brand-primary, #4c8bf5)'
              : 'var(--dsw-alias-label-secondary, #666)',
            transition: 'background 0.15s',
          },
        },
        React.createElement('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: props.checked ? '20px' : '2px',
            width: '18px',
            height: '18px',
            borderRadius: '9px',
            background: '#fff',
            transition: 'left 0.15s',
          },
        }),
      )
    }

    /** 三选一的分段控件（最大化 / 真全屏 / 不自动）。 */
    function Segmented(props) {
      return React.createElement(
        'div',
        { style: segWrap, role: 'radiogroup' },
        props.options.map(function (option) {
          var active = option.value === props.value
          return React.createElement(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'radio',
              'aria-checked': active,
              title: option.title || undefined,
              onClick: function () {
                props.onChange(option.value)
              },
              style: active ? segBtnActive : segBtn,
            },
            option.label,
          )
        }),
      )
    }

    function SwitchRow(props) {
      return React.createElement(
        'div',
        { style: row },
        React.createElement(
          'div',
          { style: rowText },
          React.createElement(
            'div',
            { style: props.emphasis ? { fontWeight: 600 } : null },
            props.title,
          ),
          props.note ? React.createElement('div', { style: note }, props.note) : null,
        ),
        React.createElement(Switch, {
          checked: props.checked,
          onChange: props.onChange,
          disabled: props.disabled,
        }),
      )
    }

    /**
     * 桥是否提供 v3 才有的能力（最小化 / 置顶）。
     *
     * 用户可能还带着旧版桥（比如刚升级插件但没重启 DSH），此时这些按钮点了也没用，
     * 不如直接禁用并给出提示。
     */
    function supportsV3() {
      var api = bridge()
      return !!api && typeof api.setMinimized === 'function' && typeof api.setTop === 'function'
    }

    function Panel() {
      var L = strings()
      var state = React.useState(readConfig)
      var cfg = state[0]
      var setCfg = state[1]
      var statusState = React.useState('')
      var status = statusState[0]
      var setStatus = statusState[1]
      var liveState = React.useState({
        available: bridge() !== null,
        fullscreen: false,
        maximized: false,
        minimized: false,
        top: false,
      })
      var live = liveState[0]
      var setLive = liveState[1]
      /** 连续几次启动没读到桥（≥ NOBRIDGE_ALARM 时改为显示排障卡片）。 */
      var misses = countNoBridge()

      React.useEffect(function () {
        var api = bridge()
        if (!api) {
          setLive({ available: false, fullscreen: false, maximized: false, minimized: false, top: false })
          return undefined
        }
        /* 订阅全局那一条轮询（见 installStatePoll），不再自己开第二条。 */
        var sync = function (state) {
          setLive({
            available: true,
            fullscreen: state.fullscreen,
            maximized: state.maximized,
            minimized: state.minimized,
            top: state.top,
          })
        }
        stateWatchers.push(sync)
        refreshState()
        return function () {
          var at = stateWatchers.indexOf(sync)
          if (at >= 0) stateWatchers.splice(at, 1)
        }
      }, [])

      React.useEffect(
        function () {
          var onChanged = function (event) {
            if (event && event.detail) setCfg(event.detail)
            else setCfg(readConfig())
          }
          window.addEventListener('dsh-window-control:changed', onChanged)
          return function () {
            window.removeEventListener('dsh-window-control:changed', onChanged)
          }
        },
        [],
      )

      var update = function (patch) {
        var next = {
          enabled: cfg.enabled,
          startMode: cfg.startMode,
          escQuit: cfg.escQuit,
          escGuarded: cfg.escGuarded,
          escExitFullscreen: cfg.escExitFullscreen,
          quitKey: cfg.quitKey,
          alwaysOnTop: cfg.alwaysOnTop,
        }
        Object.keys(patch).forEach(function (key) {
          next[key] = patch[key]
        })
        writeConfig(next)
        setCfg(next)
      }

      /**
       * 改了「启动时自动铺满」后立刻生效。
       *
       * 两个方向的处理是不同的：
       *   - 选「最大化 / 真全屏」：这是用户的明确指令，无条件应用。
       *   - 选「不自动」：只撤销本插件自己造成的窗口状态（`appliedMode` 非空时），
       *     不去动用户自己手动摆好的窗口。
       *
       * 早先两个方向共用同一个 `appliedMode` 守卫，于是「启动时不铺满 → 后来改成
       * 最大化」会被静默忽略：界面切过去了，窗口却纹丝不动。
       *
       * @param value - 新的启动模式。
       */
      var reapplyNow = function (value) {
        var api = bridge()
        if (!api) return
        var safe = function (fn) {
          try {
            return Promise.resolve(fn()).then(
              function () {},
              function () {},
            )
          } catch (error) {
            return Promise.resolve()
          }
        }
        var chain = Promise.resolve()

        if (value === 'off') {
          /* 插件这次没铺满过，窗口是用户自己的摆法，不该被插件动。 */
          if (!appliedMode) return
          appliedMode = null
          chain
            .then(function () {
              return safe(function () {
                return api.setFullscreen(false)
              })
            })
            .then(function () {
              return safe(function () {
                return api.setMaximized(false)
              })
            })
          return
        }

        if (value === 'fullscreen') {
          chain = chain.then(function () {
            return safe(function () {
              return api.setFullscreen(true)
            })
          })
        } else {
          /* 先退全屏再最大化，避免「全屏里最大化」这种叠加状态。 */
          chain = chain
            .then(function () {
              return safe(function () {
                return api.setFullscreen(false)
              })
            })
            .then(function () {
              return safe(function () {
                return api.setMaximized(true)
              })
            })
        }
        chain.then(
          function () {
            appliedMode = value
            /* 立即回读一次：让 Esc 判断拿到新的全屏/最大化状态，不用等下一轮轮询。 */
            refreshState()
          },
          function () {},
        )
      }

      var call = function (label, action) {
        var api = bridge()
        if (!api) return
        setStatus(L.working)
        try {
          Promise.resolve(action(api)).then(
            function () {
              setStatus('')
              /* 按钮改完窗口就回读一次：否则 Esc 要等到下一轮轮询才知道“现在全屏了”。 */
              refreshState()
            },
            function (error) {
              setStatus(L.failed + ': ' + String((error && error.message) || error))
            },
          )
        } catch (error) {
          setStatus(L.failed + ': ' + String((error && error.message) || error))
        }
      }

      /**
       * 把排障信息复制到剪贴板。
       *
       * 用户报障时最有用的就是这几行：装的是哪一版、期望的桥版本、连续几次没读到、
       * 运行环境。渲染端拿不到宿主状态文件的内容，但至少能让人一键带走这些上下文。
       */
      var copyDiagnostics = function () {
        var ua = '-'
        try {
          ua = String((window.navigator && window.navigator.userAgent) || '-')
        } catch (error) {
          /* ignore */
        }
        var lines = [
          'dsh-window-control v' + PLUGIN_VERSION,
          'bridge: expected v' + String(EXPECTED_BRIDGE) + ', active: none',
          'launches without bridge: ' + String(misses),
          'userAgent: ' + ua,
          'status file: ' + STATUS_FILE,
          'at: ' + new Date().toISOString(),
        ]
        copyText(lines.join('\n'), function (result) {
          setStatus(result === 'ok' ? L.copied : L.copyFailed)
        })
      }

      var children = []

      children.push(React.createElement('div', { key: 'intro', style: introStyle }, L.intro))

      // 总开关：关掉后本区块只剩这一个开关 + 说明，插件彻底停止干预。
      children.push(
        React.createElement(SwitchRow, {
          key: 'master',
          emphasis: true,
          title: L.master,
          note: L.masterNote,
          checked: cfg.enabled,
          onChange: function (value) {
            /* 关总开关时顺手清掉「启动补置顶」的偏好，免得下次开机又自己置顶。 */
            update(value ? { enabled: true } : { enabled: false, alwaysOnTop: false })
            if (!value) revokePluginEffects()
          },
        }),
      )

      if (!cfg.enabled) {
        children.push(
          React.createElement(
            'div',
            { key: 'disabled', style: card },
            React.createElement(
              'div',
              { style: { fontWeight: 600, marginBottom: '4px' } },
              L.disabledTitle,
            ),
            React.createElement('div', { style: note }, L.disabledBody),
          ),
        )
        return React.createElement('div', { style: wrap }, children)
      }

      if (!live.available) {
        /*
         * 两种「没读到桥」要分开讲：
         *   - 刚装完的 1~2 次：只是还没生效（通道写入后要下次启动才载入），重启即可。
         *   - 到 NOBRIDGE_ALARM 次：基本可以判定自动安装被挡住了 —— 再让人重启就是让人
         *     空转，所以改成把常见原因和自查办法直接列出来，并给一段可复制的排障信息。
         */
        if (misses >= NOBRIDGE_ALARM) {
          var causes = [L.issuePerm, L.issueMac, L.issueAv, L.issueVersion]
          children.push(
            React.createElement(
              'div',
              { key: 'nobridge', style: card },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, L.issueTitle),
              React.createElement('div', { style: note }, fill(L.issueBody, { n: misses })),
              React.createElement(
                'ul',
                { style: list },
                causes.map(function (text, index) {
                  return React.createElement('li', { key: 'c' + String(index), style: listItem }, text)
                }),
              ),
              React.createElement('div', { style: note }, fill(L.diagWhere, { p: STATUS_FILE })),
              React.createElement('div', { style: note }, L.diagCmd),
              React.createElement('button', { type: 'button', style: btn, onClick: copyDiagnostics }, L.copyDiag),
            ),
          )
        } else {
          children.push(
            React.createElement(
              'div',
              { key: 'nobridge', style: card },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, L.noBridgeTitle),
              React.createElement('div', { style: note }, L.noBridgeBody),
            ),
          )
        }
      }

      children.push(React.createElement('div', { key: 'g1', style: groupTitle }, L.windowGroup))
      children.push(
        React.createElement(
          'div',
          { key: 'fullscreen', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.stateNow),
            React.createElement(
              'div',
              { style: note },
              L.fs + '：' + (live.fullscreen ? L.on : L.off) + '　' + L.mx + '：' + (live.maximized ? L.on : L.off),
            ),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: btn,
              disabled: !live.available,
              onClick: function () {
                call('fs', function (api) {
                  return api.setFullscreen(!live.fullscreen)
                })
              },
            },
            live.fullscreen ? L.exitFullscreen : L.fullscreen,
          ),
        ),
      )
      children.push(
        React.createElement(
          'div',
          { key: 'maximize', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.maximize),
            React.createElement('div', { style: note }, L.maximizeNote),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: btn,
              disabled: !live.available,
              onClick: function () {
                call('mx', function (api) {
                  return api.setMaximized(!live.maximized)
                })
              },
            },
            live.maximized ? L.restore : L.maximize,
          ),
        ),
      )
      children.push(
        React.createElement(
          'div',
          { key: 'minimize', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.minimize),
            React.createElement('div', { style: note }, L.minimizeNote),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: btn,
              /* 最小化 / 置顶是 v3 桥才有的能力，旧桥上直接禁用而不是点了没反应。 */
              disabled: !live.available || !supportsV3(),
              onClick: function () {
                call('mn', function (api) {
                  return api.setMinimized(true)
                })
              },
            },
            L.minimize,
          ),
        ),
      )
      children.push(
        React.createElement(SwitchRow, {
          key: 'swTop',
          title: L.alwaysOnTop,
          note: L.alwaysOnTopNote,
          checked: !!live.top,
          disabled: !live.available || !supportsV3(),
          onChange: function (value) {
            update({ alwaysOnTop: value })
            call('top', function (api) {
              return api.setTop(value)
            })
          },
        }),
      )

      children.push(React.createElement('div', { key: 'g2', style: groupTitle }, L.quitGroup))
      children.push(
        React.createElement(
          'div',
          { key: 'quit', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.quit),
            React.createElement('div', { style: note }, L.quitNote),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: btnDanger,
              disabled: !live.available,
              onClick: function () {
                requestQuit()
              },
            },
            L.quit,
          ),
        ),
      )
      children.push(
        React.createElement(SwitchRow, {
          key: 'sw1',
          title: L.escQuit,
          note: L.escQuitNote,
          checked: cfg.escQuit,
          onChange: function (value) {
            update({ escQuit: value })
          },
        }),
      )
      children.push(
        React.createElement(SwitchRow, {
          key: 'sw2',
          title: L.escGuarded,
          note: L.escGuardedNote,
          checked: cfg.escGuarded,
          onChange: function (value) {
            update({ escGuarded: value })
          },
        }),
      )
      children.push(
        React.createElement(
          'div',
          { key: 'escfs' },
          React.createElement(SwitchRow, {
            title: L.escExitFullscreen,
            note: L.escExitFullscreenNote,
            checked: cfg.escExitFullscreen,
            onChange: function (value) {
              update({ escExitFullscreen: value })
            },
          }),
        ),
      )
      children.push(
        React.createElement(
          'div',
          { key: 'quitkey', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.quitKey),
            React.createElement('div', { style: note }, L.quitKeyNote),
          ),
          React.createElement(Segmented, {
            value: cfg.quitKey,
            options: [
              { value: 'escape', label: L.keyEscape, title: L.quitKeyNote },
              { value: 'double-escape', label: L.keyDoubleEscape, title: L.quitKeyNote },
              { value: 'ctrl+q', label: L.keyCtrlQ, title: L.quitKeyNote },
              { value: 'off', label: L.keyOff, title: L.quitKeyNote },
            ],
            onChange: function (value) {
              update({ quitKey: value })
            },
          }),
        ),
      )

      children.push(React.createElement('div', { key: 'g3', style: groupTitle }, L.startupGroup))
      children.push(
        React.createElement(
          'div',
          { key: 'startmode', style: row },
          React.createElement(
            'div',
            { style: rowText },
            React.createElement('div', null, L.startMode),
            React.createElement('div', { style: note }, L.startModeNote),
          ),
          React.createElement(Segmented, {
            value: cfg.startMode,
            options: [
              { value: 'maximized', label: L.modeMaximized, title: L.modeMaximizedTip },
              { value: 'fullscreen', label: L.modeFullscreen, title: L.modeFullscreenTip },
              { value: 'off', label: L.modeOff, title: L.modeOff },
            ],
            onChange: function (value) {
              update({ startMode: value })
              reapplyNow(value)
            },
          }),
        ),
      )
      if (cfg.startMode === 'fullscreen') {
        children.push(
          React.createElement(
            'div',
            { key: 'fswarn', style: card },
            React.createElement(
              'div',
              { style: { fontWeight: 600, marginBottom: '4px' } },
              L.fullscreenWarnTitle,
            ),
            React.createElement('div', { style: note }, L.fullscreenWarnBody),
          ),
        )
      }

      if (status) {
        children.push(
          React.createElement('div', { key: 'status', style: { paddingTop: '10px', ...note } }, status),
        )
      }

      return React.createElement('div', { style: wrap }, children)
    }

    /** 兜底：任何渲染异常都变成文案，绝不空白。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
      render() {
        if (this.state.error !== undefined) {
          return React.createElement(
            'div',
            { style: { padding: '14px 16px', ...note } },
            '窗口与退出设置页加载失败：' + this.state.error,
          )
        }
        return this.props.children
      }
    }

    function apply(ctx) {
      /* 接入 locale 是锦上添花，任何异常都不该影响下面的主体。 */
      try {
        installLocale(ctx)
      } catch (error) {
        localeBound = null
      }

      /*
       * 清单里声明了 `immediately`，本模块可能在插槽服务就绪之前就被加载；插槽没就绪
       * 只意味着设置页这一项挂不上，其余功能（启动铺满、Esc 处理）必须照常工作。
       */
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'window-control',
              order: 90,
              label: function () {
                return strings().section
              },
            },
            function Section() {
              return React.createElement(Boundary, null, React.createElement(Panel, null))
            },
          )
        })
      } catch (error) {
        /* 设置页挂不上就挂不上，绝不能连带把插件本身弄挂 */
      }

      var behaviors = [
        [installStatePoll, 'window-control: window state poll'],
        [applyStartMode, 'window-control: fill screen on launch'],
        [applyAlwaysOnTop, 'window-control: keep window on top'],
        [installEscQuit, 'window-control: esc handling'],
      ]
      behaviors.forEach(function (pair) {
        try {
          ctx.effect(pair[0], pair[1])
        } catch (error) {
          /* 单个行为注册失败不影响其余两个 */
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
