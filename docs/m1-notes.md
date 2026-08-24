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
- 原生依赖 stub 化清单：node-pty、sharp（模块可加载、调用即抛）；koffi 保持真身（win32 FFI 路径 PC 冒烟用，安卓上 sandbox 行已禁不触达）。
