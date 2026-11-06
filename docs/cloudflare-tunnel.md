# 无公网 IP：用 Cloudflare Tunnel 访问 OwnDesk

主推给家里 NAS / 内网机器。`cloudflared` 为 **Apache-2.0**（Cloudflare 官方），从本机**出站**连到 Cloudflare，不必在路由器上开端口。

## 前置

- 域名已放到 Cloudflare DNS。
- 本机 OwnDesk 已按 [self-host.md](self-host.md) 装好；Caddy 监听本机 HTTPS（例如 `127.0.0.1:443`）或 HTTP（若你只用 Tunnel 终结 TLS，也可让 Tunnel 指到 `http://127.0.0.1:6797`，但生产建议保留 Caddy）。
- 安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)。

## 快速步骤（命名隧道）

```sh
cloudflared tunnel login
cloudflared tunnel create owndesk
cloudflared tunnel route dns owndesk desk.example.com
```

配置文件示例 `~/.cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/YOU/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: desk.example.com
    service: https://127.0.0.1:443
    originRequest:
      noTLSVerify: true # 若 Caddy 仍用本地 CA；公开 ACME 证书可去掉
  - service: http_status:404
```

```sh
cloudflared tunnel run owndesk
# 或安装为系统服务：cloudflared service install
```

把 `deploy/.env` 里的 `APP_URL` / `DESKTOP_GATEWAY_URL` 设成公网 origin，例如：

```text
APP_URL=https://desk.example.com
DESKTOP_GATEWAY_URL=wss://desk.example.com/desktop
```

改完后重启 web / worker / caddy。浏览器应能打开登录页；桌面观看走同一域名的 `/desktop` WebSocket。

## 和渠道的关系

| 渠道              | Tunnel 是否够用                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 网页 / PWA / 推送 | 够                                                                                                                                         |
| Telegram          | 够（出站调 Bot API）                                                                                                                       |
| 微信 ClawBot      | 够（长轮询出站，**无**入站回调）                                                                                                           |
| QQ / 公众号回调   | 回调 URL 可填 `https://desk.example.com/api/channels/...`；若平台还要求**固定出口 IP**，出站另加 [channel-relay](../deploy/channel-relay/) |

## 备选

- **frp**（Apache-2.0）：自建 frps 时用，文档不展开。
- **channel-relay**：已有固定 IP 跳板机时，见 `deploy/channel-relay`。

## 安全提醒

- Tunnel token / credentials 文件权限 600，勿进 Git。
- Cloudflare Access 可再挡一层（可选）；OwnDesk 自身仍靠唯一主人账号。
- 不要把管理端口或 Docker socket 加进 ingress。
