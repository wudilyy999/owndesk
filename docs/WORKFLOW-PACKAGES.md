# 本地流程包：导出、导入与重新验证

适用源码：`0.17.0-dev / SQL0018 / 工作站0.6.2 / guest6`。
本机主预览仍为`0.15.1-dev / SQL0015`，该功能尚未部署到主预览。

## 1. 用户流程

1. 在“电脑操作流程”页面选择一个 **ready** 版本，点击“准备脱敏流程包”。
2. 审阅完整 JSON，确认没有秘密、联系人和生产文件名；勾选后下载。
3. 接收方登录自己的安装，在同一页面选择 JSON，核对参数、步骤、环境与完成合同。
4. 勾选审阅后“导入为待验证草稿”。这一步只存数据库，不创建任务、不启动桌面、不请求模型。
5. 使用新的父目录和不同参数显式验证。导入包中的三组样例只作为说明，不代表验证已经成功。
6. 原执行链完整执行、宿主检查通过且环境一致的三组不同输入，才使本地版本进入 ready。
7. 后续选择“执行流程”，仍创建新的 Task、真实动作与检查记录。

例如，分享的包把原来的私人父目录、Draft 和 Ready 替换为`input1/input2/input3`。
说明样例使用`Example-1-Folder-1`等虚构名字。接收方可用新的`我的整理样例`、`待处理`、`已完成`独立验证。
每次选择未存在的父目录；实际操作始终发生在自己的工作站。

## 2. 导出边界

`GET /api/workflows/[id]/export`要求拥有者登录和 ready 版本；响应禁止缓存。
环境来自原版本实际验证环境，区别于旧来源任务的历史镜像。

导出使用显式白名单投影：

- 生成新的 packageId，重新编号步骤，参数统一为`input1`至`input8`。
- 重写流程名称、说明、参数标签、步骤标签与人工检查点说明。
- 使用中性虚构样例，不导出原 sourceValue。
- 删除本地 Task/版本身份、来源动作号、证据数组、修订来源及费用记录。
- 不包含截图、Cookie、登录状态、坐标、page/ref、observationId、epoch、boot 或审批。
- 保留人工检查点这个步骤；原私有操作说明移除，接收者必须根据本次合同人工处理并显式交还。
- 每个目录名都必须使用结构化参数；固定生产目录名、任意窗口标题无法通过便携校验，需要先形成合适的参数化版本。

原始来源与成本证据继续保留在源安装的私有数据库。分享不会更改、删除或把原费用改成零。
该投影面向当前 Thunar 任务族；它无法自动理解任意自由文本中所有可能的个人信息，完整导出内容仍需要拥有者审阅。

## 3. 格式与执行边界

顶层字段：`format=personal-agent.workflow`、`formatVersion=1`、`packageId`、
`name`、`description`、`environment`、`parameters`、`completion`、`steps`、`testSamples`。

环境声明只含实际镜像 ID、guest6、locale、Thunar。格式1仅接收原有限操作：
observe、open_application(Thunar)、受限 key_press、key_type、assert、human_checkpoint。
没有 Shell、宿主代码求值、安装钩子、任意脚本或插件下载。

外部包按严格嵌套 schema 校验，拒绝额外字段、非法快捷键、未声明参数、旧控制引用和伪造 ready/审批。
路径只支持`/home/agent/`下由目录参数组成的路径；窗口为已支持对话框和参数化目录标题。
输入仍复用原参数、完成合同和候选检查；宿主继续使用固定`directory-tree-v1`检查器。

这组有限操作仍可以改变工作站内文件。拥有者应审阅全部步骤，并在无重要数据的独立新目录验证；格式合格不能替代业务意图审核。

## 4. 导入持久化与请求恢复

`POST /api/workflows/import`要求同源、拥有者登录、JSON、`reviewed=true`，流式读取最多128 KiB。
正文为`{clientRequestId, reviewed, package}`；clientRequestId为UUID。

SQL0018让本地来源Task引用可空，并保存`imported_package`与`import_request_id`。
来源约束要求实际本地来源或导入包二者至少具备其一，外部包不伪造已完成的来源/编译Task。
修订导入流程时，下一草稿继续保留导入来源，修订Task引用属于本机真实执行。

同一拥有者/请求键导入同一内容返回相同版本；不同内容明确409。
响应丢失时，网页会话存储保留文件内容和请求键，刷新后需要重新勾选审阅，再请求仍复用已提交版本。
新流程/版本身份由本机生成，初始draft、validated_environment为空。外部packageId、样例和环境声明均不能继承认证或授权。

## 5. 开发验证

- 单元：`npx tsx --test tests/workflow-package.test.ts tests/workflow.test.ts`。
- 纵向：`npm run test:c5:sharing`；需要 PostgreSQL、Docker与可用Playwright浏览器。
- 已有浏览器可通过`UI_BROWSER_PATH`指定。测试不下载浏览器、不修改主配置、不迁移/重启主服务。
- 纵向测试从保留C2来源复制一个隔离库进行迁移/导出，再创建空数据库、新拥有者/密钥/安装ID及工作站home。
- 认证API、已提交响应丢失、并发去重、审阅后下载、桌面/390px界面和3验证+1复用任务分别检查。
- 没有配置模型服务，实际动作走原Task/DBOS/runtime/executeAction与宿主结果检查。

实际通过/失败、数据库、任务、截图和环境范围以`docs/evidence/workflow-sharing*.json`为准。
同宿主同架构的独立安装验证与远程VPS、跨架构、不同应用版本、社区目录和真实模型质量分开报告。
本次未增加市场、多Agent、通用控件树或按钮编号层。
