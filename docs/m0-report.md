# M0 尖兵验证报告

日期：2026-08-23
状态：**核心通过**（沙盒 syscall 探测一项待 NDK 就绪后补测）

## 验证结论

| 项 | 结果 | 证据 |
|---|---|---|
| termux nodejs-lts ELF 可在 Android 上 exec | ✅ | 模拟器 android-36 x86_64，`Status: ok / LaunchState: COLD` |
| `process.platform === 'android'`（非 linux） | ✅ 实证 | probe 输出 `platform=android` |
| Node 版本满足 engines `^22.19 \|\| >=24` | ✅ | `node=v24.18.0`（termux nodejs-lts，比 PLAN D1 原拟的 22 更新） |
| 内置 `node:sqlite` 可用（零原生编译） | ✅ | `sqlite_x=42`（建表/插入/查询往返） |
| 全部依赖经 jniLibs 投放 + dynstr 改名补丁后可链接 | ✅ | exit=0；bionic 仅报 glibc 风格 DT 标签的 unused 警告（无害） |
| PT_LOAD 16K 对齐 | ✅（静态） | 17 个上游 ELF 全部 `min PT_LOAD align = 16K`（docs/m0-elf-report.md） |
| 沙盒 syscall 失败形态取证 | ⏳ 待办 | 需 NDK 编译 probe 二进制（landlock_create_ruleset / unshare(CLONE_NEWUSER)）；决策 D5 不阻塞 |

probe 输出原文：`RESULT platform=android arch=x64 node=v24.18.0 sqlite_x=42` + `exit=0`

## 交付物

- `dist\dsh-spike-debug.apk`（63.5MB，arm64-v8a + x86_64 双 ABI，已签名）
- `runtime\jniLibs\{arm64-v8a,x86_64}\` 各 10 个文件 + `jnilibs-manifest.json`
- `runtime\tools\`：closure.py（apt 闭包解析）、elfcheck.py（ELF 审计）、assemble_jnilibs.py（SONAME 闭包装配 + dynstr 补丁）、hashtags.py
- `assembly\add_to_apk.py`、`scripts\build-apk.ps1`（无 Gradle 手动流水线：javac → d8 → aapt2 → zip → zipalign → apksigner）

## 关键技术记录

### 1. 运行时来源与装配
- 直接消费 termux 稳定源已发布产物（nodejs-lts 24.18.0-1 及 8 个依赖 deb），sha256 全量校验。自建交叉编译保留为后续选项，当前不必要。
- 最小运行时闭包按 **DT_SONAME 解析**（非文件名），BFS 自 node 起，跳过 bionic 系统库白名单。

### 2. dynstr 改名补丁（本项目自有技术点）
AGP/安装器要求 jniLibs 文件名匹配 `lib*.so`，而 NEEDED 引用版本化 soname（`libcrypto.so.3` 等）。方案：把所有名字缩短为去版本形式，并在 `.dynstr` 中原位改写对应字符串——替换长度必须严格等于「旧串 + NUL 终止符」，offset 全部保持不变。
> 教训：首版实现少算终止符长度，每处替换使文件缩短 1 字节并整体左移，node（5 处替换）当场损坏为 `empty/missing DT_HASH`。修复后补丁函数带「patch 后 dynamic section 可读」自检。

### 3. W^X 合规
manifest 设 `android:extractNativeLibs="true"` + targetSdk 34，二进制以 `lib*.so` 形态经 jniLibs 落在只读 `nativeLibraryDir` 并 exec 成功——验证了绕过 targetSdk≥29 可写目录 exec 禁令的标准路径。

### 4. 运行时环境注入
spawn 时设 `LD_LIBRARY_PATH=<nativeLibraryDir>`、`HOME/TMPDIR` 指向 app 私有目录、`SSL_CERT_FILE` 指向随包分发的 CA bundle（取自 ca-certificates 包，装配脚本自动暂存为 `ca-cert.pem`）。

## 环境踩坑记录

1. **旧 AVD `soloclaw_test` 已损坏**：对任何第三方应用（含它自己预装的应用）都报 `Activity class does not exist`，系统应用正常；重启/root/appops 均无效。新建 AVD 后同一 APK 一次通过。遇到此症状直接换 AVD。
2. `Performing Incremental Install` 与安装后立即 `am start` 存在竞态观感，统一用 `--no-incremental` 规避。
3. Windows 下 bsdtar 可直解 .deb（ar）双层包；javac/d8 的参数数组不要用 `@var` 展开。

## M0 收尾清单

- [x] 双架构 jniLibs 装配 + 审计全绿
- [x] APK 构建/签名/安装/启动全链路
- [x] node exec + node:sqlite 探针通过（模拟器）
- [x] **真机 arm64 复测**：2026-08-23 用户旗舰真机（arm64/16K 内核页）侧载 `dist\dsh-spike-debug.apk` 一次通过，RESULT 行与模拟器一致（`arch=arm64`），10 个 so 全部从 `nativeLibraryDir` 加载
- [ ] 沙盒 probe C 二进制（landlock/unshare/exec-from-writable 三探针）：待 `sdkmanager "ndk;27.*"` 后编译，产物走同一 jniLibs 通道
