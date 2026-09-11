# dsh-android — DeepSeek Harness 安卓移植

把 [DeepSeek Harness](https://github.com/deepseek-ai)（`@deepseek-ai/dsh`，Node 24 + TypeScript 的 AI agent 运行时）移植为**独立安卓 APK**：Node 运行时、agent 循环、Web GUI 全部在手机本地运行，工具调用（bash / 文件读写 / 网络检索 / 图像理解）在本机真实执行，并通过 loopback Bridge 把系统能力（通知、剪贴板、分享、SAF、设备操控）以 DSH 工具面暴露给模型。

- **上游零分叉**：`deepseek-harness` 源码一行不改，所有适配都是构建期文本补丁（锚点 fail-loud）或运行期自举。
- **真机验收**：realme RMX3888（Android 16 / SDK 36），2026-08-26 通过 M1 端到端与 M2 工具面两轮验收。
- **上游基线**：`@deepseek-ai/dsh-root` 0.1.0-rc.5；Node 24.18.0（termux 产物，sha256 + ELF 审计，16KB 页对齐 17/17）。

## 仓库结构

```
PLAN.md              目标 / 架构 / 7 条 ADR / 里程碑与验收标准（先读这个）
docs/
  m0-report.md       M0 尖兵验证：node ELF 上真机、sqlite 可用、ELF 审计
  m0-elf-report.md   16KB 页对齐与 ELF 审计明细
  m1-notes.md        M1 装配与真机验收全程（最厚的排障笔记）
  m2-notes.md        M2 Bridge 工具面全程（含厂商 ROM 差异）
  patches.md         ⭐ 补丁兼容性总账：改了什么 / 为什么 / 上游升级怎么重推导
patches/
  android.patch.yml  装配层覆盖：bash-sandbox→bash-local 完整换栈等
android-app/         Java 壳（FGS / WebView / BridgeServer）——仅 3 个文件
assembly/            装配链核心：androidize_payload.py、sharp-shim、验收驱动脚本
runtime/             Node/bash/rg 闭包解析与 jniLibs 投放（termux 配方裁剪）
scripts/             rebuild-payload.ps1 全链重建、build-apk.ps1 打包、probe
```

## 架构

```
┌─ APK ────────────────────────────────────────────────────┐
│  Java 壳：FGS 保活 + 常驻通知                              │
│  ├─ BridgeServer：手写 HTTP/1.1 loopback JSON 服务 :3081   │
│  │    （通知/剪贴板/分享/SAF/设备信息，结构化错误契约）       │
│  ├─ WebView → http://127.0.0.1:<dshPort>（dsh web GUI）    │
│  └─ ProcessBuilder → node ELF（jniLibs 投放，              │
│       从 nativeLibraryDir 执行）→ dsh web                   │
│  数据：App 私有目录；密钥→环境注入（M3 迁 Keystore）        │
└───────────────────────────────────────────────────────────┘
```

启动链：`libnode_dsh.so --expose-internals bin.js web --host 127.0.0.1 --port <N>`，就绪标志 `dsh web: http://127.0.0.1:<port>`；patch 经 `.dsh/profiles/web/cordis.patch.yml` 生效（`web` 子命令禁 `--patch`）。

## 移植为什么难（六条硬约束，全部有实证）

| # | 约束 | 后果 | 对策 |
|---|---|---|---|
| 1 | 安卓无内核沙盒 runner：bwrap 需 user namespace（SELinux 拒绝 App 域），Landlock syscall 对 untrusted app 拦截 | 每个 shell 调用 fail-closed 抛 `SANDBOX_UNAVAILABLE` | `android.patch.yml` 完整换栈 bash-sandbox→bash-local（照 Windows 全权配方，两行都动） |
| 2 | `process.platform === 'android'`，上游 `PLATFORM_CHAINS` 只认 linux/darwin/win32 | 平台链查空 | patch 层门控 + 构建期裁剪 terminal 行 |
| 3 | npm 按 `os` 字段选包，landlock 平台包 `os:['linux']` | android 上装不上 | 装配期丢弃 optionalDeps，走上游认可的 no-platform-package fail-closed 配置 |
| 4 | targetSdk ≥ 29 禁止从 App 可写存储 exec 二进制 | 自带 bash/rg 无法从 files/ 执行 | jniLibs 投放 + `extractNativeLibs=true`，从 `nativeLibraryDir` exec；`files/bin/bash -> libbash.so` 符号链接前插 PATH |
| 5 | 加固 OEM ROM（realme/MIUI）SELinux 拒绝 App 私有目录内 `hardlink(2)` | `write` 成功 `edit` 失败的反直觉分裂 | `link→rename` 回退补丁 ×3（session/fs/attachment），保留 EEXIST 摘要校验 |
| 6 | bionic ≠ glibc/musl：sharp(libvips)/node-pty/koffi 预编译绑定不可加载 | read_image / 终端 / FFI 全挂在模块加载期 | sharp→纯 JS 像素管线垫片（jpeg-js/pngjs/omggif）；node-pty/koffi→惰性抛错 stub;koffi 构造器返回哑 token（上游模块作用域急切调用 `koffi.pointer`）|

每条的详细排障叙事在 [docs/patches.md](docs/patches.md) 与 [docs/m1-notes.md](docs/m1-notes.md)。

## 真机验收证据（RMX3888，2026-08-26）

**M1 端到端**（`assembly/m1-{accept,multiturn,image}.mjs` 经 loopback RPC 直驱）：

| 项 | 证据 |
|---|---|
| 真实模型对话 | reasoning + `OK`，turn/end completed（2558 in / 35 out tokens） |
| bash 工具 | `pwd && uname -m` → `/data/data/dev.dsh.spike/files/workspace`、`aarch64` |
| fs write | 落盘文件与 bash 输出逐字节一致 |
| web_search | 返回带真实引用的检索结果 |
| read_image | 测试图像素级描述全对（sharp v2 垫片真机通过） |

**M2 工具面**（17 工具注册；`m2-accept.mjs` + `tier1-accept.mjs` 驱动）：

- 基础批 5/5：device_info / notify（真实通知 60504）/ clipboard 写读逐字节一致 / share_text 拉起系统面板；锁屏态 `CLIPBOARD_BLOCKED` 干净拒绝，模型正确引导。
- 第一档 10 项全部产出正确结构化结果：list_apps 枚举、launch_app 拉起 Settings、volume 真实变更、torch 真实亮灭、open_url、dial、以及 vibrate/brightness/set_alarm——**后三项在 ColorOS 被 appops 拒绝，按"拒绝路径干净"计 PASS**（`BRIDGE_ERROR:<code>` 结构化转述，模型如实告知用户）。自动化门槛设 ≥7，容忍厂商 ROM 差异。

## 验证体系（全部可重跑）

- **sharp-shim 19 例**（`assembly/sharp-shim/test/`）：`gen-fixtures.js` 确定性生成 10 张 fixture（渐变照片/截图/全不透明 RGBA 陷阱/透明 UI/动画 GIF/EXIF6…），`run-test.mjs` 直接 import **部署包**的 `dsh-attachment-local/lib/index.js`（含全部补丁）走生产全链路。
- **ELF 审计**：`runtime/tools/elfcheck.py` 静态审计全部投放二进制的 PT_LOAD 对齐（16KB 页要求）。
- **真机冒烟**：`assembly/smoke-probe2.mjs`、`smoke-applist.mjs`、热部署单文件迭代（<1 分钟/轮）。
- **上游升级 SOP**（docs/patches.md §五）：`rebuild-payload.ps1` 全链重建即回归门；文本锚点补丁一律 fail-loud——锚点漂移时报错带函数名，绝不静默产出半适配 payload。

## 构建

```powershell
# 前提：上游 checkout 可构建、pnpm、python、Android SDK(build-tools 35/platforms 36)
pwsh -File scripts\rebuild-payload.ps1   # worktree→stage→pack→pnpm deploy→补丁→runtime.zip
pwsh -File scripts\build-apk.ps1         # javac→d8→aapt2→zip→zipalign→apksigner → dist\dsh-debug.apk
```

`androidize_payload.py` 是补丁总入口（main() 按序执行全部补丁，幂等可重跑）；debug keystore 缺失时 `build-apk.ps1` 自动 `keytool` 生成（不入库）。

## 已知边界（诚实清单）

- 无内核级沙盒：工具在手机全权执行（ADR D5 与用户知情同意；App 层逐工具确认对话框列 M4）。
- 密钥暂存 SharedPreferences/凭据文件，Keystore 迁移列 M3。
- WebP 像素解码/编码不可用（头解析可用）；透明+高色数图编码受限于 IMAGE_TOO_LARGE 收缩终止。
- 厂商省电策略杀后台（HyperOS 冻结连 FGS 一起冻），白名单引导列 M3。
- M5 设备操控（无障碍桥 / Shizuku）已立项待排期。
- API key 走用户自带 provider（模型与中转均可配置）。

## 许可证

本项目为其上游项目的安卓移植层；各第三方组件遵循其原许可证（sharp-shim 内 vendored 的 jpeg-js/pngjs/omggif 均带 MIT/BSD 许可证头）。上游 `deepseek-harness` 的许可证条款同样适用于其产物在本仓库装配形态下的使用。
