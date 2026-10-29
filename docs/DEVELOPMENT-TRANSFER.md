# 换一台电脑继续开发

更新：2026-10-30。本仓库包含当前源码、锁定依赖、数据库迁移、Docker 构建文件、测试、设计文档与脱敏后的文字报告。新电脑使用独立配置和数据库，原电脑的运行数据继续保留在原设备。

## 1. 获取工程与依赖

先安装 Node.js 24、Git、Docker，并准备 PostgreSQL 16。macOS 可使用 Docker Desktop 或自己的 Colima；Windows 可使用 Docker Desktop 的 Linux 容器环境。不同 CPU 架构分别重新构建镜像，已有实验不代表跨架构恢复已经通过。

```sh
gh auth login
gh repo clone wudilyy999/owndesk
cd owndesk
npm ci
```

没有 GitHub CLI 时，使用已登录的 Git 客户端克隆私有仓库。

## 2. 创建新电脑的配置

在工程根目录执行以下命令，从模板生成 `.env` 并创建独立身份和密钥。已有 `.env` 会保留，命令直接报错。生成的值只写入本地文件。

```sh
node -e "const fs=require('node:fs'),c=require('node:crypto');let t=fs.readFileSync('.env.example','utf8');for(const[k,v]of Object.entries({BETTER_AUTH_SECRET:c.randomBytes(48).toString('base64url'),MASTER_KEY:c.randomBytes(32).toString('hex'),INSTALL_ID:c.randomUUID()}))t=t.replace(new RegExp('^'+k+'=.*$','m'),k+'='+v);fs.writeFileSync('.env',t,{mode:0o600,flag:'wx'});"
```

编辑 `.env`，把 `DATABASE_URL` 改成新电脑上的独立数据库连接。模板中的 `change-me` 只是占位符。`APP_URL` 默认保持 `http://localhost:6797`；桌面镜像为 `owndesk-workstation:0.6.5`。

首次初始化可在 `.env` 中临时加入以下变量，填写自己的新账号与新密码：

```dotenv
OWNER_EMAIL=owner@example.com
OWNER_PASSWORD=replace-with-your-own-unique-password
OWNER_NAME=Owner
OWNER_TIMEZONE=Asia/Taipei
```

```sh
npm run db:migrate
npm run owner:create
```

初始化成功后从 `.env` 删除 `OWNER_PASSWORD`。新账号保存在新数据库中；使用自己的密码管理器保管登录信息。

## 3. 构建电脑与启动服务

确认 Docker 已启动，按需选择正确的 Docker context，然后执行：

```sh
npm run workstation:build
```

两个终端分别在工程目录运行：

```sh
npm run worker
```

```sh
npm run dev
```

打开 `http://localhost:6797`，用刚创建的账号登录。开发使用 Next.js 热更新；需要生产构建时使用 `npm run build`，再使用 `npm run start` 替代 `npm run dev`。

Linux 私有服务器的 Compose、HTTPS 与网络配置见 [部署说明](../deploy/README.md)。当前源码版本为 `0.17.0-dev / SQL0018 / 工作站0.6.5 / guest6`；新版完整 Compose 发布与真实 VPS 验收仍需继续完成。

## 4. 重新配置模型

进入设置页的“模型与 Agent”，填写新电脑能够访问的模型服务地址、API Key 和默认模型。原电脑的回环地址只指向原电脑自己的服务，新电脑需要单独启动网关或填写可达的远程服务地址。

仓库没有模型密钥、原登录密码或浏览器登录态。原配置留在原设备，这次上传没有更换、注销或删除它们。

## 5. 继续开发时先读哪些文件

1. 根目录 `AGENTS.md`：开发规则与历史交接边界。
2. `README.md`、`docs/STATUS.md`：当前能力、已验证范围与缺口。
3. `docs/CONTEXT.md`：上下文裁剪、最多两张有效截图与摘要压缩。
4. `docs/AT-SPI-MIGRATION.md`：Linux 原生控件与视觉能力。
5. `docs/MANUALS.md`、`docs/design/`：操作手册与详细设计。

下一步优先补齐常用桌面软件、应用入口及实际 GUI 任务验证。当前保持单 Agent 优先，多 Agent 暂缓。

按改动范围运行定向检查。真实模型验收会产生费用，历史报告中的授权仅属于当时任务。部分集成测试依赖专用测试数据库、`data/dev-owner.json` 或旧实验数据；这些私有数据没有上传，不要直接在日常数据库运行整套集成测试。

## 6. 如果还要迁移旧任务和桌面文件

本次 Git 上传只携带可安全共享的开发材料。已有任务、模型设置、长期记忆、成果、浏览器状态和 Docker home 卷仍在原设备。

需要这些运行状态时，按 [备份与恢复](../deploy/BACKUP.md) 通过受控的私有通道另外迁移。旧数据库中的加密配置依赖原 `MASTER_KEY`；恢复旧安装应使用完整原身份与匹配备份，和上文独立初始化属于两条操作路径。新机器在确认恢复点与旧任务状态后再启用执行，保持同一安装只有一个工作节点。

具体上传范围见 [隐私处理说明](PRIVACY-EXPORT.md)。
