# M1 装配笔记（进行中）

## 启动契约（已实证）

- 官方打包形态：全量 workspace 包 pack 成 npm tarball → consumer 目录 `npm install` → `node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port N`。
- 就绪标志：stdout 出现 `dsh web: http://127.0.0.1:<port>`。
- 环境契约（scripts/publish-npm-baseline.ts 同款）：`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED=1`、`DEEPSEEK_API_KEY`、`LANG/LC_ALL/TERM/COLUMNS/LINES`；本机追加 `DSH_PERMISSION_MODE=danger-full-access`、`SSL_CERT_FILE`、`LD_LIBRARY_PATH`、`HOME/TMPDIR`。

## Windows 主机上的离线装配路径（与上游 npm-baseline 的差异）

上游 baseline 依赖私服 registry + POSIX 探针。本项目离线等价实现：

1. **分离 worktree**（主检出有未提交改动，不可原地 stage）+ 从主检出 robocopy 已构建 `lib/`、`dist/`（git-ignore 产物，无冲突）。
2. **stage**（assembly/stage_worktree.py）：去 private、内部依赖钉到各自版本（landlock entry 是独立版本线）、丢弃 landlock 平台包 optionalDeps（Windows 无法产 musl 二进制；entry 单包 = 上游文档认可的 no-platform-package fail-closed 配置）。
3. `pnpm -r pack` → 231 个 tarball。
4. consumer 根用中性 manifest + `npm install --force`（vendored cordis 的 peerOptional 版本范围与 loader 实际版本在 workspace 里被链接掩盖，npm 严格模式会拒；--force 与 workspace 现实一致）。npm 装 231 个 file: 包在 Windows 上 12 分钟后崩溃（exit 134），弃用。
5. **最终方案 = pnpm deploy --legacy --prod** + assembly/complete_peers.py 补齐：
   - deploy 不物化 peer（npm 才会）；permission/sharp/koffi 等链条全靠它补。
   - patch-only 包（如 dsh-bash-local，无任何包声明依赖）从工作区源码树提升（自带已构建 lib/dist）。
   - fixpoint 迭代物化被提升源码包的全部外部依赖（zod、@earendil-works/pi-ai 等）。
   - 坑：copy_real 曾 ignore "src"，误伤 koffi（其运行时代码就在 src/koffi/）。
6. PC 冒烟通过：`READY port 31186`（含 android.patch.yml 换栈 + attachment-local/sandbox/permission 三禁用）。

## android.patch.yml 设计（patches/android.patch.yml）

| 行 | 处置 | 原因 |
|---|---|---|
| bash-sandbox | disabled | 无内核 runner（bwrap userns 被 SELinux 封；Landlock syscall 被拦），fail-closed 逼出换栈 |
| sandbox | disabled | 其模块导入链拉 koffi（FFI），无 bionic 绑定；bash-local 下 provider 闲置 |
| permission | disabled | presets 强制要求受限执行器（"does not confine" fail-loud）；danger-full-access 语义下无意义 |
| approval | 保持（env 切 never） | base 的 policy 表达式读 DSH_PERMISSION_MODE |
| attachment-local | disabled | sharp 预编译 libvips 只有 glibc/musl，bionic 无法加载 |
| directory-picker | 钉 browse 变体 | auto 解析可达 native 变体（koffi Win32 对话框） |
| bash-local | insert | 本地子进程执行器，timeoutMs=60000 |

tool-bash/tool-fs 等 win32 门控行在 android 上天然落 POSIX 分支，无需触碰。

## 打包与部署

- runtime.zip（~173MB / ~7.5 万文件）：payload + android.patch.yml + ca-cert.pem（zip 根）。
- **junction 坑**：pnpm deploy 的 node_modules 充满 Windows junction；python os.walk 默认不深入 → zip 里全是空目录（真机报 ERR_MODULE_NOT_FOUND '@deepseek-ai/dsh-app-boot'）。make_runtime_zip.py 用 scandir 显式下钻 + realpath 环路保护重写。
- Kotlin 侧：FGS 首启解压 zip 到 files/runtime；patch 移动到 `.dsh/profiles/web/cordis.patch.yml`（web 子命令禁止 --patch 参数）；cert 移动到 etc/tls/cert.pem。
- API key 注入顺序：start-intent extra（无头测试钩子）→ SharedPreferences → files/api_key.txt。

## 待验证

