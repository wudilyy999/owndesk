# OwnDesk 升级（保留数据与密钥）

小版本升级原则：**不动 `MASTER_KEY` / `INSTALL_ID` / `VAPID_*` / 数据库密码**，只换镜像（或源码构建）并跑迁移。

## 升级前

1. 按 [BACKUP.md](../deploy/BACKUP.md) 做一次完整快照，密钥文件单独存放。
2. 确认没有重要在途任务；或接受升级窗口内任务会停。
3. 读本版本 Release notes 的「破坏性变更」。

## 用脚本（推荐）

```sh
./scripts/upgrade.sh v0.9.0                    # 拉 GHCR 的这个 tag
./scripts/upgrade.sh --build                   # 用这份源码本地构建
./scripts/upgrade.sh --local WEB_IMAGE WORKER_IMAGE   # 换成本机已有的镜像
./scripts/upgrade.sh --resume                  # 切换中途被打断时，把状态收敛到一致
```

从 B0 起，切换都交给**更新器**（`scripts/updater.mjs`）。它在一个一次性容器里运行，用的是**当前（旧）版本的 worker 镜像**，所以新版本就算坏了，也拦不住回退：

1. 给正在用的镜像和新镜像打上本机固定标签（`owndesk-web:keep-<镜像ID>`），记进版本表，旧版本一直保留；
2. 做一次数据库快照（`deploy/backups/pre-deploy-*.dump`，保留最近 3 份），再用**新** worker 镜像跑 `db:migrate`，旧版本这期间照常服务；
3. 改 `deploy/.env` 里的 `PA_WEB_IMAGE` / `PA_WORKER_IMAGE`，`compose up --wait` 换上 web 和 worker；
4. **健康检测**：和 compose 的健康检查同一条命令（web 的 `/login`、worker 的 `/health`），每 10 秒一次。连续 3 次通过算切换成功；连续 3 次不通过就**先换回旧版本保证能用**，记为"自动回退"，脚本退出码 2；
5. 切换成功后，更新器在旁边留一个"看护"容器（同样用旧镜像），一直做同样的健康检测。新版本过一段时间才出问题时，连续 3 次不通过同样自动回退。不设固定观察期；下一次切换时旧的看护会被替换。

网页里的「版本」页能看到当前版本、保留的版本（默认最近 3 个）和切换记录，选一个保留的版本点「切换到这个版本」就是一键回退，流程和上面一样。回退后要修的话，在副本里 debug、修好、重新测试再换上（B1 的改进实验室会把这一步自动化）。

每个镜像都自带构建它的源码（`/app/source.tar`，镜像标签 `org.opencontainers.image.revision` 是对应提交）。worker 启动时把它提交进 `evolution` 卷里的版本库（`upstream` 分支，标签 `upstream-<提交前 12 位>`），不需要联网或 GitHub 账号就能拿到和运行版本完全一致的源码。

注意：

- 回退只换镜像，不回滚数据库。迁移都是追加式的，旧镜像能读新库；真要回到升级前的数据，用 `deploy/backups/` 里的快照按 [BACKUP.md](../deploy/BACKUP.md) 恢复。
- B0 之前装的实例第一次升级时，旧镜像里还没有更新器，这一次由新镜像提供；`deploy/.env` 会自动补上 `PA_DEPLOY_DIR`。
- 健康检测间隔可以在 `deploy/.env` 里用 `PA_HEALTH_INTERVAL_SECONDS` 调整（只是检测频率，不是观察期）。

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
