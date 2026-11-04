# Companion · 网页推送（Web Push）

她主动说话、而你没在看聊天页时，手机或浏览器弹一条通知，点开直接进聊天。标准 Web Push（RFC 8030）加 VAPID（RFC 8292），不依赖任何第三方账号，只用浏览器自带的推送服务（Chrome 走 FCM，Firefox 走 Mozilla，Safari 走 Apple）。

## 谁会触发通知

只有“她自己开口”的消息：主动分享（`share`）、办完或卡住的跑腿结果（`errand_update`）、一起看的反应（`coview`）。她回复你刚发的消息不推送，因为你已经在屏幕前。

worker 每 30 秒的 `companionTick` 里 `pushTick` 扫一遍“还没处理过的后台消息”，写入 `push_deliveries`（每条消息只处理一次，状态 `sent` 或 `skipped` 加原因）。这样不管消息从哪个环节产生（分享、跑腿、一起看）都不用单独接线。

## 什么时候不推

| 情况               | 做法                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 聊天页开着         | 页面可见时每 20 秒上报一次“我在看”（`companions.web_seen_at`）。消息之后你看过，或 60 秒内在看，都不推（`seen` / `viewing`） |
| 安静时段、她在睡觉 | 不丢，等安静时段结束再推；超过 6 小时就不再推（`quiet`）                                                                     |
| 消息太旧           | 超过 12 小时不推（`expired`）                                                                                                |
| 加设备之前的消息   | 不补推                                                                                                                       |
| 主动分享本身       | 仍先经过现有的主动规则（`decideShare`：频率、安静时段、节奏），推送只是它的另一个出口                                        |

没有“在看”的信号时（例如手机锁屏）按“没在看”处理。

## 设置页

“设置 → 通知”：

- 开启 / 关闭本设备的通知；设备列表（“Chrome on Linux”之类，不显示推送地址）。
- 内容预览，默认开：通知里带她这句话的第一行（最多 60 字，去掉链接和换行）。关掉后通知只写“发来一条消息”，内容不出现在锁屏上。
- “发一条测试通知”。
- iPhone / iPad：只有“添加到主屏幕”后的网页才能收通知（iOS 16.4+），设置页检测到在 Safari 标签页里时会显示这条提示。订阅必须由点击触发，所以开关是一个按钮，不会自动弹授权。

点击通知：已有窗口则聚焦并进入 `/companion`，没有则新开。

## 部署

需要一对 VAPID 密钥：

- Docker 部署：`node scripts/deploy-env.mjs ...` 生成 `.env` 时自动写入 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`。**升级时保留它们**，换了密钥所有设备都要重新开通知。
- 本机开发：`npm run push:keys` 把密钥补进 `.env`（已存在则不动，也不输出密钥）。
- `VAPID_SUBJECT` 可选，`mailto:` 或 https 地址，缺省用 `APP_URL`（https 时），否则一个占位 mailto。
- 没有密钥时功能整体关闭：设置页提示“这台服务器还没生成通知密钥”，tick 不做任何事。

私钥在 `.env`，已被 gitignore，不进版本库，也不会出现在日志里。

## 安全

- 服务端只向公网 https 的推送地址发请求，拒绝内网、回环和非 https，避免被当成 SSRF 跳板。
- 推送地址、公钥、auth 都是每台设备各自的，属于你的数据，随账号删除。
- 推送服务回 404 / 410 立刻删除该设备；连续 5 次其他失败也删除。
- service worker 里没有任何 API 路径，也不缓存接口。

## 测试

```text
npm test                    # tests/push.test.ts：决策、预览文字、载荷、地址校验、SW 事件
npm run test:push           # tests/push.ts：真实 Postgres，扫描、一次性、安静时段、失效清理（已并入 test:companion）
npm run test:push:e2e       # tests/push-e2e.ts：真实 Google Chrome + 真实 FCM
```

e2e 的做法：用已安装的 Google Chrome（`channel: "chrome"`，持久化用户目录）打开设置页，点“开启通知”，向 `fcm.googleapis.com` 真实订阅，再让服务端经真实 FCM 发出：测试按钮、主动分享（带预览）、关预览、页面开着时不推。`PUSH_HEADED=1` 在桌面上显示真实窗口，`PUSH_SHOTS=目录` 保存截图。

诚实说明：

- Playwright 自带的 Chromium 和无痕上下文订不了推送（没有 gcm 通道），所以用 Chrome。
- 通知权限由测试预先授予（脚本里点不了浏览器的授权弹窗）；“收到”用 service worker 的 `getNotifications()` 判定。有头模式加了桌面通知服务（dunst）才能拍到系统弹出的通知。
- 没有测过 iOS / Safari / Firefox 的真机推送；这部分按规范和 WebKit 文档实现。
- 这个测试依赖外网和 Google 的服务，不进 `npm test`。

## 来源

`web-push`（web-push-libs，MPL-2.0）作为未修改的依赖使用；协议按 RFC 8030、RFC 8291、RFC 8292 和 WebKit 的 Web Push 文档实现，没有复制他人代码。见 `THIRD_PARTY.md`。
