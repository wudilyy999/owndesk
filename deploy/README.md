# 专用 Linux 私有部署（流程源码候选 0.17.0-dev）

2026-10-29：产品与新构建默认镜像名已统一 OwnDesk。本节命令面向新命名构建；此前已验收的镜像仍使用原 tag，更名后的正式镜像尚待构建。旧安装先读[更名迁移说明](../docs/RENAMING.md)，排空、备份并配对升级。

本目录提供 Compose、HTTPS 入口和工作站出站网络策略。应用仍属开发版；真实云厂商、公开域名 ACME、完整备份恢复和产品对照分别验收。先使用专用测试主机及非敏感账号。

源码配对为 Web/worker `0.17.0-dev`、工作站 `0.7.0 / guest6`、业务迁移止于 `0018`。原生控件迁移的正式开发镜像已完成隔离验收；最新上下文连续性修复仍需从当前源码重新构建Web/worker。历史流程导入/验证/复用报告对应当时固定镜像，结果以workflow-production系列报告为准；完整生产部署门槛继续单列。已通过的0.15.1生产容器检查保留其原版本。团队扩展继续暂缓，范围与检查见 [基础交付](../docs/BASE-DELIVERY.md)。

后文 F12、完整网络与资源报告保留原固定版本，不自动成为新候选的完整部署证据。基础生产容器定向检查与普通公网/实际云部署分别记录。旧guest需排空后显式重建并保留home；本机主服务为0.17.0-dev/SQL0018/工作站0.6.3/guest6，此文档不授权直接升级它。

## 1. 部署范围与权限

- 需要 rootful Linux Docker、Compose v2、iptables 后端、bridge netfilter；宿主安装 Node.js 24 用于生成配置。Docker Desktop/rootless/nftables 原生后端尚未纳入本部署验收。
- 当前规则要求本安装的跳转位于 `INPUT` / `DOCKER-USER` 链首。首版按一台专用主机、一个安装运行；其他防火墙管理器或第二个安装插入规则后，检查会明确失败。
- PostgreSQL、Web、worker 均不发布端口。只有 Caddy 发布 HTTPS/HTTP，默认绑定 `127.0.0.1`。只有受信任 worker（含临时迁移/网络初始化命令）挂载 Docker socket。
- worker 的 Docker socket 权限等价于宿主管理权限。guest 不挂载 socket、主密钥或数据库密码；Docker 容器仍共享宿主内核，不能等同于微虚拟机隔离。
- 首版 guest 允许访问普通公网 TCP/UDP，禁止私网、宿主、工作站互访、元数据及控制入口地址。该规则没有限制向任意公网站点上传文件。
- 本机主预览 `0.17.0-dev / SQL0018 / 工作站0.6.3 / guest6` 与本部署配置分开，部署文件使用独立生成的配置。

## 2. 生成独立配置

在此仓库根目录执行，以下使用私有 SSH 隧道地址作为例子：

```sh
node scripts/deploy-env.mjs https://localhost:19443 owner@example.com deploy
```

生成 `deploy/.env` 与 `deploy/owner.env`，权限 600，拒绝覆盖已有文件，也不向终端输出秘密。使用本机编辑器查看初始拥有者密码；勿粘贴到聊天、版本库或普通任务。

`deploy/.env` 里同时生成一对 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（网页推送，见 [push.md](../docs/push.md)）。升级或重装时保留这两行，换掉后所有已开通知的设备要重新开启。

编辑 `deploy/.env` 时核对：

| 项目                                         | 要求                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `APP_URL` / `DESKTOP_GATEWAY_URL`            | 用户真正访问的 HTTPS origin / 相同 origin 的 WSS `/desktop`；端口一致                    |
| `PA_BIND_IP`                                 | 私有演练保持 `127.0.0.1`；公开监听属于另一次有条件放行动作                               |
| `PA_HTTP_PORT` / `PA_HTTPS_PORT`             | 宿主可用端口；例子 HTTPS 为 19443，生成器自动取 URL 端口                                 |
| `PA_GUEST_SUBNET`                            | 与宿主、VPN、已有 Docker 网络均无重叠的私有 IPv4 `/24`                                   |
| `PA_CONTROL_IPS`                             | 逗号分隔的控制入口 IPv4；APP_URL 当前解析地址自动加入，其他入口/反代地址需显式添加       |
| `PA_GUEST_DNS`                               | 一个可直连的公网 IPv4 DNS，默认 `1.1.1.1`；不支持必须经过私网代理的网络                  |
| `WORKSTATION_CPUS` / `WORKSTATION_MEMORY_MB` | 按实际并发与浏览器负载配置；默认 2 CPU / 4096 MiB 是单工作站限制，尚无服务器最低规格结论 |
| `MASTER_KEY` / `INSTALL_ID`                  | 持久保存，升级保持原值；遗失会影响已有秘密解密，不能重新生成后继续使用旧数据             |

