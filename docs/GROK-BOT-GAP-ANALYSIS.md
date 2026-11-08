# OwnDesk 与 Grok Bot 类产品的能力缺口审计

日期：2026-11-08（Asia/Shanghai）。

本文保留实现前的源码审计。后续七项能力的实现、PR、实际检查与使用入口统一记录在 [交付记录](DELIVERY-ROADMAP.md)，当前状态以该记录为准。

审计对象为 `wudilyy999/owndesk` 的 `main@4fe5239fe27d7ef91038629348f0b470fd11e288`。对照对象为已拉到本地的 `elie222/rakazo@b67f5e4ef3f5128704a8777edb762719d061055d`，用于观察同类产品的具体实现；Rakazo 的全部功能不直接等同于 Grok 官方功能。结论依据当前源码、仓库已有证据及 GitHub CI，运行核验范围见文末。

## 判断

OwnDesk 已具备个人电脑 Agent 的主要执行基础：持久工作站、浏览器与桌面操作、人工接管、持久任务恢复、定时例程、记忆、费用记录、手册与有限流程复用。近期还加入了 Companion、图片聊天、主动生活分享、国内聊天渠道和网页推送。

目前最影响完整体验的缺口集中在：

1. 聊天、办事、任务内追问及结果交付之间的连续性。
2. 伴侣聊天与办事任务对同一份长期记忆的读取能力不一致。
3. 通用应用连接、文档附件和跨历史检索。
4. 自然语言管理自动化，以及变化监听和事件触发。
5. 用户示范教学和跨应用流程复用。

多 Agent、语音通话、原生客户端和多种电脑后端属于进一步扩展。项目现有单 Agent 优先的决定仍适用，以上前五项可以沿现有链路逐项补齐。

## 已经有的能力

| 能力                          | 当前实现与证据                                                                                    | 后续应复用的部分                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 持久助手与工作站              | `lib/agents.ts`、`lib/workstation.ts`；每个 Agent 的 home、浏览器状态与工作站生命周期             | Agent 身份、home 与原控制权模型            |
| 浏览器、桌面、Shell、文件操作 | `lib/agent/tools.ts`、`lib/agent/native-tools.ts`、`workstation/controller/`                      | 当前模型工具及原动作回执                   |
| 人工接管与交还                | `lib/task-control.ts`、`worker/desktop-gateway.ts`、`components/desktop.tsx`                      | 桌面观看、控制代与新观察                   |
| 后台执行、恢复、取消          | `lib/tasks.ts`、`lib/durable.ts`、`worker/runtime.ts`、`worker/actions.ts`                        | 原 Task / DBOS / action 链                 |
| 定时例程                      | `lib/routines.ts`、`worker/routines.ts`、`components/routines.tsx`                                | 例程快照、去重与任务提交入口               |
| 长期记忆                      | `worker/memory.ts`，以及 `lib/companion/memory.ts`、`memory-update.ts`、`consolidate.ts`          | 现有 memories 表、主题总结、分页与变更记录 |
| 聊天与主动分享                | `lib/companion/chat.ts`、`life.ts`、`coview.ts`、`tick.ts`                                        | 现有聊天、生活记录与分享队列               |
| 外部聊天渠道                  | `lib/channels/registry.ts:8` 注册 Telegram、QQ、微信及微信公众号                                  | 入站去重、绑定、发送队列与原渠道适配器     |
| 图片、PWA、网页推送           | `app/api/companion/uploads/route.ts`、`app/manifest.ts`、`lib/companion/push.ts`                  | 图片处理、安装式网页与通知订阅             |
| 手册与自动流程                | `lib/manuals.ts`、`lib/workflows.ts`、`worker/workflow-execution.ts`、`worker/workflow-repair.ts` | 草稿审阅、参数化、验证、版本与流程包       |
| 可选顺序委派                  | `worker/delegation.ts:32`                                                                         | 指定名单、执行段、文件移交与任务预算       |
| 多模型与费用                  | `lib/providers/catalog.ts`、`worker/model.ts`、`lib/spend.ts`、`worker/budgets.ts`                | BYOK、本地模型、账本与预算                 |

