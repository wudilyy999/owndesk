# 聊天软件通道（第 3 阶段）

让同一个她出现在网页、Telegram、QQ、微信里：**同一份人设、同一份记忆、同一份聊天记录**。
在哪个软件里说的话，都会写进同一个 `companion_messages`，换个软件接着聊不会断。

> **验证状态（请先读这一段）**
> 本机没有 QQ 机器人凭据、没有固定出口 IP、没有微信 ClawBot / 公众号，所以**没有任何一次真实的 QQ / 微信调用**。
> 已经验证的是我们这一侧：官方文档里的签名样例、消息格式、收发规则、去重、排序、绑定、折叠逻辑，
> 用假服务器（`tests/channels.ts`、`tests/channel-relay.test.ts`）端到端跑过。
> 平台是否接受你的凭据、IP 白名单、回调地址，只有在你填入真实信息后才能确认。

## 能力与限制（按平台现行文档）

| 通道           | 她能主动找你吗                               | 她怎么回复                                         | 需要什么                                           |
| -------------- | -------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| 网页           | 能                                           | 流式                                               | 无                                                 |
| Telegram       | 能（走已有机器人和发送日志，崩溃不会重复发） | 普通文字                                           | 已配对的 Telegram 机器人                           |
| QQ             | **基本不能**：官方 2025-04-21 起取消主动推送 | 回你的消息（被动回复）；另有按时段限量的“召回消息” | 机器人 AppID/AppSecret、公网 https 回调、IP 白名单 |
| 微信 ClawBot   | **不能**                                     | 只能回你刚发的消息（带 `context_token`）           | 微信里的 ClawBot 插件，扫码登录                    |
| 公众号（备用） | **不能**                                     | 你发话后 48 小时内最多 5 条客服消息                | 已认证公众号、公网 https、IP 白名单                |

所以：**QQ 和微信上她是被动的。** 她在你不在时想分享的东西（分享、跑腿进展、共看评论）不会丢，
也不会硬发：这些消息被标成 `held`，**下次你开口时，她会在回复里自然地带上最值得说的一两件**（`awayDigest`），
其余的留在网页房间里。Telegram 没有这个限制，会直接发。

QQ 的几条硬规则都写在 `lib/channels/qq.ts` 里并有测试：

- 被动回复要带用户消息的 `msg_id` 和递增的 `msg_seq`；文档对窗口和条数说法不一，我们取保守值（5 分钟、每条最多 4 次回复，超出的并入最后一条）。
- 召回（`is_wakeup`）每个时段只能发一条：当天、1–3 天、3–7 天、7–30 天；超过 30 天不能发。时段按北京时间日界计算。
- 用户在 QQ 里关闭“主动消息”（`C2C_MSG_REJECT`）后不再召回，重新打开（`C2C_MSG_RECEIVE`）后恢复。
- 消息里的链接域名必须已在机器人后台“消息URL配置”登记，否则整条消息会被拒；未登记的链接会换成“（链接在网页里）”。

## 数据流

```
入站  QQ webhook / 公众号 webhook / 微信长轮询 / Telegram 桥
        └─ 验签 → 写入 channel_inbound（按事件 ID 去重）→ 立刻返回
              └─ worker 每 2 秒：companionChat（和网页同一条通路）→ channel_outbox → 平台
出站  分享 / 跑腿进展 / 共看 → companion_messages → 为每个已绑定通道排一条 channel_outbox
        ├─ 平台现在允许 → 发送
        └─ 平台不允许 → held → 折进下次回复
```

要点：回调先落库再回应，所以平台的 3–5 秒超时和模型快慢无关；同一事件重投不会回两次；
一个通道发送失败只阻塞这个人的后续消息，保持顺序；崩溃后 `processing` 超过 5 分钟的入站会重新处理。

## 绑定（只认你一个人）

- QQ / 公众号：网页 `/companion` →“聊天软件”→ 生成绑定码（10 分钟，一次性，库里只存哈希）→ 在 QQ / 公众号里对机器人发 `绑定 ABCD2345`。
  陌生人发来的任何消息只会收到“怎么绑定”的提示，**不会进入对话，也不会花模型额度**。
- 微信 ClawBot：网页上获取二维码，用微信扫码；**扫码的那个微信号就是唯一能和她聊的人**，其他人的消息被丢弃。
- Telegram：先照原来的方式配对机器人，再在“聊天软件”里点“用这个 Telegram 和她聊天”。
  绑定后普通文字是和她聊天；要她办事，她会把确认卡发到网页（和原来一样，聊天里一句话不算数）。`/stop` 等命令不变。
  解除绑定后，普通文字又变回交办任务。
- 一个她在每个通道上只绑一个账号；再次绑定会替换旧的。

## 部署：QQ 官方机器人

1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，记下 **AppID** 和 **AppSecret**（页面里叫 BotSecret）。
2. **IP 白名单**：开发管理里填“出口 IP”。官方接口只接受白名单 IP 的调用，所以要有固定 IP，见下面“固定出口 IP”。
3. **回调地址**：`https://你的域名/api/channels/qq`，端口只能是 80 / 443 / 8080 / 8443；订阅 `C2C_MESSAGE_CREATE`、`C2C_MSG_REJECT`、`C2C_MSG_RECEIVE`（可选 `FRIEND_ADD`）。
   平台会发 `op=13` 校验，我们用 AppSecret 派生的 Ed25519 密钥签名应答（用官方文档里的样例向量测过）。
4. **消息URL配置**：把你要在消息里出现的链接域名登记上，并填到网页“已登记的域名”里。没有就留空，链接会被替换成“（链接在网页里）”。
5. 网页“聊天软件”里填 AppID / AppSecret，生成绑定码，在 QQ 里对机器人私聊发 `绑定 码`。
6. 沙箱阶段用 `QQ_API_BASE=https://sandbox.api.sgroup.qq.com`（环境变量 `QQ_API_BASE`）。

