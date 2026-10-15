# 发布指南（照着做即可）

本文记录把本插件发布到 DSH 插件市场的完整步骤。**共三步**，其中只有第 1 步需要用到命令行。

> 关键结论先说：**DSH 插件市场（dshmarket / dshmarket.com）自己不收插件。**
> 它的目录来自社区精选列表 **awesome-dsh-plugin**（约 4200+ 插件的那个）。
> 所以"上架"= 往那个列表提一个 PR，通常一天内自动出现在市场和站点上。

---

## 第 1 步：把代码推到 GitHub

仓库地址：`https://github.com/YunLiZeMeng/dsh-window-control`

本机没有安装独立的 Git，只有 WorkBuddy 自带的一份。因此在 PowerShell 里**必须写完整路径**
（下面这条命令已经在真实环境验证过，git 2.55 + 自带 GitHub 登录组件 2.9.0）：

```powershell
& "C:\Users\19881\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe" -C "C:\Users\19881\WorkBuddy\main\dsh-window-control" push -u origin main
```

- 会弹出 GitHub 登录窗口 → **Sign in with your browser** → 浏览器里点 **Authorize**
- 出现 `main -> main` 即成功；凭据会被记住，**以后只要再跑一遍这条命令就行**
- 如果报网络错误（`Failed to connect to github.com` / `CONNECT tunnel failed`），先开代理/VPN 再重试；
  仍是失败就换个时间试，该链路本身不稳定

**备用方案（完全不想碰命令行）**：在浏览器打开空仓库页面，点 `uploading an existing file`，
把项目里的 `lib`、`locale`、`screenshots` 三个文件夹和其余文件一起拖进去上传。
缺点是 GitHub 会另起一个提交，本地历史与远端分叉，更新版本时麻烦一点。

---

## 第 2 步：给仓库加 `dsh-plugin` 标签

收录要求之一，CI 会检查。

1. 打开 `https://github.com/YunLiZeMeng/dsh-window-control`
2. 右上角 **⚙️ (About 栏右侧的齿轮图标)**
3. **Topics** 一栏输入 `dsh-plugin` → 回车 → 再输 `deepseek-harness`、`dsh` 都行
4. 点 **Save changes**

---

## 第 3 步：提交收录 PR（纯网页操作，不需要 Git）

**时间要求：仓库必须创建满 1 天，CI 才会通过。**
本仓库创建于 2026-10-15 09:45 UTC（北京时间 17:45），
所以请**在 2026-10-16 17:45（北京时间）之后再提 PR**，早一分钟都可能被自动拒。

### 3.1 创建 PR 文件

1. 打开 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 右上角点 **Fork**（在自己的账号下建一个副本，几秒完成）
3. 在副本页面进入 `data/plugins/` 目录
4. 点 **Add file → Create new file**
5. 文件名填（**必须完全一致**）：

   ```
   YunLiZeMeng__dsh-window-control.yml
   ```

6. 内容原样粘贴：

   ```yaml
   url: https://github.com/YunLiZeMeng/dsh-window-control
   name: YunLiZeMeng/dsh-window-control
   category: ui
   description:
     en: 'Adds a Window & Quit page to DSH settings - choose maximize or true fullscreen on launch, minimize, keep the window always on top, and quit with a native confirmation dialog (Esc, double Esc, or Ctrl+Q).'
     zh: '在 DSH 设置里加一页「窗口与退出」：启动时可选最大化或真全屏，支持最小化、窗口置顶，以及按 Esc（或双击 Esc / Ctrl+Q）弹出原生确认框后再退出。'
   ```

   > ⚠️ 描述里**不能出现 `: `（半角冒号+空格）**，否则 YAML 会解析失败。
   > 上面两条都加了单引号，既避开冒号问题，也让 `&`、`#` 这类符号绝对安全 —— **请连引号一起复制**。

7. 页面下方点 **Commit changes**，标题保持默认即可

### 3.2 发起 PR

1. 回到自己的副本首页，会看到黄色提示条 **Contribute → Open pull request**
2. 标题填：

   ```
   Add YunLiZeMeng/dsh-window-control
   ```

3. 说明栏（可选）写一句：插件的用途 + 一句"首次安装需要重启两次 DSH"（这条能给评审和用户省事）
4. 点 **Create pull request**

此后 CI 会依次检查 5 项（条目数 ≤3 / `dsh.bundle` 声明 / 仓库年龄 ≥1 天 / awesome-lint / 站点构建）。
**任何一项失败，PR 里会明确写出要改什么**，你在同一分支上改了再推就行，不用重开 PR。
通过后由维护者人工核对描述与代码是否相符，然后合并 —— 合并后市场与站点**自动收录**，通常一天内生效。

---

## 我们的插件逐条对照（为什么应该能过）

| CI / 评审项 | 本插件情况 |
|---|---|
| `dsh.bundle` manifest | ✅ `package.json` 里有 `dsh.bundle.patch = ./cordis.patch.yml` |
| `cordis.patch.yml` 形态 | ✅ `- insert: - id: dsh-window-control / name: dsh-window-control` |
| 真实可用的代码 | ✅ 5500+ 行，含两套自测（渲染端 76 项、桥引擎 48 项） |
| 仓库满 1 天 | ⏳ 见上，10-16 17:45 之后 |
| `dsh-plugin` 标签 | ⏳ 第 2 步 |
| 描述属实 | ✅ 描述里的每项能力都对应真实代码；未用夸张词 |
| 分类贴切 | ✅ `ui`（UI 增强），窗口控制属于界面行为 |
| 截图声明 | ✅ 仓库根目录已有 `screenshots.json`，指向 2 张设置页截图 |

---

## 可选：发布到 npm（不影响收录）

收录**不要求** npm。发到 npm 的唯一好处是市场能显示下载量。

如果要做：需要 npm 账号，然后在项目目录执行 `npm publish`。
注意 `package.json` 的 `repository` 字段必须指回本仓库 —— **我们已经填好了**，符合官方要求。

另一种可选做法：把打包好的 `dsh-window-control-1.4.1.tgz` 挂到 GitHub Release，
并在条目里加 `tarball:` 字段。仅在"仓库无法从源码安装"时才是必需的，本插件不属于这种情况。

---

## 以后更新版本怎么发

改了代码之后：

1. `package.json` 里的 `version` +1（例如 1.4.1 → 1.4.2）
2. `CHANGELOG.md` 顶部加一节
3. 跑一遍自测：`node _selftest.mjs && node _bridge-selftest.mjs`
4. 用第 1 步那条命令推送

收录列表**不用重新提 PR** —— 它只记仓库地址，用户装到的永远是最新代码。
只有仓库地址变了、或想改描述/分类时才需要回去改那个 yml 文件。