`docs/evidence/context-continuity.json`、`manuals-live.json`、`atspi-comparison.json` 等保留了既有实测记录。此次审计直接检查了新增 Companion 源码，能力清单覆盖 README 尚未完整反映的增量。

## 具体缺口

优先级：P0 为当前使用与交付基础，P1 为扩展日常可用范围，P2 为产品广度。

| 项目                   | 当前代码边界                                                                                                                                       | 使用时的具体表现                                                                                                   | 建议优先级           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 聊天到办事的上下文传递 | `lib/companion/chat.ts:527` 的 `propose_errand` 只提交 goal；`lib/companion/errands.ts:45` 新建 Task，未传入关联聊天历史、附件或任务对话 ID        | “按刚才商量的格式整理这张图里的信息”依赖模型把上下文完整改写进目标；图片本身没有进入任务输入合同                   | P0                   |
| 执行中补充指令         | `lib/tasks.ts:274` 检查同一 thread 的活动任务；存在活动任务时返回 409；`components/workspace.tsx` 将 Composer 标为 busy                            | Agent 工作时，通用“再加一列”“先做另一件事”无法作为原任务补充直接发送；当前可回应它提出的请求或取消                 | P0                   |
| 办事时召回长期记忆     | `lib/agent/snapshot.ts:46` 仅取 active note，按时间取最近 30 条，总计最多 12,000 字符；办事工具只有 `memory_write` / `memory_forget`               | Companion 能读取主题总结和翻页找细节，办事 Agent 无对应召回工具；同一个助手的“记得”与“用得上”存在断点              | P0                   |
| 应用与服务连接         | 现有扩展为 `agent_zero_call` 与 Agent Zero Python 工具合同子集；检查 `lib`、`worker`、API 与依赖，未发现通用 MCP、OAuth 连接管理、OpenAPI 工具入口 | 邮箱、日历、文档平台等需要逐次走网页，或单独编写插件；聊天渠道连接也不能直接替代业务应用 API                       | P1                   |
| 文件输入与交付         | Companion 上传入口只收 JPEG / PNG / WebP / GIF；`taskInputSchema` 无附件字段；普通任务 Composer 只有文本                                           | PDF、Word、Excel、CSV、ZIP 缺少“上传 → 放入工作站 → 任务读取”的完整入口；Companion 结果回传主要是文本摘要和 taskId | P1                   |
| 历史与成果检索         | `lib/threads.ts:29` 列最近 50 个对话；`lib/thread-context.ts` 保留有界对话上下文；当前模型工具未发现历史检索入口                                   | “找到上个月那份表格继续处理”缺少跨会话、成果与附件的统一检索路径                                                   | P1                   |
| 自然语言管理例程       | `routineScheduleSchema` 支持 once / hourly / daily / weekdays / weekly；当前任务与聊天工具没有例程创建、查询、修改工具                             | 用户需要进入例程页面配置；“以后每周五这么做”尚不能直接沿聊天工具完成持久设置                                       | P1                   |
| 变化监听与事件自动化   | 当前例程合同为时间计划；未发现通用文件变化、Webhook、GitHub、邮件等 routine trigger 合同                                                           | 定时巡查可通过任务实现，事件到达时即时启动、按变化决定是否运行还需要专门接入                                       | P1                   |
| 用户演示教学           | `lib/manuals.ts:15` 从已完成电脑任务读取 action 轨迹；接管只记录人类参与；桌面入口没有教学录制会话                                                 | 已有“Agent 成功轨迹 → 手册”；缺少“我亲手操作一次 → 录制操作与观察 → 可编辑手册”的产品入口                          | P1                   |
| 自动流程覆盖面         | `lib/workflows.ts:34` 要求宿主验证过的目录任务；`lib/workflow-schema.ts:38` 与 open_application 固定 Thunar                                        | 有限自动流程覆盖目录操作；浏览器、LibreOffice 和跨软件操作主要仍走普通模型任务与参考手册                           | P1，按场景扩展       |
| 多 Agent 协作          | `worker/delegation.ts:187` 将同一个 Task 改派到下一 Agent，原执行段结束                                                                            | 已有顺序接手；群聊、并行子任务、主动互发消息、结果汇总没有对应完整产品链路                                         | P2，遵守现有暂缓决定 |
| 语音与实时通话         | 微信适配器可接收平台已转写文字；网页未发现录音、转写、朗读及实时通话入口                                                                           | 文字和图片可用；与机器人直接语音对话、打断和通话仍需接入                                                           | P2                   |
| 客户端与电脑后端       | 当前为 Web/PWA + Docker Linux 工作站；仓库没有独立桌面/移动原生客户端或多电脑 provider 层                                                          | 手机已有安装式网页；直接操作用户 Windows/macOS 桌面、切换其他云电脑需要额外后端与客户端                            | P2，按实际需求选做   |