隧道示例：在自己的电脑执行 `ssh -N -L 19443:127.0.0.1:19443 用户@服务器`。浏览器直接打开 HTTPS 地址，非标准端口不依赖 HTTP 自动跳转。另一台手机需要自己的安全可达路径；`localhost` 不直接指向云主机。

## 3. 构建固定候选镜像

```sh
docker compose --file deploy/compose.yaml --env-file deploy/.env build web worker
docker build --tag owndesk-workstation:0.7.0 workstation
```

Web 使用非 root 用户、只读根文件系统及只读成果卷；worker 使用同一 npm 工程，附带 Docker CLI 和网络管理工具。构建上下文采用允许列表，排除 `.env`、`owner.env`、`data`。构建阶段只有公开占位配置，运行阶段必须供应本安装的真实配置。

## 4. 初始化并核对 guest 网络

先在**专用 Linux 主机**启用桥接过滤，确认内核与 Docker 后端满足条件。持久化方式按主机系统管理；重启后重新核对。

```sh
sudo modprobe br_netfilter
sudo sysctl -w net.bridge.bridge-nf-call-iptables=1

docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --env-file deploy/.env owndesk-worker:0.17.0-dev \
  node scripts/network.mjs init

docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --env-file deploy/.env owndesk-worker:0.17.0-dev \
  node scripts/network.mjs check
```

初始化只维护本安装的 bridge、两条链和对应跳转，拒绝在 guest 尚挂在网络上时替换策略。检查核对实际规则及顺序，不依赖标签宣称“已隔离”。worker 启动与创建/启动工作站前也会检查。

规则同时检查 DNAT 后目标和 conntrack 原目标，防止通过宿主已发布端口绕到公网目标。工作站禁用 IPv6、移除 `CAP_NET_RAW`，观看 sidecar 使用 `network=none`。

主机重启、Docker/防火墙重载或控制 IP 变化后，先排空并停止/移除本安装的 guest 容器（保留 home 卷），再显式 `init` / `check`，然后启动 worker。检查仅在启动/准备边界执行；受信任 root 随后篡改防火墙不属于持续防护保证。

## 5. 数据库、拥有者、服务

```sh
docker compose --file deploy/compose.yaml --env-file deploy/.env up -d postgres
docker compose --file deploy/compose.yaml --env-file deploy/.env run --rm worker npm run db:migrate
docker compose --file deploy/compose.yaml --env-file deploy/.env run --rm \
  --env-from-file deploy/owner.env worker npm run owner:create
docker compose --file deploy/compose.yaml --env-file deploy/.env up -d --wait
```

拥有者初始化仅成功一次，重复命令明确报错。全新安装会应用 `0000`—`0018` 共 19 条业务迁移、认证与 DBOS 表；当前桌面镜像 `0.7.0`、协议6。C0增加逐帧绑定；0016存流程版本，0017存流程运行/独立验证环境，0018保存真实导入来源与请求去重。0.6.2增加thunar-keyboard-v1，旧协议6镜像可供原桌面动作使用，执行编译流程须显式配对支持能力的镜像；0.6.5另增加原生控件读写。旧安装先按 [备份与恢复](BACKUP.md) 保存一致快照和独立密钥、排空任务，再显式升级；已有拥有者跳过 `owner:create`，勿对当前主库直接执行本节。

`localhost` 使用 Caddy 本地 CA。先把本安装的**公开根证书**安全取到自己的电脑并信任，勿复制 CA 私钥。部署检查通过 CA 验证 HTTPS/WSS；浏览器自动化为临时测试上下文单独忽略证书错误，未修改系统信任库。

