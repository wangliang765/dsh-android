# DeepSeek Harness 安卓移植计划（dsh-android）

状态：草案 v1（待评审）
上游基线：`E:\code\deepseek-harness`（@deepseek-ai/dsh-root 0.1.0-rc.5）
目标设备档位：骁龙8系/天玑9系，RAM ≥ 12GB，Android 10+

---

## 1. 目标与非目标

### 目标
1. **独立 APK**：把 DeepSeek Harness 以原生安卓应用形态移植，Node 运行时、agent 循环、Web GUI 全部跑在手机上，不依赖 PC。
2. **工具调用在本机执行**：bash / 文件 / 网络检索等现有工具在手机本地真实执行（起步阶段无内核级沙盒，见决策 D5）。
3. **第二批交付安卓原生能力工具**：通知、分享接入、SAF 文件选择、相机、联系人/短信等，以 DSH toolkit 插件形式接入模型工具面。

### 非目标（本期）
- 内核级沙盒强制（Landlock/bwrap 在未 root 安卓上被 SELinux 拦截，fail-closed 设计下只能换非沙盒执行器；root 升级路径仅作文档记录）。
- iOS 或其他嵌入式平台。
- 上架 Google Play（SMS 类权限政策严苛，发布渠道待定：侧载 / F-Droid 优先）。
- 跨设备远程访问手机实例（上游 CLI 明确拒绝 `--host 0.0.0.0`；如需远程再评估受信任主机机制或隧道）。

## 2. 背景研究结论（已核实的关键事实）

### 2.1 对移植有利
- 全仓纯 TypeScript ESM + pnpm workspaces，engines `node ^22.19.0 || >=24.0.0`；主链路无第三方需编译原生模块——SQLite 用 Node 内置 `node:sqlite`（`packages/storage/storage-sqlite/src/unit.ts`）。
- 一切皆插件：平台差异走 cordis.yml patch 门控（范例：`packages/bundle/base/cordis.patch.yml` 的 `disabled: !!js process.platform === 'win32'`）。
- shell 执行器是能力接缝双实现：`bash-sandbox`（逐命令沙盒）与 `bash-local`(不受限本地子进程) 注册同一服务，配置级可换；Windows 主机即用此配方换 pwsh 栈（`packages/bundle/base/README.md` 有完整换栈配方，含"必须完整否则加载报错"的约束）。