## 部署：微信

**首选：ClawBot（官方插件的 iLink 协议）。** 在手机微信（iOS 8.0.70 以上）里启用 ClawBot 插件，网页上点“获取二维码”扫码即可。
我们按公开的协议文档实现：二维码登录、`getupdates` 长轮询、用 `context_token` 回复；登录失效（`-14`）时暂停一小时并在页面上提示重新扫码。
这条路线不需要公网回调，也不需要固定 IP（但出口仍可走中转，见下）。

**备用：公众号客服消息。** 填 AppID / AppSecret / Token（和可选的 EncodingAESKey），在公众号后台把“服务器地址”设为
`https://你的域名/api/channels/wechat-oa`（支持明文和安全模式 AES-256-CBC），把出口 IP 加入白名单，再用绑定码绑定。
48 小时内最多 5 条，超出的会等你下次开口。

## 固定出口 IP（这台机器没有稳定公网 IP）

`deploy/channel-relay/relay.mjs` 是一个零依赖的小转发器，放在**有固定公网 IP 的小 VPS** 上：

```
owndesk ──https──> relay.example.com/forward/api.bot.qq.com/... ──https──> api.bot.qq.com
                    (x-relay-key 鉴权)        (QQ 看到的是 VPS 的 IP)
```

```bash
# 在 VPS 上
cd deploy/channel-relay
RELAY_KEY=$(openssl rand -hex 24) docker compose up -d --build   # 记下这个密钥
# 前面再放一层 HTTPS（Caddy / nginx 反代到 127.0.0.1:8787）
```

然后在 owndesk 网页“聊天软件”最下面填中转地址和密钥（或环境变量 `CHANNEL_RELAY_URL` / `CHANNEL_RELAY_KEY`）。
把 **VPS 的公网 IP** 填进 QQ 和公众号的白名单。

安全设计：没有 `RELAY_KEY`（至少 16 位）拒绝启动；只转发白名单里的主机（QQ、公众号域名，可用 `RELAY_HOSTS` 调整）；
不跟随重定向；密钥用常数时间比较，且不会被转给平台。
可选：设置 `APP_UPSTREAM=https://你的owndesk` 后，这台 VPS 还会把 `/api/channels/qq` 和 `/api/channels/wechat-oa`
（仅这两个路径）转给 owndesk，于是同一台 VPS 就是公网回调地址，owndesk 本身不用暴露。

## 公网回调：cloudflared 临时隧道（仅文档，未开启）

没有公网域名时，可以先用 Cloudflare 的免费临时隧道试通回调：

```bash
cloudflared tunnel --url http://127.0.0.1:6797
```

它会给出一个 `https://随机.trycloudflare.com`。**限制**：每次重启地址都变、没有可用性保证，而 QQ 后台要的是固定回调地址，
所以只适合联调，长期用请用自己的域名 + 上面的 VPS 转发。**风险**：这样会把整个 owndesk 登录页暴露到公网；
更稳妥的是只暴露 `/api/channels/*`（用上面的 `APP_UPSTREAM` 方案）。**本仓库没有启动任何隧道。**

## 打字节奏与“正在输入”（B1）

后续气泡用 `channel_outbox.notBefore` 错开（设置里“打字节奏”：自然 / 快 / 关闭）。Telegram 发 `sendChatAction`，
微信 ClawBot 发 `getconfig` + `sendtyping`，QQ 的 `msg_type=6` **默认关闭**（`qq.typingNotify` / `QQ_TYPING_NOTIFY=1`，
因为官方没写它是否占用被动回复次数，需真机验证），微信服务号只有延迟。详见 `docs/companion-stage-b1.md`。

## 配置项（也可以只用网页填）

| 环境变量                                                                          | 说明                         |
| --------------------------------------------------------------------------------- | ---------------------------- |
| `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET` / `QQ_API_BASE` / `QQ_ALLOWED_URL_HOSTS`    | QQ 机器人                    |
| `QQ_TYPING_NOTIFY`                                                                | QQ “正在输入”，默认关        |
| `CHANNEL_RELAY_URL` / `CHANNEL_RELAY_KEY`                                         | 固定 IP 中转                 |
| `WECHAT_ILINK_BASE_URL`                                                           | ClawBot 接口地址（默认官方） |
| `WECHAT_OA_APP_ID` / `_APP_SECRET` / `_TOKEN` / `_AES_KEY` / `WECHAT_OA_API_BASE` | 公众号                       |

网页里填的密钥加密存库，写入后不会再显示。

## 测试

```bash
npm run test:channels                                   # 假 QQ / iLink / 公众号服务器 + 临时库，端到端
npx tsx --import ./tests/setup-env.mjs --test tests/channel-relay.test.ts   # 中转（npm test 也会跑）
npm test                                                # 含 QQ 签名样例、召回时段、AES、XML、折叠规则的单元测试
```

## 借鉴与致谢（概念与协议，未复制代码）

- [tencent-connect/botpy](https://github.com/tencent-connect/botpy)（MIT，QQ 官方 Python SDK）：接口路径、`msg_id` / `msg_seq` 被动回复、访问令牌换取。
- QQ 机器人官方文档：Webhook 的 Ed25519 签名与 `op=13` 校验、召回消息规则。
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT，微信官方 ClawBot 插件）：iLink 登录、`getupdates`、`context_token`、`-14` 暂停。
- 微信公众平台官方文档：服务器地址签名、安全模式加解密、客服消息接口及 48 小时 / 5 条限制。
- 没有复制任何 AGPL 项目的代码。
