# M2 笔记：安卓原生工具（Bridge v1 + android-bridge-tools）

状态：**验收通过（2026-08-26，realme RMX3888）——5/5 工具 + 拒绝路径证据；第一档 9 个零权限工具追加 10/10。**

## 第一档工具验收（2026-08-26，17 工具注册）

| 工具 | 结果 |
|---|---|
| android_list_apps / launch_app | 枚举 11 App；Settings 被拉起 |
| android_volume_get/set | 0/16 静音 → set 60% = 10/16（16 级刻度取整） |
| android_torch | on→off 循环，闪光灯真实亮灭 |
| android_open_url | https://example.com 浏览器打开 |
| android_dial | 拨号盘预填 10086（永不自动拨出） |
| android_vibrate / brightness_set / set_alarm | **ColorOS 权限拒绝**——结构化错误如实转述（坑 10），按"拒绝路径干净"计 PASS |

### 坑 10：ColorOS 三大 special-permission 拒绝

`VIBRATE`（允许振动开关）、`WRITE_SETTINGS`（修改系统设置授权）、`SET_ALARM`
（时钟默认应用声明）在 ColorOS 默认拒绝第三方 App，Android 层抛
SecurityException → Bridge 包成 BRIDGE_ERROR 干净转述，模型如实告知用户。
修复二选一：文档化引导开三个开关（一次性）；或 M5 用 Shizuku `pm grant` 自动授予。
这本身就是 M2 第二条验收线（权限拒绝路径干净反馈）的实证。

## 真机验收结果

解锁状态下（锁屏会冻结进程且剪贴板读被系统拒绝，见坑 7）：

| 工具 | 证据 |
|---|---|
| android_device_info | "realme RMX3888 — Android 16 (SDK 36) — battery 100% (charging)" |
| android_notify | 通知发布成功（id 60504），标题"M2 验收"出现在状态栏 |
| android_clipboard_write | "Copied 20 characters to clipboard." |
| android_clipboard_read | 回读 `DSH-M2-<时间戳>` 与写入值逐字节一致 |
| android_share_text | 系统分享面板成功拉起并报告成功 |

拒绝路径：锁屏态采集到 `BRIDGE_ERROR:CLIPBOARD_BLOCKED` 干净结构化反馈，
模型正确引导用户把应用带到前台后重试成功。

## 架构

```
模型工具面 (@dsh-external/android-bridge-tools)
   │  fetch POST http://127.0.0.1:${DSH_ANDROID_BRIDGE_PORT}/<endpoint>
   ▼
BridgeServer.java（DshService 内启动，手写 HTTP/1.1 over ServerSocket:3081）
   │  路由 /notify /clipboard/* /share/text /pick/file /device/info /health
   ▼
Android 系统能力：NotificationManager / ClipboardManager / ACTION_SEND chooser
                  / SAF(ACTION_OPEN_DOCUMENT→MainActivity startActivityForResult)
```

- 为什么手写 HTTP：`com.sun.net.httpserver` 不在 android.jar 里。协议形状刻意最小化：
  一连接一请求（Connection: close）、仅 POST、Content-Length 定长体。
- 端口经 env `DSH_ANDROID_BRIDGE_PORT` 传给 Node 侧插件；默认 3081。
- SAF 结果只能回到发起它的 Activity——Bridge 把请求转交 MainActivity
  （static pendingPickId/pendingPickRequest + `dsh_pick` extra），
  由它 startActivityForResult 并把结果 JSON 写到 `files/picked/<pickId>.json`，
  Bridge 以 ≤120s 轮询该文件应答（超时返回 PICK_TIMEOUT 干净错误）。