- [x] 模拟器端到端 READY + WebView 加载 GUI HTML（2026-08-23：HTTP 200，`__DSH_BOOT__` 38 插件名册，node 子进程稳定）
- [x] adb forward 后 PC curl 首页（13080→3080）
- [ ] 真机安装 + 真实 API key 对话验收（用户侧）
- [ ] bash/fs/web 工具各一例的真实会话证据

## 启动链最终形态（关键参数）

`libnode_dsh.so --expose-internals node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080`

- `--expose-internals` 必需：boot 后 profile-boot 无条件挂 watch-only HMR（配置热重载契约），其服务要求 loader internals。
- patch 经 `.dsh/profiles/web/cordis.patch.yml` 生效（web 子命令禁 --patch）；loader 会把编译产物写在该目录旁。
- 原生依赖 stub 化清单：node-pty、sharp、koffi（模块可加载、原生调用即抛）。

## rc.2 真机回归两连修（2026-08-25 实证）

1. **koffi 顶层 import 炸启动**：上游 rc.2 给 dsh-subprocess-local 加了 Win32 进程树检查器
   （windows-inspector.js），`lib/index.js:121` 在**模块作用域**急切执行 `koffi.pointer("void")`，
   koffi 预编译绑定无 bionic/arm64 → loader entry `subprocess` 加载失败、整树拒绝启动
   （"Cannot find the native Koffi module"）。修法：androidize_payload.py 的 koffi stub 不能用
   惰性抛错版——类型描述符构造器（pointer/struct/array）返回哑 token，只有 load()/open() 抛错。
2. **spawn bash ENOENT**：bash-local 硬编码 `['bash','-c',cmd]`，原厂安卓 /system/bin 无 bash。
   自带 termux bash 就是 jniLibs 的 `libbash.so`，但名字不在 PATH 上。修法：DshService 启动时建
   `files/bin/bash -> <nativeLibraryDir>/libbash.so` 符号链接并前插 PATH；execve 穿过链接落在
   PM 管理的 lib 目录（targetSdk≥29 唯一豁免执行的位置），SELinux 放行。每次覆盖安装后安装路径
   变化，ensureBashOnPath 按 canonical path 比对自动重链。

真机验证证据（RMX3888，API 会话直驱）：bash `pwd` → `/data/data/dev.dsh.spike/files/workspace`
（isError:false）；`session.create {cwd:'/sdcard/Download'}` 会话中 touch/printf/ls/cat 全通，
文件落在 `/storage/emulated/0/Download`。GUI 侧入口 = 首页 "Choose workspace" 工作区选择器
（directory-picker browse 变体），配合 MANAGE_EXTERNAL_STORAGE 可绑定任意手机文件夹。

## 工作区选择器的手机存储桥（2026-08-25）

browse 选择器起点 = `homedir()`（安卓上被 DshService 设为 files/），且客户端 DirectoryBrowser
把家目录以上的面包屑折叠成"家"图标、家目录层无向上一级 → 手机存储不可达。修法：DshService
启动时建 `files/storage -> /storage/emulated/0` 符号链接（bridgePhoneStorage，失败不致命）。
选择器对符号链接做 stat 探测、目录即显示可进入行；进入后面包屑展开完整链可跳转。
RPC 实证：`host.listDirectory files/` 出现 storage 行；列 storage 返回真实手机目录与全链 crumbs。

## 自定义供应商 400 "developer role"（2026-08-25）

现象：vsllm 中转 + qwen3.8-max 思考档 xhigh，首轮即 400
`developer is not one of ['system','assistant','user','tool','function']`。

链条：pi-ai `openai-completions.js` 里
`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`；
已知厂商域名（deepseek.com 等）在 detectCompat 的 isNonStandard 名单内强制 system，
而未知中转 baseUrl **乐观默认 supportsDeveloperRole=true**；自研 per-model 思考强度功能
（cb295b72eb）给该模型置 reasoning → 系统提示词以 developer 角色发出 → 后端拒收。
PC 端"没事"只是因为没开思考档位，坑是跨平台的。

修复（纯配置，上游一等字段）：settings.yaml 模型条目加
`compat: { supportsDeveloperRole: false }`——角色回 system，思考不受影响
（reasoning_effort 由独立的 supportsReasoningEffort 控制）。真机复测 turn completed。

遗留两条：① UI 编辑器里关此开关未落盘 settings.yaml，需查 ui-settings-models 保存链路；
② 自研特性宜改为"未知端点默认 false"，显式声明才 true。

## read_image 修复（2026-08-25，sharp v2 纯 JS 垫片 + attachment-local 三补丁）

### 演进