### 2.2 核心障碍与证据
| # | 障碍 | 证据 |
|---|---|---|
| 1 | Termux/安卓 Node 上 `process.platform === 'android'` ≠ `'linux'`；`PLATFORM_CHAINS` 只认 linux/darwin/win32，android 查空 → 每个 shell 调用抛 `SANDBOX_UNAVAILABLE`（逐调用 fail-closed，`packages/sandbox/sandbox-local/src/index.ts`） | 代码已读 |
| 2 | npm 按 os 字段选包，`@deepseek-ai/node-addon-landlock-run-linux-arm64`（os:['linux']）在 android 上不会被安装 | landlock-run README + npm 平台选择规则 |
| 3 | 未 root 安卓上 Landlock 系统调用被拦截 | [termux-packages PR #19346](https://github.com/termux/termux-packages/pull/19346/files)：修复 liblzma 触发 `SYS_landlock_create_ruleset` 报错 |
| 4 | bwrap 依赖用户命名空间，App SELinux 域封死 | 公认事实，M0 可顺手实测 |
| 5 | targetSdk ≥ 29 禁止从 App 可写存储 exec 二进制；绕法 = jniLibs 投放 + `extractNativeLibs=true` + 从 `nativeLibraryDir` 执行 | [实践文章](https://chaosgoo.com/android-run-executable-binary-bypass/)、[SO 讨论](https://stackoverflow.com/questions/63800440/android-cant-execute-process-for-android-api-29-android-10-from-lib-arch) |
| 6 | nodejs-mobile 原版停更在 Node 18.x，违反 engines 要求；16KB 页对齐是未决问题 | [CHANGELOG](https://github.com/nodejs-mobile/nodejs-mobile/blob/main/doc_mobile/CHANGELOG.md)、[issue #148](https://github.com/nodejs-mobile/nodejs-mobile/issues/148) |

## 3. 架构

```
┌─ APK ─────────────────────────────────────────────────────┐
│  Kotlin 壳                                                 │
│  ├─ 前台 Service（FGS 保活 + 常驻通知）                     │
│  ├─ Android Bridge：loopback HTTP JSON 服务                │
│  │    （通知/分享接入/SAF/相机/短信…，挂权限矩阵）           │
│  ├─ WebView → http://127.0.0.1:<port>（dsh web GUI）       │
│  │    network security config 仅放行 127.0.0.1 明文        │
│  └─ ProcessBuilder ↓                                       │
│     node ELF（jniLibs 投放，nativeLibraryDir 启动）         │
│     └─ dsh 发行物（PC 预构建，assets 下发，首启解压）：      │
│        host/client 双面产物 + web 前端 dist                 │
│        + base bundle + android.patch.yml                   │
│  数据：app 私有目录（ext4/f2fs，支持符号链接、大小写敏感）   │
│  密钥：Keystore/EncryptedSharedPreferences → 注入进程环境   │
└───────────────────────────────────────────────────────────┘
```

进程模型要点：
- Node 以**独立子进程**运行（不做 JNI 绑定），崩溃可重启、日志可落盘。
- WebView 与 Node 服务同机回环通信；模型可见面与上游 Web GUI 完全一致，不另造 UI。
- Bridge 与 Node 的接口是本项目的自有契约：loopback HTTP JSON，schema 版本化。

## 4. 决策记录（ADR）

| # | 决策 | 理由 | 备选与放弃原因 |
|---|---|---|---|
| D1 | Node 运行时：优先消费 **termux 稳定源已发布产物**（nodejs-lts，sha256 校验 + ELF 审计），自建交叉编译保留为后备；当前版本 24.18.0（满足 engines `^22.19 \|\| >=24`） | termux 长期维护新版 Node 的安卓补丁集，产物已验证 16K 对齐、bionic 可链接；免维护交叉编译设施 | nodejs-mobile 原版停在 18.x ❌；capawesome fork 版本待核实 ⚠️ |
| D2 | 二进制投放：伪装 so 进 jniLibs（`libnode_dsh.so`），`extractNativeLibs="true"`，从 `nativeLibraryDir` exec；按 **16KB 页对齐**编译 | Android 10+ W^X 合规的唯一稳妥路径，全 targetSdk 适用 | 首启复制到 files/ 再 chmod exec ❌ targetSdk≥29 被 SELinux 拦 |
| D3 | UI 直接复用 dsh web GUI（WebView 回环加载） | 零 UI 重写；上游 GUI 已含 Host 信任、loopback 判定 | 自写原生 UI ❌ 工程量不成比例 |
| D4 | 工件策略：PC 构建工厂（上游 checkout `pnpm run build`）产出完整发行物打进 APK assets；**设备上不 pnpm install、不构建** | 手机端只做解压与启动，规避机上工具链/网络不确定性 | 机上克隆+构建 ❌ 慢且脆弱 |
| D5 | 起步阶段沙盒取舍：`android.patch.yml` 完整换栈（禁 `bash-sandbox`/`tool-bash` → 挂 `bash-local`）；用户已接受 | fail-closed 逼出的唯一可行起点；风险由 approval/permission 服务面缓解（与 Windows 全权主机同级） | root 改 sepolicy 后接 Landlock：列为后续升级路径，不阻塞主线 |
| D6 | 安卓原生工具：toolkit 形态插件 ↔ loopback Bridge ↔ Kotlin，分两批（低风险批 / 权限批） | 完全顺着上游插件哲学；Bridge 接口自有可控 | Termux:API 依赖 ❌ 引入外部 App 依赖，不可控 |
| D7 | 上游改动最小化：只回流「android 显式处理」类小改（见 §6），其余全部留在本项目仓库 | 上游是 Windows/macOS/Linux 三平台产品；安卓诉求先在本项目验证 | 大改上游 ❌ 未经验证前不污染上游 |

## 5. 本项目仓库规划

```
E:\code\dsh-android\
├─ PLAN.md              # 本文件
├─ runtime\             # Node 交叉编译：termux 配方裁剪 + 构建脚本 + 补丁集
├─ android-app\         # Kotlin 壳工程（Gradle）：FGS、Bridge、WebView、打包
├─ assembly\            # 装配脚本：从上游 checkout 取预构建产物 → assets 布局
├─ patches\             # cordis patch 层：android.patch.yml 等
├─ plugins\
│  └─ android-bridge-tools\   # toolkit 插件源码（对齐上游 dev_scaffold_plugin 产物形态）
└─ docs\                # 决策补充、真机适配记录、故障排查
```

## 6. 里程碑与验收标准

### M0 — 尖兵验证（预计 1~2 天）✅ 核心完成（2026-08-23，见 docs/m0-report.md）
任务：
1. 用 termux 配方交叉编译 Node 22 LTS arm64 ELF（含 16KB 对齐验证）。→ 改为直接消费 termux 已发布 nodejs-lts **24.18.0**（满足 engines，sha256 校验），自建编译降为后备选项
2. 最小 APK：jniLibs 投放 node → nativeLibraryDir exec → 跑通 `console.log(process.platform, process.arch, sqlite 可用性)`。→ 模拟器全通：`platform=android node=v24.18.0 sqlite_x=42 exit=0`
3. 实测 bwrap/userns 与 landlock syscall 在真机上的失败形态（留档，支撑 D5 与未来 root 升级路径文档）。→ ⏳ 待 NDK 编译 probe 二进制

验收：
- [x] 真机 APK 内 `process.platform === 'android'`、`node:sqlite` 加载成功（2026-08-23 用户真机 arm64 复现：`platform=android arch=arm64 node=v24.18.0 sqlite_x=42 exit=0`）
- [x] 16KB 对齐检查通过（静态 ELF 审计，17/17 = 16K）
- [ ] 沙盒 syscall 失败证据落盘 `docs/m0-sandbox-probe.md`

### M1 — 端到端（预计 1 周）✅ 完成（2026-08-26 真机验收，见 docs/m1-notes.md）
任务：
1. `assembly\`：从上游 checkout 构建 host/client 双面产物 + web dist，装配 assets 布局；首启解压到私有目录。→ 完成：worktree + stage + 231 tarball + pnpm deploy + complete_peers 补链（含 junction 下钻 zip）
2. `patches\android.patch.yml`：完整 bash-local 换栈（照 base README 配方，两行都动，避免加载报错）。→ 完成并扩展：sandbox/permission 禁用、directory-picker 钉 browse、subprocess/attachment 保留 + 原生依赖 stub 化
3. Kotlin FGS + ProcessBuilder 启动 `dsh web`，WebView 回环加载 GUI；DEEPSEEK_API_KEY 经 Keystore 注入。→ 完成（key 暂存 SharedPreferences/GUI 凭据文件，Keystore 迁移留 M3）
4. 真机完成一次多轮对话：bash 工具（本机执行）、文件读写（工作区=私有目录）、web 检索各至少一例。→ ✅ 全部通过（vsllm/qwen3.8-max xhigh；bash/fs-write/web_search/read_image 四工具真机证据）

验收：
- [x] 手机浏览器外无任何依赖，飞行模式外全程可用（除 LLM 网络本身）——模拟器实证，真机待复测
- [x] 杀掉 App 重开，会话持久化恢复（存储行挂载 ✓；会话级复测随真机验收）
- [x] shell 工具调用不再出现 `SANDBOX_UNAVAILABLE`（patch 生效：bash-local 挂载，启动树无 sandbox 依赖错误）
- [x] 真机多轮对话证据（bash/fs/web 各一例）（2026-08-26）

### M2 — 安卓原生工具（预计 1 周）✅ 完成（2026-08-26 真机验收，见 docs/m2-notes.md）
任务：
1. Bridge v1（低风险批）：系统通知、剪贴板、分享接入（ACTION_SEND→新会话）、SAF 文件选择回拷工作区。→ ✅ 完成 + 定向分享增强（packageName 直达目标 App 分享流 + share/targets 枚举）
2. `plugins\android-bridge-tools\` toolkit 插件：工具 schema 模型视角措辞、结果渲染意图声明（对齐上游 cookbook 的 UI render intent 规范）。→ ✅ 17 工具（@dsh-external/android-bridge-tools）
3. 第一档扩展（零权限）：launch_app/list_apps/open_url/volume×2/torch/vibrate/brightness/dial/set_alarm。→ ✅ 10/10 验收
4. Bridge v2（权限批，渠道定案后）：相机拍照回传、联系人、短信。→ ⏳ 移入 M5 按需

验收：
- [x] 模型能自主调用 ≥4 个安卓工具并拿到结构化结果（5/5 + 10/10 两轮真机证据）；
- [x] 权限拒绝路径有干净的工具错误反馈（CLIPBOARD_BLOCKED / NOTIFICATION_DENIED / PICK_TIMEOUT / ColorOS 三项 special-permission 全部结构化转述，模型正确引导用户）。

### M5 — 设备操控（调研后新增，待排期）
基于 E:\code\参考 八个开源 agent 项目的调研结论（docs/m2-notes.md 附调研摘要）：
1. 无障碍桥：AccessibilityService → Bridge `/a11y/*`（剪枝树快照+元素序号索引/gesture/input/screenshot），解锁 AI 操作微信/QQ 等 UI；
2. Shizuku 扩展：bindUserService + AIDL shell 服务（免 root），pm install/grant、uiautomator dump、am force-stop；顺带自动授予第一档被拒的三项 special permission；
3. 安全四层：工具级审批门 + 命令硬黑名单 + LoopGuard 同签名去重 + turn 墙钟预算（借鉴 rikkahub-agent）；
4. after 信封规范：动作后自动附 {foreground_pkg, screen_changed}，省一半观察性调用。

### M3 — 打磨与固化（时间随 M2 收尾）
- FGS 生命周期完善（Doze/厂商省电白名单指引）、崩溃自动重启与日志导出、密钥安全审查、
- 上游回流 PR：「android 平台显式处理」（PLATFORM_CHAINS 对未知 platform 的 fail-loud 语义 + 文档）、bash-local 换栈配方文档补安卓条目；
- 发布产物：可侧载 APK + 构建复现文档。

### M4 — App 层工具级确认对话框（待排期，暂不实施）

在 Kotlin 层（DshService / Bridge）拦截高危工具调用（bash 写操作、write/edit、web_fetch 等），弹原生确认框让用户逐条批准/拒绝。设计要点：

- 拦截层：Kotlin 侧监听 Node 的工具调用事件（loopback HTTP 或文件信号），高危类别触发 AlertDialog；
- 粒度：按工具名 + 参数摘要展示，用户可选"本次允许/永久允许此工具/拒绝"；
- 不改 DSH 内核层：approval 仍为 never（内核不做沙盒），纯 App UI 层安全网；
- 触发条件：仅对 `DSH_PERMISSION_MODE=danger-full-access` 生效；
- 前置依赖：M2 Bridge v1 的 loopback HTTP JSON 服务就绪后才有通信通道。

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自建 Node 运行时的长期维护（跟上游安全更新需重编） | 中 | 锁版本 + 订阅 Node 安全公告；termux 补丁集降低重编成本 |
| 厂商 ROM 杀后台 | 高（体验断连） | FGS+wakelock；白名单引导页；会话持久化兜底 |
| WebView 明文回环被安全策略收紧 | 低 | network security config 精确放行 127.0.0.1 |
| 无内核沙盒下模型命令全权执行 | 安全面扩大 | 用户已知情接受；approval/permission 服务保持默认开启 |
| 16KB 对齐/extractNativeLibs 细节回归 | 中 | M0 固化检查脚本进 CI（本项目自建轻量 CI 即可） |
| 上游 rc 阶段 API 变动 | 中 | assembly 脚本锁定上游 commit；升级走显式 bump 流程 |

## 8. 遗留对齐点（到达相应阶段前定案即可）

1. 发布渠道（Play vs 侧载/F-Droid）→ 决定 M2 权限批范围。
2. 最低支持 Android 版本（建议 API 29 起，W^X 语义统一）。
3. 是否需要"手机实例"被 PC/其他设备访问（当前上游明确拒绝 0.0.0.0，需隧道方案）。
4. root 设备上的 Landlock 强制升级路径是否立项。

## 9. 与上游的关系

- 上游 checkout（`E:\code\deepseek-harness`）作为**只读构建工厂**使用；本项目不在其工作树内堆安卓专用代码。
- 需要回流的改动（§6 M3 列出）单独整理 PR，遵循上游 AGENTS.md（Agent Note、快照测试、双语文档等门禁）。