## 最值得优先处理的三个断点

### 1. 让聊天里确认过的内容到达执行任务

当前确认为 Task 的结构主要为：

```text
聊天消息 → propose_errand(goal) → 用户确认卡 → submitTask(goal) → Task
```

`confirmErrand` 复用了原 submitTask，这是合适的基础。建议补上受限的来源消息引用、相关聊天摘要和明确选择的附件引用，让执行任务能读取完成目标所需的信息。结果沿原 proposal/task 关联回填文件卡、请求卡与进度。

同时增加原 Task 的补充输入记录，在模型下一次决策边界读取。继续使用同一 Task 和现有 worker，执行与恢复维持一条事实链。

验收例：先在聊天中确定报告格式，上传资料并确认任务，执行中补充“另存一份 CSV”；最后同一聊天展示两个成果，重启后补充输入与回传卡保持一致。

### 2. 统一记忆读取能力

`lib/companion/memory.ts` 已经有主题总结、分页和按 topic 召回。先把等价的读取能力接入办事 Agent，保留原 memories 表和已冻结的任务初始快照，再为运行中的召回记录实际读取结果。

这一轮可以直接复用现有总结与分页机制。语义向量检索适合在真实检索失败案例出现后再评估。

验收例：创建超过 30 条有效记忆，保留一条较早的报告格式偏好；Companion 能说明该偏好，办事 Agent 也能主动召回并正确用于输出。删除或修改后，新任务采用最新内容。

### 3. 补通用附件与一个应用连接

附件先支持日常高频的 PDF / CSV / XLSX，沿现有认证、存储和成果路径落盘，Task 输入固定所选文件引用，放入该 Agent 工作站并返回可追溯读取结果。

应用连接先选择一个真实需求接通：通用远程 MCP，或一个邮箱/日历连接。把实际调用纳入现有动作记录、取消、恢复与效果复核链。已有 Agent Zero Python 插件作为另一种工具来源继续使用。

验收例：上传 CSV，查询已连接服务，生成带来源的结果文件并在原聊天下载；连接失效后可重新授权，任务恢复时已有确定回执得到复用。

## 自动化与教学的后续增量

1. 在现有例程 API 上提供模型可用的创建、查询、修改、暂停工具。沿用原 `freezeRoutine`、`submitTask` 和 DBOS 调度，先覆盖已有五种时间计划。
2. 新增一种实际需要的触发器，例如带签名的 Webhook；事件先持久化与去重，再提交原 Task。后续再接文件变化或邮件，避免一次引入所有触发类型。
3. 在现有接管界面增加“开始教学 / 结束教学”，记录用户输入与对应观察；生成的内容进入原手册草稿审阅链。
4. 选择一个浏览器表单任务和一个 LibreOffice 任务，为其增加明确观察、动作与结果检查，再扩展有限流程合同。
5. 稳定以上链路后，再按用途选择语音、更多客户端或多 Agent。

## 可参考的 Rakazo 实现

Rakazo 源码位于本工作区 `grok-bot-reference/rakazo`。以下是已阅读的具体对照点：