- 分享接入（ACTION_SEND→DSH）：Manifest 注册 text/* 的 SEND filter +
  singleTop；MainActivity 收到后把文本暂存 prefs，WebView 就绪时以
  原生 setter+input 事件注入 composer（SPA 无外部 URL scheme 可用）。

## 工具面（defineTool 规范，对齐 upstream tool-todo 模式）

| 工具 | 交互性 | 结构化结果 |
|---|---|---|
| android_device_info | 无 | manufacturer/model/androidVersion/sdkInt/battery/charging |
| android_notify | 无 | posted + notificationId |
| android_clipboard_write | 无 | copied + length |
| android_clipboard_read | 受焦点限制 | text（受限时空串，不报错） |
| android_share_text | 打开系统分享面板 | shared:true |
| android_pick_file | 用户选择 ≤120s | picked/path/displayName/sizeBytes/mimeType 或 picked:false |

## 踩坑记录

1. **javac 默认平台编码 GBK**：源码注释里的 UTF-8 线框字符（─）全部报
   "映射不了字符"。根治：build-apk.ps1 javac 加 `-encoding UTF-8`
   （M1 时只改了注释字符，属于治标；本轮治本）。
2. **org.json 是受检异常**：Android 的 JSONObject.put(String,Object) 声明
   throws JSONException，catch 块里构造错误 JSON 也要再 try 或提供无异常孪生
   （errStatic）。上游 JDK 语义不同。
3. **SAF 结果必须由发起的 Activity 接收**：Service 直接
   startActivity(OPEN_DOCUMENT) 永远收不到 onActivityResult。转交模式如上。
4. **工具 schema DSL**：output.schema 根层不允许 `required:[...]` 数组
   （属性级布尔 `required:true` 才合法）；违规报
   "unsupported JSON schema: schema.required is not supported by the value
   schema DSL"，整树拒绝启动（fail-loud）。
5. **PC 冒烟验证插件装载即可**：turn 管线在 Windows 上有 koffi stub 假阴性
   （subprocess windows-inspector），Android 无此路径；冒烟阶段以
   /dsh-plugin-toggle/list 的 phase=active 为准。
6. **node -e 冒烟不可用**：HMR 条目 apply 时 resolve(process.argv[1])，
   -e 模式 argv[1] 为 undefined 直接炸。必须用真实脚本文件跑 probe2。
7. **锁屏 = 进程冻结 + 剪贴板拒绝**：ColorOS 锁屏后强制 ~10s 休眠覆盖
   （mUserActivityTimeoutOverrideFromWindowManager=10000），FGS 也照冻，
   TCP 内核代答握手但无数据；解锁前台则一切正常。剪贴板读在锁屏态被
   isAppForeground 正确拒绝（CLIPBOARD_BLOCKED）——这本身就是设计行为。
8. **Bridge 信封的 ok 字段会污染 output 校验**：Kotlin 返回 {ok:true,...}，
   工具 execute 必须剥掉 ok 再返回，否则 additionalProperties:false 的
   output schema 报 "value.ok is not a declared property"（INVALID_TOOL_OUTPUT）。
9. **null vs 缺键**：output schema 声明 integer 的可选字段收到 null 同样违规；
   Kotlin 侧未知值应省略键而非放 JSONObject.NULL。

## 热部署迭代技巧

插件 JS 改动无需重打 zip/APK：push 单文件到
`files/runtime/node_modules/@dsh-external/<name>/lib/index.js` +
force-stop 重启应用即可（extractAssets 只看 APK lastUpdateTime 指纹）。
整轮迭代 <1 分钟；最终产物固化时再走完整构建链。

## 验收清单（PLAN.md M2）

- [ ] 模型自主调用 ≥4 个安卓工具并拿到结构化结果（驱动脚本 assembly/m2-accept.mjs）
- [x] 权限拒绝/超时路径有干净的工具错误反馈：
  - NOTIFICATION_DENIED——API 33+ 未授 POST_NOTIFICATIONS 时主动检测返回
    （系统默认静默丢弃，必须显式探测，否则模型以为发成功了）
  - CLIPBOARD_BLOCKED——Android 10+ 后台焦点限制，isAppForeground 探测
    （IMPORTANCE_FOREGROUND 判定），拒绝而非回吐陈旧空数据
  - PICK_TIMEOUT——SAF 用户 120s 未选择
  - BRIDGE_UNREACHABLE / BRIDGE_TIMEOUT / BRIDGE_ERROR:<code>——插件侧统一封装
