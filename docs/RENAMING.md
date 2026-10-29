# OwnDesk 命名与旧安装迁移

更新：2026-10-29。产品名称为 **OwnDesk**，npm 包名为 `owndesk`。

## 新源码采用的命名

| 位置                               | 新名称                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ |
| 网页标题、登录页、侧边栏、导出署名 | OwnDesk                                                                  |
| 首次初始化创建的助手               | OwnDesk Assistant                                                        |
| 桌面镜像                           | `owndesk-workstation:0.6.5`                                              |
| Web / worker 镜像                  | `owndesk-web:0.17.0-dev` / `owndesk-worker:0.17.0-dev`                   |
| 桌面 Linux 用户与目录              | `agent` / `/home/agent`，UID 继续使用 1000                               |
| 控制器                             | `/opt/owndesk-controller`                                                |
| 浏览器配置                         | `/home/agent/.config/owndesk-browser`                                    |
| 桌面启动、就绪、截图和命令脚本     | `owndesk-desktop` / `owndesk-ready` / `owndesk-shot` / `owndesk-run`     |
| 桌面环境变量                       | `OWNDESK_SCREEN` / `OWNDESK_VNC_PASSWORD` / `OWNDESK_IDLE_MINUTES`       |
| 模型默认设置覆盖                   | `OWNDESK_DEFAULT_MODEL` / `OWNDESK_MAX_STEPS` / `OWNDESK_MONTHLY_BUDGET` |
| Markdown 样式                      | `prose-owndesk`                                                          |
| 截图上下文元数据                   | `providerOptions.owndesk`                                                |

## 本机预览已配对升级

用户授权后，6797/6798 已更新为 OwnDesk：Web 使用当前源码的生产构建，worker 使用当前源码，Linux 工作站使用正式构建的 `owndesk-workstation:0.6.5`。本机 Web/worker 以进程运行，工作站与只读 viewer 使用 Docker。`.env` 仅更新工作站镜像，数据库保持 SQL0018；原账号、模型密钥、任务、成果与 home 卷均保留。

原 home 卷挂载到 `/home/agent`，浏览器配置迁移为 `.config/owndesk-browser`。迁移前后 621 个普通文件逐字节一致。默认助手更新为 OwnDesk Assistant，Recovery Lab 等其他助手保持。旧桌面票据已撤销，新现场重新建立控制代。工作目录保留原路径，已有成果的绝对路径引用继续有效；新克隆可使用 `owndesk` 目录名。

旧构建、22 个停止容器和 18 个旧镜像引用已清理，全部数据卷保留。数据库备份实际恢复后，47 张表逐行一致；启动后 29 张稳定业务表保持，历史数量仍为 12 Task / 65 模型请求记录 / 58 动作 / 7 成果。账号登录、成果下载、实时观看和接管交还已核对，0 新增任务、0 模型调用。回滚归档与原始证据保留，见 `docs/evidence/owndesk-upgrade.json`。

持久化的 DBOS 应用身份、Docker 资源标签、快照格式标识、数据库名和浏览器草稿存储键保持稳定。这些内部标识用于识别已有记录，产品界面显示新的品牌。

原始 `docs/evidence/`、实验目录和备份继续保留实际使用的路径、镜像及来源名称。`LICENSE` 版权声明保持原文，`THIRD_PARTY.md` 与 `provenance.json` 保留准确上游来源；本地文件的 provenance 目标路径按新名称更新，上游 sourcePath 保持真实。

## 旧安装的配对升级步骤

1. 排空任务，处理等待确认或效果未知的任务，保存数据库、成果、home/profile 和独立密钥的一致备份。
2. 从当前源码构建新的 OwnDesk 工作站、Web 与 worker，确认镜像确实包含新脚本、账户与控制器路径。仅改镜像 tag 无法完成更名。
3. 在独立恢复环境中验证。保留 home 卷根目录的文件和 UID 1000 权限，在新容器挂载为 `/home/agent`；将旧浏览器配置目录迁移到 `.config/owndesk-browser`，保留原备份。
4. 检查已有流程、目录合同与手册中的绝对路径，重新审阅并验证适用版本。旧登录授权、观察 ID、截图元数据和进行中的步骤不能作为新现场的输入授权。
5. 保持安装身份、主密钥和数据库连接，更新工作站镜像及部署配置。停止旧工作站并撤销旧观看与控制连接，再启动配对的新服务，由新现场建立控制代和观察。
6. 定向核对文件、浏览器配置、桌面观看与接管、截图和一个无付费模型的工具动作，再开放新任务。工作目录的改名另行与启动命令、成果路径配对处理。

上述步骤已用于本机预览升级。当前数据库没有已保存的流程版本；旧流程包绝对路径的自动转换与真实 VPS 升级仍需按各自环境验证。