| 主题               | 文档                                          | 实现入口                                                                                                                        | 可借鉴的具体边界                                        |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 示范教学           | `docs/skills.md:34`                           | `packages/adapters/src/teaching-session.ts`、`packages/core/src/teach-recording.ts`、`apps/web/src/pages/shell/use-teaching.ts` | 教学会话、操作与观察配对、保护输入、草稿审阅            |
| 自然语言例程与监听 | `docs/routines.md`                            | `packages/adapters/src/schedule-tools.ts`、`routine-watch.ts`、`packages/db/prisma/schema.prisma:1468`                          | schedule_create/list/update；时间、变化与外部事件的区分 |
| 应用连接           | `docs/integrations.md`                        | `apps/api/src/routes/mcp.ts`、`packages/db/prisma/schema.prisma`                                                                | 连接生命周期、认证、Bot 工具可见范围                    |
| 记忆               | `docs/memory.md`                              | `packages/adapters/src/memory-tools.ts`、`memory-context.ts`                                                                    | 可编辑笔记、共享范围与外部召回来源                      |
| 群聊与协作         | `docs/groups.md`                              | `packages/adapters/src/bot-messages.ts`、`child-bots.ts`                                                                        | 消息互发、持续 Bot 与短期助手的生命周期                 |
| 电脑与语音         | `docs/computer.md`、`docs/voice-and-calls.md` | 相关 adapter 与客户端目录                                                                                                       | 电脑来源和客户端体验可独立扩展                          |

建议以这些边界检查 OwnDesk 的接口设计，继续保留当前单工程、PostgreSQL/DBOS 与工作站实现。

## 当前质量与发布缺口

1. **当前提交 CI 被格式检查拦住。** GitHub run `42407492437` 对应本次 OwnDesk HEAD，创建于北京时间 2026-11-08 03:42:10，`npm ci` 成功，`format:check` 指向 `lib/companion/consolidate.ts` 并失败；typecheck、lint 和 npm test 随后被跳过。这一项适合先做小修，再取得当前提交的后续检查结果。
2. **发布说明落后于源码。** README 仍写 SQL0018、工作站 0.6.5；迁移登记已经到 `0027_companion_web_push`，`.env.example`、`lib/env.ts` 和构建脚本默认工作站均为 0.7.0。需要按源码、候选镜像和实际安装三个对象更新发布说明。
3. **记忆与聊天新能力需要同场景串联验收。** 当前源码分别实现了总结/召回、跑腿提议、图片与结果回传；建议把上文三条用户路径作为发布检查，直接测连续使用体验。
4. **数值控件兼容性需复核历史案例。** `workstation/controller/accessibility.py:536` 仍先选 EditableText，再选 Value；现有 `docs/AT-SPI-COMPARISON.md` 有字号文本与实际数值不同步的记录。可在相同控件上做一次定向检查，再决定接口选择的修改。
5. **当前候选的完整部署证据需要更新。** `deploy/README.md` 保留实际 VPS、公网 DNS/HTTPS、当前候选恢复与持续运行等待验条目；README 和部署文档的历史安装状态也需同步。

## 本次检查记录

- 通过本机已登录 GitHub 账号定位并克隆 OwnDesk；拉取 Rakazo 作为独立参考仓库。
- 读取 Task 受理、Companion 提议/确认/回传、记忆快照与召回、模型工具、例程、手册/流程编译、顺序委派、渠道、附件及客户端入口。
- 核对上述 OwnDesk HEAD 的 GitHub CI 步骤及失败日志，未将历史通过状态计入当前提交。
- 尝试 `python -B -m unittest test_tree_filter`，在导入阶段因当前 Windows Python 缺少 `gi` 失败，测试体未执行。未追加安装系统依赖。
- 本次新增此审计文档；业务代码、数据库和部署未修改，未调用付费模型。

推荐实施顺序：**取得当前 CI 后续结果并同步版本说明 → 聊天到任务的上下文与记忆 → 文件和一个应用连接 → 自然语言例程/一个事件触发器 → 示范教学与跨软件流程 → 按需扩展语音及协作。**