v1 垫片只做头解析、像素操作全抛错 → read_image 卡在
`detectImage()` 的 `image.raw().toBuffer()`（复测报告《方案A复测报告.txt》）。
本轮实施完整像素管线（assembly/sharp-shim/，构建期整体拷入 payload）：

- 解码：jpeg-js（JPEG）、pngjs（PNG）、omggif（GIF 首帧）；WebP 保持仅头解析，
  像素访问抛 `SHIM_NO_WEBP_DECODE`。
- `metadata()`：与真实 sharp 同语义 —— 返回**未转置原始尺寸** + orientation 字段，
  转置由调用方 imageMetadata 负责（v1 在垫片里预转置导致双重转置，已修）。
  PNG/GIF 的 hasAlpha 做真实透明像素扫描（"有 alpha 平面但全不透明"必须报 false，
  否则调用方误入 webp-only 编码分支）。
- `resize(fit:'inside')`：盒式面积平均（kernel:nearest 时最近邻）；`rotate()` EXIF 2..8。
- 编码：jpeg-js（quality）/pngjs（colorType 2/6）。WeakMap 按 Buffer×格式缓存解码，
  一次 read_image 的 probe→detect→采样→多次编码尝试只解码一次。

### attachment-local 三补丁（androidize_payload.py）

1. `patch_attachment_webp_fallback`：两个 encode() 助手捕获 SHIM_NO_WEBP* 转为
   byteLength=MAX_SAFE_INTEGER 的超限候选——否则一个 webp 抛错会炸掉
   encodeFirstWithinLimit 的整条回退链（透明高色数图原本必死，现在干净走
   IMAGE_TOO_LARGE 收缩终止语义；低色数图正常落到 png/jpeg 分支）。
2. `patch_attachment_android_io`（io 部分）：
   - ensureDurableDirectory 从存储目录一路 fsync 祖先直到文件系统根 `/`，
     Android 上打开 /data/data（realpath /data/user/0）即 EACCES →
     祖先同步改 best-effort（忽略 EACCES/EPERM，其余照抛）。
   - commitPreparedImageFile 用 link(2) 发布对象，本机 SELinux 拒绝应用数据目录
     hardlink（同 session-jsonl 雷）→ link 失败（EPERM/EACCES/EXDEV/ENOSYS/EINVAL）
     回退 rename(2)，保留 EEXIST 摘要校验语义。
   - rename 回退会消耗 staging 文件，成功路径末尾无条件 unlink(temporary) 会
     ENOENT 把成功误报为 ATTACHMENT_WRITE_FAILED → 该 unlink 容忍 ENOENT。

### 本地验证（assembly/sharp-shim/test/）

gen-fixtures.js 生成 10 个确定性 fixture（渐变照片/RGB 截图/RAMA 全不透明陷阱/
真透明 UI/透明噪声/纯噪声/静态与动画 GIF/EXIF6 拼接/Windows 壁纸）；
run-test.mjs 直接 import **部署包**的 dsh-attachment-local/lib/index.js（含补丁），
走 prepareImageFile/readRequestImageFile 生产全链路 + 垫片单元断言。19/19 通过。

### 设备端到端（RMX3888, adb forward tcp:13080→tcp:3080）

- 热部署 deploy-v2.tgz（sharp 目录 + attachment-local/lib/index.js）→ force-stop 重启。
- JPEG（3840x2400 Windows 壁纸）：read_image 一次成功，规范化降采样 2048x1280，
  sha256 对象落 files/.dsh/attachments/v1/objects/d8/…，模型准确描述 Bloom 壁纸内容。
- PNG（720x1280 UI fixture）：pass-through 直通，模型像素级还原内容
  （绿色顶栏/白色列表行/深色页脚）。
- 请求图缓存说明：规范化结果已满足请求策略时 version.data === attachment.data，
  按设计跳过 request-images 缓存条目。

### 构建链固化

全部补丁收敛在 androidize_payload.py（sharp-shim 整目录拷贝 + 两函数补丁），
rebuild-payload.ps1 全链重建即自动包含；另修了该脚本 PS5.1 下 git/pnpm stderr
进度被 $ErrorActionPreference='Stop' 提升为终止错误的问题（git worktree add 去 2>&1，
pnpm 段落局部放宽 EAP）。

已知边界：WebP 像素解码/编码不可用（头解析可用）；透明+高色数图无法编码
（webp-only 分支，收缩后 IMAGE_TOO_LARGE）；pngjs 无调色板编码，低色数图的
palette PNG 由 truecolor RGB 替代（体积大些，功能等价）。
