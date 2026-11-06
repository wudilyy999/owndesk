# OwnDesk 自托管安装（一人一套）

日期：2026-11-06　适用：v0.9 自托管发行打磨（C1）  
**一安装 = 一个主人 + 一台她的电脑。不开放注册，不做多租户。**

## 你需要什么

| 项       | 建议                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 机器     | **4 vCPU / 8 GB RAM / 40 GB+ SSD**（x86_64 优先；ARM 可用但工作站镜像需自行构建）                    |
| 系统     | 干净的 Linux，rootful Docker + Compose v2，iptables 后端                                             |
| 域名     | 有公网 IP 时用域名指向这台机；**没有公网 IP 时用 [Cloudflare Tunnel](cloudflare-tunnel.md)**（推荐） |
| 模型密钥 | **自带（BYOK）**。文档示例：DeepSeek，或任意 OpenAI 兼容端点                                         |

可选：Telegram Bot；QQ 机器人；微信 **ClawBot**（首选，见 [channels.md](channels.md)）。

## 三条路怎么进 HTTPS

1. **无公网 IP（家里 NAS / 内网）→ Cloudflare Tunnel**（主推）：见 [cloudflare-tunnel.md](cloudflare-tunnel.md)。
2. **有固定公网 IP 的 VPS → Caddy 公开 ACME**：把 `PA_BIND_IP=0.0.0.0`，域名 A 记录指向 VPS，Caddy 自动申请证书。
3. **仅局域网调试 → 本地 CA**：`deploy-env` 默认绑定 `127.0.0.1`，需信任 Caddy 本地根证书。

QQ / 公众号若要求固定出口 IP，可另用 `deploy/channel-relay`（附录）；微信 ClawBot **不需要**公网回调。

## 一键安装（推荐）

在目标机器上（需要能跑 Docker 的账号）：

```sh
curl -fsSL https://raw.githubusercontent.com/wudilyy999/owndesk/main/scripts/install.sh | bash -s -- \
  https://desk.example.com \
  you@example.com
```

脚本会：检查 Docker / Compose、clone 或使用当前目录、生成 `deploy/.env` 与主人密码、拉取或构建镜像、迁移数据库、创建唯一主人、打印登录地址。  
**秘密不会打印到终端**；主人初始密码在 `deploy/owner.env`（权限 600）。

也可以先 clone 再跑：

```sh
git clone https://github.com/wudilyy999/owndesk.git
cd owndesk
./scripts/install.sh https://desk.example.com you@example.com
```

安装后打开浏览器登录，到「设置 → 模型」填入例如：

- DeepSeek：`DEEPSEEK_API_KEY`，模型 `deepseek/deepseek-chat`
- 或自定义 OpenAI 兼容：提供商选 Custom，填 Base URL + Key + 模型名

可选备用模型（主模型超时 / 5xx 时换一条）：环境变量 `OWNDESK_FALLBACK_MODEL=deepseek/deepseek-chat`，或设置里的 `model.fallback`。

## 镜像从哪里来

正式发行走 **GitHub Release + GHCR**：

```text
ghcr.io/wudilyy999/owndesk-web:<version>
ghcr.io/wudilyy999/owndesk-worker:<version>
ghcr.io/wudilyy999/owndesk-workstation:0.7.0
```

`install.sh` 若检测到已登录 GHCR / 公开可读，会优先拉发布镜像；否则从本仓库 Dockerfile 构建。Compose 见 `deploy/compose.yaml`。

## 装完必做

1. 立刻改主人密码（设置页）。
2. 确认只有你一个人能登录（注册默认关闭）。
3. 防火墙只放行 80/443（或 Tunnel 出站）；**不要**把 Docker socket 暴露给不可信网络。
4. 按 [upgrade.md](upgrade.md) 了解升级；按 [../deploy/BACKUP.md](../deploy/BACKUP.md) 与 `scripts/backup-cron.example.sh` 做定时备份。
5. `/health` 可供 Uptime Kuma 等监控。

## 诚实边界

- 网页推送在 **Chrome** 上实测过；iOS Safari / Firefox 按规范实现，未逐一真机验收。
- QQ / 微信 / Telegram 的**平台侧**接通取决于你的凭据与网络；我方协议与假 API 测试见 [channels.md](channels.md)。
- 这是**个人自用**自托管工具。若你把它做成对外提供的拟人化互动服务，需自行评估当地法规（含未成年人保护等）。

更多底层说明仍见 [../deploy/README.md](../deploy/README.md)（偏内部演练，版本叙述较长）。新人请以本页为准。
