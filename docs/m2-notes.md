# M2 笔记：安卓原生工具（Bridge v1 + android-bridge-tools）

状态：代码完成，装机验收进行中（2026-08-26）。

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

## 验收清单（PLAN.md M2）

- [ ] 模型自主调用 ≥4 个安卓工具并拿到结构化结果（驱动脚本 assembly/m2-accept.mjs）
- [x] 权限拒绝/超时路径有干净的工具错误反馈：
  - NOTIFICATION_DENIED——API 33+ 未授 POST_NOTIFICATIONS 时主动检测返回
    （系统默认静默丢弃，必须显式探测，否则模型以为发成功了）
  - CLIPBOARD_BLOCKED——Android 10+ 后台焦点限制，isAppForeground 探测
    （IMPORTANCE_FOREGROUND 判定），拒绝而非回吐陈旧空数据
  - PICK_TIMEOUT——SAF 用户 120s 未选择
  - BRIDGE_UNREACHABLE / BRIDGE_TIMEOUT / BRIDGE_ERROR:<code>——插件侧统一封装