```sh
docker compose --file deploy/compose.yaml --env-file deploy/.env cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./personal-agent-root.crt
curl --cacert ./personal-agent-root.crt https://localhost:19443/login
```

登录后在“模型与 Agent 设置”填写模型服务和密钥。先交办非敏感的小任务，核对成果、只读观看、人工接管/交还和取消。密钥只在设置页输入。

Caddy 对 `/desktop/*` 转发 WebSocket，其余进入 Web；SSE 关闭代理缓冲。默认错误日志删除携带一次性桌面票据的 `Sec-WebSocket-Protocol` header，保留其他诊断。运维日志仍可能含任务 ID/路径，按私有数据保存。

## 6. 升级、备份与恢复状态

当前提供部署与网络链路，以及 [F12 一致备份与恢复作业单](BACKUP.md)。同架构的两台独立 Linux VM 已完成受控完整恢复，见 restore.json；实际云厂商、跨架构和公开 ACME 仍另验。单独 `pg_dump` 或保留 Docker volume 无法替代可核对的整套恢复。

2026-10-25 的专用 Linux VM 演练通过初始化/HTTPS 和一次受控登录接管→worker 强制退出恢复→报表交付，随后在普通公网 HTTPS 检查失败。定向诊断发现本机网络将 `example.com` 和多个公共 DNS 的查询返回为 `198.18.1.34`；启用规则后的 DROP 计数增加，显式 DoH 的 TLS 请求则可完成。保留地址阻断保持原样，不把仅 DoH 的诊断成功登记为普通应用 DNS 通过。首版尚未提供 fake-IP/私网代理适配，下一次部署放行需要直连 DNS 环境或经过单独设计/验收的适配。

format-2 快照在停止新入口、worker 与 guest 写入的窗口覆盖完整 PostgreSQL（业务/认证/DBOS）、成果卷、各工作站 home/profile、固定镜像与版本清单；`MASTER_KEY`、`INSTALL_ID`、认证/部署配置保存在独立文件。恢复先认证完整文件，再在空目标导入镜像/数据，只启动 PostgreSQL；旧会话/票据与现场绑定失效，例程暂停，Telegram 需重新配对。浏览器 Cookie 与 home 本身也属敏感数据。

受控演练已核对秘密解密、历史/成果/home、旧票据/现场绑定失效、两类未知调用不自动重做，以及恢复后的实际浏览器登录。测试 Cookie 与现场授权探针有明确的夹具设置，未验证真实模型/真实网站。普通公网 DNS、实际云网络与长期容量继续验收。首版升级仍要求排空旧执行段并明确处理人工等待，不把任意数据库迁移视为可逆。

## 7. 实验入口与范围

本轮基础闭环使用 `npm run test:delivery`，复用下方生产 Compose/HTTPS/桌面链路，仅运行单 Agent 的受控交付与实际取消，不重跑已知会被 fake-IP 阻断的普通公网阶段。它使用原隔离规则、核对真实控制面端点被阻断；报告独立写入 `basic-cua-production-attempt.json`（成功另写 `basic-cua-production.json`）。该通过只代表基础生产容器闭环，完整 `deployment-private-attempt.json` 的原失败保持。不要把此入口当成普通公网/真实模型或实际云部署放行。

单工作站资源样本与已完成桌面的自动停机/唤醒见 [资源作业单](RESOURCES.md)。WORKSTATION_IDLE_MINUTES 默认 15、0 禁用；需要包含该实现的受验 worker，旧备份里的固定镜像不会自动获得新行为。两组受控实验通过不替代普通公网或长期容量门槛。

```sh
npm run test:deployment
```

使用独立 Linux Docker-in-Docker 或显式指定的专用 Linux VM，运行生产镜像、受控模型服务、真实桌面和可控网站。默认隔离主机需要自己的内核已支持 bridge netfilter；Docker-in-Docker 无法补上宿主缺失的内核模块。实验服务与数据均独立，不改默认 Docker context。

失败保存实验数据与日志后停止专用环境，便于定位；成功清理专用环境。真实云主机、真实模型、公开 ACME、长期资源容量、完整恢复与 上游项目 对照保持单独记录。最近尝试见 `docs/evidence/deployment-private-attempt.json`；只有整套通过时才生成 `docs/evidence/deployment-private.json`，当前没有该通过报告。实际范围以这些记录和 `docs/STATUS.md` 为准。

