# OwnDesk 升级（保留数据与密钥）

小版本升级原则：**不动 `MASTER_KEY` / `INSTALL_ID` / `VAPID_*` / 数据库密码**，只换镜像（或源码构建）并跑迁移。

## 升级前

1. 按 [BACKUP.md](../deploy/BACKUP.md) 做一次完整快照，密钥文件单独存放。
2. 确认没有重要在途任务；或接受升级窗口内任务会停。
3. 读本版本 Release notes 的「破坏性变更」。

## 用脚本（推荐）

```sh
./scripts/upgrade.sh v0.9.0
# 或升级到某个 GHCR tag / 本地构建
./scripts/upgrade.sh --build
```

脚本会：核对 `deploy/.env` 存在且含 MASTER_KEY/VAPID、拉取或构建镜像、短暂停 Caddy/Web/worker、跑 `db:migrate`、再启动并 curl `/health`。

## 手动步骤摘要

```sh
# 1) 拉代码或记好目标 tag
git fetch --tags && git checkout v0.9.0

# 2) 拉镜像（GHCR）或 build
docker compose --file deploy/compose.yaml --env-file deploy/.env pull
# 或：docker compose ... build web worker && docker build -t owndesk-workstation:0.7.0 workstation

# 3) 短暂停入口与写入
docker compose --file deploy/compose.yaml --env-file deploy/.env stop --timeout 60 caddy web worker

# 4) 迁移（Postgres 保持运行）
docker compose --file deploy/compose.yaml --env-file deploy/.env run --rm worker npm run db:migrate

# 5) 启动
docker compose --file deploy/compose.yaml --env-file deploy/.env up -d --wait
curl -fsS "$APP_URL/health"
```

## 禁止

- **禁止**重新跑 `deploy-env.mjs` 覆盖已有 `.env`（会换掉主密钥 → 旧秘密无法解密；换 VAPID → 所有手机要重新开通知）。
- **禁止**在未备份时对主库做实验性迁移。
- 跨大版本或跨 CPU 架构：先恢复演练到另一台机器，再切流量。

工作站 guest 升级：排空任务后按 deploy 文档重建容器并**保留 home 卷**。
