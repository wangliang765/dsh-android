# 补丁兼容性清单（Patch Compatibility Manifest）

本文件是 dsh-android 全部"安卓适配修改"的**唯一总账**。m1-notes.md 记录各轮
排查叙事；androidize_payload.py / android.patch.yml / DshService.java 是实现本体；
这里回答三个问题：**改了什么、为什么必须改、上游升级后怎么发现并重推导**。

上游源码零分叉——所有适配都是构建期后处理或运行期自举。升级流程见文末。

## 一、构建期补丁（assembly/androidize_payload.py，main() 按序执行）

| # | 函数 | 目标 | 类型 | 幂等标记 | 锚点漂移时的行为 |
|---|------|------|------|----------|------------------|
| 1 | `disable_terminal_rows` | config/agent-presets/*.cordis.yml | 装配行禁用 | 计数式（可重复跑） | 无锚点，按 id 匹配行 |
| 2 | `install_node_pty_stub` | node-pty | 全代理抛错 stub | 整目录重写 | 无（确定性覆写） |
| 3 | `install_native_stub` → `_install_sharp_js_shim` | sharp | **整目录替换**为 assembly/sharp-shim/ v2 | 整目录 rmtree 重写 | sharp-shim 源目录缺失 → RuntimeError |
| 4 | `install_koffi_stub` | koffi | 哑 token stub（load/open 抛错） | 整目录重写 | 无 |
| 5 | `patch_session_link_fallback` | @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js | link→rename 行为补丁 | `"ANDROID LINK FALLBACK"` | import 行或 publish block 不匹配 → SystemExit(函数名) |
| 6 | `patch_fs_local_write_link_fallback` | @deepseek-ai/dsh-fs-local/lib/index.js（.pnpm 内定位） | link→rename 行为补丁 | 同上标记 | writeFileAtomic block 不匹配 → SystemExit |
| 7 | `patch_attachment_webp_fallback` | @deepseek-ai/dsh-attachment-local/lib/index.js | encode()×2 异常转超限候选 | `"SHIM_NO_WEBP"` 出现即跳过 | head×2/tail×2 计数 ≠ 预期 → RuntimeError |
| 8 | `patch_attachment_android_io` | 同上 | 三子补丁：祖先 fsync 容错 / link→rename / 清理 unlink ENOENT | 三锚点各自独立判定；全命中才打印 already | 各锚点不存在则跳过该子补丁（全部已应用 = 幂等成功）|
| 9 | `install_ripgrep` | @vscode/ripgrep/lib/index.js（walk 全部副本）| 平台解析重写为绝对 rgPath + 下载 musl rg 二进制 | 确定性覆写 | 无锚点断言（walk 到即覆写）|
| 10 | `install_user_plugins` | node_modules/<plugin> | 从上游 packages/plugin/ 拷贝非闭包用户插件 | 存在即 rmtree 重拷 | 源缺失仅 WARN |

> 设计约定：**文本锚点补丁一律 fail-loud**（RuntimeError/SystemExit 带 "drifted; update …"
> 字样与函数名），宁可构建失败也绝不静默产出半适配 payload。

### 各补丁的 Android 根因（一句话版）

- **#2/#4**：node-pty/koffi 预编译绑定是 glibc/musl 的，bionic 无法加载；
  koffi 特殊在 rc.2 于模块作用域急切执行 `koffi.pointer("void")`，惰性抛错版仍会炸启动，
  故类型描述符构造器返回哑 token、仅 load()/open() 抛错。
- **#3 sharp v2**：libvips 预编译只有 glibc/musl/win32/darwin。v2 用 jpeg-js/pngjs/omggif
  实现解码、盒式面积平均缩放（kernel:nearest 时最近邻）、EXIF 2..8 旋转、JPEG/PNG 编码。
  `metadata()` 返回**原始未转置尺寸**+orientation（对齐真实 sharp，调用方负责转置——
  v1 预转置导致双重转置）。PNG/GIF hasAlpha 按**真实透明像素**扫描（全不透明的 RGBA
  必须报 false，否则调用方误入 webp-only 分支）。WeakMap 按 Buffer 缓存解码。
- **#5/#6**：加固型 OEM ROM（realme/MIUI SELinux）拒绝应用私有目录内的 hardlink(2)。
  write 新文件走 link(2) 必 EACCES 而 edit（rename）正常——这就是"edit 成功 write 失败"
  的原因。EACCES/EPERM 时回退 rename(2)，其余错误照原 guard 抛出。
- **#7**：垫片不能编码 WebP，但 attachment-local 的候选链混有 webp 尝试；单个候选抛错
  会中止整条 encodeFirstWithinLimit 回退。捕获 SHIM_NO_WEBP* 转为
  byteLength=MAX_SAFE_INTEGER 的"永不入选"候选，收缩循环语义保持不变。
- **#8a**：ensureDurableDirectory 从存储目录向上 fsync 祖先直到文件系统根 `/`；
  Android 打开 /data/data（realpath /data/user/0）必 EACCES → 祖先同步 best-effort
  （忽略 EACCES/EPERM，其余照抛）。
- **#8b**：同 #5/#6 根因，作用于附件对象发布路径，保留 EEXIST 摘要校验语义。
- **#8c**：rename 回退会消耗 staging 文件，成功路径末尾无条件 unlink(temporary) 会
  ENOENT 把已成功的发布误报为 ATTACHMENT_WRITE_FAILED → 该 unlink 容忍 ENOENT。
- **#9**：`process.platform === 'android'` 使 @vscode/ripgrep 找不到平台子包；
  直接把 lib/index.js 重写为指向 `/data/data/dev.dsh.spike/files/bin/rg` 的单行 stub。

## 二、装配层补丁（patches/android.patch.yml → 设备 .dsh/profiles/web/cordis.patch.yml）

| 行 | 处置 | 根因 |
|---|------|------|
| bash-sandbox | disabled | 无内核 runner：bwrap 需 userns（SELinux 拒），Landlock syscall 对应用域被拦；fail-closed 会饿死依赖方 |
| sandbox | disabled | OS-runner 导入 koffi（Win32 ACL 后端），bionic 无绑定；bash-local 接管执行器后闲置 |
| permission | disabled | presets 强制受限执行器（"does not confine" fail-loud）；danger-full-access 下无意义，DSH_PERMISSION_MODE 切 never |
| directory-picker | 钉 browse 变体 | auto 解析可达 native 变体（koffi Win32 对话框） |
| bash-local | insert | 本地子进程执行器（timeoutMs 60000）；两执行器族注册同名 bash 服务，配方必须完整 |
| dsh-plugin-toggle | insert | 用户插件：浏览器热启停 loader 条目（/dsh-plugin-toggle/list,set 路由） |
| dsh-vision-bridge | insert | 用户插件：analyze_image 工具，把图片发给视觉路由换文字结论 |

注意演进：早期版本曾禁用 attachment-local（sharp 无法加载时代）；自 sharp v2 起改为
**保持挂载**（host-apiproxy 依赖 attachments 服务，禁用会饿死依赖树）。

### 用户插件生效的两条腿（缺一不可）

fe403fc 只把插件拷进 payload node_modules——文件在场 ≠ 被装配：

1. **解析腿**：boot 时 `healProfilesModuleFallback`（dsh-app-boot）按
   @deepseek-ai/dsh 清单的**依赖闭包** BFS，把每个可达包 symlink 进
   `$DSH_HOME/profiles/node_modules` 平铺回退目录；loader 从 profile 目录解析
   条目名时靠父目录行走命中它。闭包外的包永远没有链接。
   → `install_user_plugins()` 把插件名追加进 `node_modules/@deepseek-ai/dsh/
   package.json` 的 dependencies（部署后清单编辑），BFS 自动建链。
2. **挂载腿**：android.patch.yml 的 `- insert:` 行。无行 = 包在 node_modules 里
   惰性存在，loader 树中根本没有条目。

PC 冒烟注意：Windows 宿主上 android.patch.yml 会让 pwsh-sandbox（win32 门控行）
等待被禁用的 sandbox 服务而启动失败——设备上该行不存在，无此冲突。本地冒烟用
`assembly/smoke-probe2.mjs`（SMOKE_EXTRA 环境变量传额外覆盖层禁掉 pwsh-sandbox），
通过 `/dsh-plugin-toggle/list` 自检挂载结果。

## 三、App 层运行时自举（DshService.java）

| 自举 | 内容 | 根因 |
|---|------|------|
| ensureBashOnPath | `files/bin/bash -> nativeLibraryDir/libbash.so` 符号链接 + PATH 前插（canonical path 变化时自动重链）| targetSdk≥29 仅 nativeLibraryDir 可执行；原厂无 /system/bin/bash |
| librg 同款链接 | `files/bin/rg -> librg.so` | 同上 |
| bridgePhoneStorage | `files/storage -> /storage/emulated/0` | browse 选择器以 homedir() 为起点，手机存储不可达 |
| fixExecPermissions | 解压后 chmod +x rg | zip 提取不保留执行位 |
| env 契约 | DSH_HOME/HOME/TMPDIR/SSL_CERT_FILE/LD_LIBRARY_PATH 等 | Node 与 DSH 的启动契约 |
| cert 注入 | ca-cert.pem → etc/tls/cert.pem | 安卓 CA 策略下 TLS 直连 LLM API |

## 四、配置层修复（用户设备 settings.yaml，不入构建链）

- 自定义中转 + reasoning 模型 400 "developer role"：模型条目加
  `compat: { supportsDeveloperRole: false }`（pi-ai 对未知 baseUrl 乐观默认 true）。

## 五、上游升级标准操作流程

1. 上游 `git pull` 后直接跑 `scripts\rebuild-payload.ps1`（全链重建，禁止新旧混装）。
2. 构建中途 fail-loud = 某个文本锚点漂移。报错信息含**函数名与 "drifted; update …"**：
   - 打开报错函数对应包的新版 `lib/index.js`；
   - 定位等价代码块（本文件的"根因"栏说明要保住什么行为）；
   - 更新该函数的 old/new 字符串，重跑直到全绿。
   - 无锚点断言的补丁（stub 类/ripgrep/插件拷贝）不会 drift，无需关注。
3. 回归门（顺序执行）：
   - 本地：`node assembly/sharp-shim/test/gen-fixtures.js && node assembly/sharp-shim/test/run-test.mjs`
     （19 例，直接 import **部署包**的 attachment-local，含全部补丁）；
   - 设备热部署：`assembly/sharp-shim/deploy-v2.tgz`（python tarfile 生成：sharp 目录 +
     att-index.js 两项）→ `run-as` 解到 files/runtime/node_modules → force-stop 重启；
   - 真机 read_image 冒烟（JPEG+PNG 各一）→ 通过后 `build-apk.ps1` 出正式包。
4. 幂等保证：所有补丁重复执行安全（整目录重写类天然幂等；文本类有标记/锚点判定）。

## 六、已知能力边界（fail-loud，不崩溃）

| 能力 | 状态 | 表现 |
|---|---|---|
| WebP 像素解码/编码 | 不可用 | 头解析可用；像素访问抛 SHIM_NO_WEBP_DECODE/ENCODE |
| 透明+高色数图 | 无法编码 | webp-only 分支全部落空 → 收缩终止 IMAGE_TOO_LARGE |
| palette PNG 输出 | 用 truecolor RGB 替代 | pngjs 无调色板编码器；体积更大功能等价 |
| pty 终端 | 不可用 | node-pty stub 抛错（presets 已禁终端行） |
| koffi FFI 面 | 仅类型构造可用 | load()/open() 抛错；现有 Android 路径均不触达 |