### 保留恢复目标上的网络定向续验

`npm run test:network` 通过 PA_LINUX_HOST_STATE 指向明确的专用实验引擎，PA_NETWORK_CONFIG 指向该引擎实验目录中的固定镜像恢复配置。运行前目标最多运行 PostgreSQL，Web/worker/guest 和受控公网夹具均需离线；同时启用该专用 VM 的 bridge netfilter。该入口复用目标已有的 `<host-name>-restore-public` 夹具网络（93.184.216.0/24），使用 .11/.9 两个测试地址；旧恢复的 .8/.10 容器保持离线。勿把这些实验地址或配方写进普通生产部署。

检查启动原生产 PG/Web/worker，创建真实 guest/peer；逐端点先从受信宿主确认可达，再确认 guest 被拒。范围包括数据库、Web、worker、宿主网关、宿主发布端口 DNAT、另一实际工作站、三类模拟元数据地址及明确控制公网别名。受控公网服务保持可达，DNS/能力/IPv6/端口/socket/秘密环境限制同时检查。

删除出站规则、改变 DOCKER-USER 顺序或改变 INPUT 顺序后，check 与生产 ensureWorkstation 均拒绝，未创建新 guest。出站规则缺失还检查真实 worker 启动失败。排空并显式 init/check 后重启，可继续使用 home，再创建新工作站；既有 Task/action/model 数量不变。最终保留数据/报告，停止所有 Compose 服务与专用 VM；不删除旧恢复数据，不改默认 Docker context。

本轮 network-lifecycle.json 的 5 组检查通过，10 个正向/负向端点对全部符合预期。初次尝试因重复创建与旧恢复夹具重叠的子网失败，修正为复用离线网络后通过，原失败保留。普通公网 DNS 原失败仍在；该续验没有真实模型费用、实际云元数据或持续 root 篡改防御结论。容量、直连环境/实际 VPS/ACME 和完整产品对照继续单独验收。

### 流程候选的定向生产容器验收

`npm run test:workflow:production`复用同一tests/deployment.ts及原Linux主机/Compose/网络/HTTPS初始化链，仅运行流程包这一新分支，不重复原0.15.1的2Task报表/取消验收。需要先构建0.17.0-dev Web/worker、0.6.2工作站，并保留已验收C5导出的中性样例包；明确指定专用PA_LINUX_HOST_STATE与可用UI_BROWSER_PATH。禁止指向有用户数据的Docker主机。

该分支核对镜像来自部署生成配置、迁移数量等于当前业务journal；旧版硬编码0.6.1/16迁移已移除。全新安装上传/审阅导入包、3组新参数独立GUI验证、第四新Task运行ready，数量门槛4；没有provider配置或模型请求。核对生产优化网页、实际HTTPS/WSS桌面、服务器只读观看、Web无Docker且非root/只读、guest不携控制秘密，以及实际Web端点的正/负访问对照。

报告独立写workflow-production-attempt.json，只有通过才另存workflow-production.json；历史basic-cua-production.json与deployment-private-attempt.json保持原范围。专用VM停止并保留数据，源码构建与本机主预览升级分别授权。该定向通过不代表普通公网DNS、真实模型提炼/修订、实际VPS/ACME、完整恢复或上游项目对照完成。

2026-10-26实际续验：原4个流程Task全部完成，后置截图夹具因任务已释放控制权而失败，原attempt报告保留passed=false。观看检查已移到运行中；`npx tsx tests/workflow-production-ui.ts`只针对该保留实验安装补1个真实在途Task及剩余观看/隔离/审阅下载/390px检查，原4个Task和指标完全不变。该命令仅用于本次保留实验副本，禁止指向主服务。合成workflow-production.json分列核心4/UI1门槛，5完成/135动作/0模型/0人工请求；真实优化noVNC画面、CA验证WSS和服务器只读均通过。没有宣称原4Task命令一次全绿或重跑它们。首次中文归档误报来自tar的C locale，现固定C.UTF-8，无guest/依赖变化；旧3Task失败及489条循环事件保留。专用VM/工作站已停，主0.15.1/SQL0015未升级。
