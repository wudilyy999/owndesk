# Agent 接手与执行手册

最新上下文与记忆v2（2026-10-26）：各SDK工具返回统一有界投影，覆盖JSON/错误/拒绝/混合文本/媒体及provider-executed结果；当前控制代最多保留最近2张有效图。默认总窗口65536，预留8192输出，输入估算达80%且有有效旧段时自动摘要；规则、当前目标/合同及用户补充保留原文。摘要边界和费用复用原决定/attempt表，负数决定对应压缩；新进程复用摘要，unknown仍需原确认，明确上游超限在获准继续后强制先压缩。持久记忆沿用原事务，程序重建变更覆盖层。15项context＋原5项workflow单元、类型/格式和10项隔离账本检查通过；8次本机固定响应、0云模型、0真实桌面。主0.15.1/SQL0015/guest5、PID/env/原Task保持，新源码未打包部署；云端摘要质量、精确token元数据与缓存收益待验。详见工程docs/CONTEXT.md及context-compaction{,-ledger}.json。下方v1及旧验收记录保留其历史范围。

最新诊断（2026-10-26）：Sol两次续轮失败已定位为远端item_reference与上游store=false不保存状态不一致；网关安全检查均allow，上游404被包装成502。原成功响应/同一rs_编号与离线SDK序列化已核对。显式store=false＋完整加密推理历史的离线载荷通过；本轮未修改运行时代码/配置、未追加模型请求，真实续验仍未进行。见工程workflow-sol-gateway-diagnosis、workflow-sol-serialization及STATUS。Gemini超时原因保持独立。

最新Sol续验（2026-10-26）：已按用户要求切换openai/gpt-6.1-sol。首个34步真实候选结构通过，人工准备步骤使零动作验证暂停并取消，未ready。澄清脱敏鼠标/人工依赖后，第二个31步候选因/home/agent/尾斜杠不符合精确输入校验而被拒绝；纠正请求及用户随后明确授权的一次追加均为上游错误。当前同一Task needs_review/draft/null plan，未知费用保留且未继续请求。本次4模型attempt/2成功2unknown，已知目录估算$0.047178，0桌面动作；原Gemini两次unknown不变并取消。主预览与配置不变。5项定向单元/类型检查通过，真实三样本和ready复用仍未完成。见STATUS及workflow-sol-closeout.json；下方旧条目保留历史范围。 详细增量见流程编译设计第23节。

## 当前增量：CUA 流程编译（设计稿1.25，2026-10-26）

最新工程证据（2026-10-26）：源码0.17.0-dev/SQL0018/工作站0.6.2；C5分享及独立重新验证已实现。生产中文归档locale和终点复核循环已修正。原4个生产流程Task保持，再补1个在途观看任务，合成5完成/135动作/0模型，实际noVNC/只读/隔离/导出/390px通过；原夹具失败分别保留。原C1单次授权追加仍超时，当前2unknown/费用未知/空计划，未继续付费请求。主0.15.1/SQL0015/guest5不变，专用VM已停止；完整C4/真实模型质量/VPS/长期运行/上游项目同条件比较仍待完成。下方设计初始与旧验收条目保留历史范围，当前以工程STATUS和流程设计第22节为准。

用户已确认“成功任务沉淀为参数化自动化流程”的技术方向。按 C0—C5 推进：现场与基线→轨迹提炼→确定性执行→局部修订→全成本对照→流程分享。复用单 Agent、原 Task/DBOS/动作与控制链；多 Agent 继续暂缓。

详见 [流程编译设计](CUA流程编译与自动化复用.md) 和 [主会话指导](主会话指导-流程编译.md)。这是已确认、待实现的设计增量；下方旧版本和验收记录保留其日期与范围。本次没有改变应用版本、SQL、镜像或运行服务。

## 基础单 Agent CUA 基线（2026-10-25，设计稿1.24）

用户于2026-10-25将多Agent延后。当前按工程 [基础交付单](../BASE-DELIVERY.md) 的B1—B6推进：安装/模型配置→自然语言电脑操作→观看/接管/交还→成果下载→中断恢复/实际取消→真实模型与公网任务。团队配置、并行协作、更多交接分支、支付扩展和高级例程暂缓；下文相关规划保留为后续范围，均不阻塞基础交付。

源码候选0.15.1-dev，SQL0015、工作站0.5.0/guest5；未完成的0.16团队实现已归档移出交付路径，0016从未应用。已有0.15交接保持默认空名单。用户已明确授权后备份升级主预览至0.15.1-dev/0015/guest5，6797/6798在线。`test:delivery`复用生产Compose/HTTPS/桌面链路，只验证两项受控单Agent任务；普通公网失败记录、真实模型及完整云部署分别管理，安全门槛保持。

新增两个真实网关Task（GPT8请求/Gemini9请求）同一助手完成公网截图/DOM/键盘/交付，默认GPT；本机使用见 [QUICKSTART](../QUICKSTART.md)。本机开发网络未启用Linux守卫，真实本机通过不放行带守卫云DNS/实际VPS，后续升级仍需明确操作。此前0.8.1/预览停止/无模型/待确认内容保留为历史。

这个文件按用户要求提供。自动加载规则集中在 AGENTS.md；本文件用于让后续 Coding Agent 理解如何分阶段工作。

## 1. 项目目前是什么状态

当前设计包共16份文档；保留原上游固定版本、复用清单和14条流程，新增规划F15—F17与T19—T22。F14/T18 的 S1—S4 存储、安全提供、授权填写与恢复已通过受控检查；S5 和同条件产品对照尚未完成。

实施工程：`.`。G01—G04、控制故障隔离和可见桌面 UI 已通过；配置/provider、自然语言循环、持久化模型决定、人工等待、成果提取和基础记忆也已有受控实验。实际模型协议见模型执行与成果验证.md，控制协议见该工程 docs/control-protocol.md。真实模型、保留功能、云部署和整体性能对照仍待完成。

用户已确认总体技术方向和尽量复用原则。用户已授权开始实施，并要求可用程度达到或超过参考项目；按真实验收结果推进，不在原型阶段宣称已达到该目标。

当前源码候选 `0.11.0-dev / 工作站0.4.0 / guest4`，主服务和最后完整本机验收仍为 `0.8.1-dev / 0011`。候选新增专用 Linux Compose、HTTPS、独立配置和 guest 出站策略。真实桌面登录/worker 崩溃恢复/一次 CSV 交付通过；普通公网 HTTPS 在 fake-IP DNS 环境失败，整套部署没有通过。最近记录为工程 `docs/evidence/deployment-private-attempt.json`，原始目录 `data/experiments/pa-linux-1792898258832/attempt-1792900868801`。专用 VM 停止并保留失败数据；勿改默认 Docker context 或主服务。

F12 已在另一台空 Linux ARM 引擎通过完整受控恢复，见工程 restore.json 与 deploy/BACKUP.md；源目录 `pa-linux-1792898258832/attempt-1792903681417`，目标初次导入 `pa-linux-1792903976167/attempt-1792903998168`、通过核对 `attempt-1792904201499`。两台 VM 已停止并保留数据。私有检查点及密钥文件含实验凭据，禁止输出。

策略篡改/排空/重建的定向续验已通过，见 network-lifecycle.json；目标原始目录 `pa-linux-1792903976167/attempt-1792905740639`。十个正负端点对、三种篡改、worker 启动拒绝与 home 保留通过，Task/动作/模型数保持 6/12/17。初次夹具子网重叠失败保留，测试复用原离线公网夹具网络后通过，无普通公网/模型调用。

短程容量及自动空闲停机/唤醒已通过：基线 `attempt-1792906944635`（8任务/56受控调用），闲置 `attempt-1792907342959`（9任务/63调用）。真实 worker 在第8个任务后停止 guest/viewer、推进 epoch32→33，随后第9个任务自动唤醒并保留 home 标记；七种 SQL 资格状态与禁用分支分别登记。当前 idle worker `54af95cddc0d`、Web `600afb5d58dd`、guest `441e717eefd1`。详见工程 deploy/RESOURCES.md、capacity-baseline.json 和 idle-workstations.json；两台 VM 停止保留，勿再重跑此整组实验来更新文档。

下一步继续直连 DNS/实际 VPS、长期容量及剩余保留能力与对照。DoH 定向 curl 可达仅用于定位 DNS 影响，不替代应用网络验收；前提不变时不重复整套测试。不确定时先借鉴固定 上游项目。当前来源为 44 copied、40 adapted、1 excluded；主项目按真实 setting key 和 registry 核对仍无可用 provider/默认模型，已有云 API/费用无上限授权保持。

## 2. 接手时先做什么

1. 阅读本目录 README、方案总览和 AGENTS.md，确认当前任务涉及的阶段。
2. 检查工作目录与 Git 状态，保留用户已存在的修改。
3. 查阅证据与决策.md 中的基线和相关 SDK 来源；不要依赖对话中的旧 API 名称。
4. 找到上游对应文件和实际调用链，填好来源清单。
5. 明确本次要交付的可运行结果与最小检查，再开始改动。

## 3. 已完成的起点与下一条纵向流程

P0 的独立工程、来源记录和 G01/G02 已完成，G03/G04 也已有代表性证据。保留这些检查，不在接手时重新从建仓库开始。

以下为基础交付后可恢复的历史功能清单；当前先按B1—B6，不自动续做这些项：真实模型评估、剩余聊天管理/保险箱、周期报表真实网站/模型验收、费用趋势/Agent 汇总与顺序交接；五种时区例程、月预算及逐次费用核对已有受控证据；双期 CSV 比较与条件通知按模型协议第 15 节和工程最新证据接手；Telegram 文字入口已有受控证据，真实网络与更多联动待验收。真实模型联调使用拥有者授权配置；凭据在设置页或部署环境输入，不抄进聊天、文档或测试证据。

保险箱的 S1/S2 见 runtime-vault.json；S3/S4 的当前现场批量填写与恢复见 runtime-vaultfill.json，13 个实际任务已有受控证据。复用现有链路，普通 action 参数会落盘，禁止直接把密码作为 browser_fill.text 送进原通用链路。不要把完成审批的控制刷新例外用于凭据动作。

### 本次交接的精确起点

1. 源码候选为 `0.11.0-dev / 工作站0.4.0 / guest4`，主服务仍为 `0.8.1-dev / 0011`；S1—S4 的验收起点为 0.8.0-dev，工作站 `0.2.0` / 协议 2 / `441e717eefd1`。F12 的固定 worker/Web 镜像为 `182dc2e2d4d2` / `600afb5d58dd`，包含中断 Shell 修正；主服务尚无该修正。其他部署按实际镜像核对。
2. 先阅读 `worker/vault.ts`、`worker/actions.ts`、`lib/task-control.ts`、`lib/vault-schema.ts` 和 `workstation/controller/server.mjs` 的现有链路；保留已加入的瞬时值与持久化参数分离。
3. `tests/runtime.ts` 的 vaultfill 已有完整实际用例、样本值检查和 13 任务数量门槛。保持当前现场/回执/实际取消的检查，不以通用套件退出成功替代新功能证据。
4. 本轮已通过 6 项相关单元、类型检查、S1/S2 和模型恢复定向回归、生产构建与拥有者预览。备份/升级见 STATUS；使用旧镜像的一次中继不可达失败保留，未以放宽超时处理。
5. 桌面现已使用 Docker stdio，guest/viewer 零发布端口、viewer network=none。F12、scoped 网络与短程闲置唤醒已受控通过。历史下一条产品纵向流程按凭据设计推进 S5 身份/卡片/UPI 与支付请求保留能力；实际公网/长期容量和配对对照门槛同时保留，前提不变时不重跑已知失败部署或已通过的容量组。

6. `lib/action-receipts.ts` 与 `worker/actions.ts` 在 guest 终端及 cached-host 两个回执入口检查 Shell 的 signal/timedOut；中断需要复核，正常非零退出保持语义。原 SIGTERM-as-success 失败目录保留，shell-interruption.json 记录修正前后的请求次数；不要靠再次请求模型掩盖未知提交。

评价整体可用性前执行实施与验收第 9 节的功能门槛与配对任务；用户已选择已有云端 API 并授权费用无上限；当前 provider/defaultModel 仍为空，只待本地设置。继续可控边界实现，不重复询问服务/预算，不读取其他工程密钥，也不伪造对照结果。

## 4. 实现中常见判断

| 情况                           | 正确处理                                   |
| ------------------------------ | ------------------------------------------ |
| 已有 UI 能显示所需内容         | 迁入并适配数据，不重做视觉系统             |
| SQL 调用变异步导致上层类型错误 | 修完整调用链，不用同步阻塞或忽略类型       |
| SDK 文档与安装版本不同         | 核对本地类型和版本，更新证据与计划         |
| 网页点击后响应丢失             | 查现场和外部结果，不能直接认定未点击       |
| 用户取消后 Shell 仍在运行      | 结束实际进程、核对效果，再释放工作站       |
| 接管按钮已点但 Agent 尚未停    | 显示准备接管，等待真实停止后开放控制       |
| 模型说已完成但成果缺失         | 进入验证失败或修正流程                     |
| 新功能需要增加一个平台级组件   | 先说明当前任务为何依赖它，优先现有标准能力 |

## 5. 阶段记录模板

```text
本轮阶段与工作项：
完成的实际能力：
复用模块及来源：
新增/适配文件：
运行的验证与结果：
未验证条件或阻碍：
设计是否变化及关联决策：
下一项明确工作：
```

用户需要理解复杂设计时，使用具体任务解释，例如“下载完成后断电，恢复时先找到文件”。少用没有对应动作的抽象术语。

## 6. 停止与交接

阶段未通过时记录准确状态和失败证据，不将任务标为完成。暂时停止工作时说明最后一个稳定结果和下一步操作，不要求用户重新提供已经确认的信息。

数据迁移、真实账号操作或发布需要额外条件时，集中说明。代码读取、文档更新和已授权范围内的可逆修改可继续完成，不以流程名义增加重复确认。

S5-A source is now 0.10.0-dev, paired workstation0.3.0/guest protocol3, SQL0011 unchanged. Identity uses the existing exact-action vault_fill with up to10 fields and a1210-character derived address; missing fields roll back before any release. Cards/UPI remain rejected. Actual health must match protocol3, including custom/old images carrying a new label. Main stays0.8.1-dev/guest2; old F12/network/capacity images remain immutable. Follow credential section14 and the migration addendum; identity ten-task and original thirteen-task login-code checks passed with controlled services. Do not claim S5 or overall product complete. Local existing-cloud/unlimited-spend authorization remains; provider/default model are still unconfigured.

S5-B当前源码0.11.0-dev/SQL0011配工作站0.4.0/guest4。支付准备15任务与原13任务在期限窄修正前通过；修正后单个慢DOM案例验证零释放/输入/提交，分别存证。身份10维持guest3历史结果，不重写其版本。当前44 copied/40 adapted/1 excluded。支付选择/填写分两次批准，实际takeover/决定/DBOS同事务；来源与页面同guest，不能宣称防Shell篡改。期限在DOM读取后、解密前使用数据库当前时钟，不能用事务开始时间放行；已知回执不再解密，未知仅继续/取消。详见凭据设计15、迁移末节、工程payment-preparation.json与D59—D61。下一项S5-C提交批准/未知效果/结果证据；主服务0.8.1-dev/guest2和旧恢复/网络/容量镜像保持。真实云API与无费用上限已授权，provider/defaultModel仍待本地配置，不重复询问。

S5-C源码0.12.0-dev/SQL0012/工作站0.5.0/guest5已通过受控机制门槛：原九任务完整命令（8完成1取消）和独立edges11任务全部通过，数量门槛分别9/11。首两次失败、单任务补验及1.18部分聚合保留，原失败不改写。新增host-only Docker代理只对edges worker设置PATH，stdin不落盘；marker-before-send需杀掉进程组、核对代理死亡并在重启前撤掉断点，验证未知仅继续/取消且零点击。guest核对后变化、结果缺失/金额或商户不符、跨站/特殊控件/iframe、UPI与host回执→框架检查点窗口已实测。读凭据16.3/16.4、工程payment-submission.json与D65；生产代码/依赖/镜像未变，来源44/40/1。主服务仍0.8.1-dev/SQL0011/guest2；0.12/SQL0012/guest5只作为受控验收候选。真实模型/网站、财务服务与外部核销、候选Linux/云部署、剩余保留功能和同条件上游项目对照继续验收，S5/T18整体不标完成。用户已有云API/无费用上限授权保持，配置只通过本地设置。

F07 source0.13.0-dev/SQL0013/guest5 now supports sequential delegate(agentId,brief,files). Original eleven actual tasks passed (nine completed/two cancelled), including real busy targets and original-thread follow-up. Keep the eleven-task gate. Use existing snapshot/collectArtifacts/releaseWorkspace/target DBOS partition; prepared event before release, segment+current task+enqueue+handoff receipt in one transaction. Segment snapshots freeze model/config/memory (never API values); host files transfer to new Transfers paths with byte checks. Old segment mutations/requests are fenced; known receipts remain reusable. All segments share task step/cost budget and original conversation anchor. Delegation is bounded by the owner-approved per-task delegateAgentIds roster (empty by default); model discovery/execution cannot expand it. Squad UI, Shell handoff/large files/long chains, real models and cloud/comparison remain open. Read F07 implementation/T16/migration0.13/STATUS. Main0.8.1/SQL0011/guest2 unchanged; do not apply new migrations or restart it implicitly. Runtime fixtures must pin protocol5 instead of inheriting old main WORKSTATION_IMAGE. Historical reports retain actual versions; new reports derive current source/migration metadata. Existing cloud API/unlimited-spend authorization stands, keys only local settings.

Source0.14.0-dev/SQL0014 adds an explicit per-routine delegateAgentIds roster (empty by default). Freeze nonempty ids with the existing routine run input; preserve omitted task fields for empty rosters and old request keys. Plan edits/toggles never mutate accepted runs. Reuse assertDelegationRoster at plan save/Task admission and the same F07 worker/queue/segment; no second executor. Three actual controlled tasks passed (two no-file handoffs and one denied delegation), including actual DBOS timed trigger and phone form. Preserve the three-task gate, the initial fixture-history failure and historical0.13 eleven-task report; do not relabel earlier suites as0.14 regressions. Guest stays0.5.0/protocol5; provenance44/40/1. Telegram roster entry/squad UI/real models/new-candidate deployment remain open. Main0.8.1/SQL0011/guest2 unchanged;0012-0014 not applied. Keep existing cloud API/unlimited-spend authorization; configure only locally.

Source0.15.0-dev/SQL0015 adds Telegram owner-approved delegation rosters to the existing connection. API grants bind generation+source agent; inbox first transaction freezes nonempty ids, empty input remains omitted. /use or Web agent selection, rotate/unpair/token/bot-identity changes clear permissions; /new preserves the same source. Already frozen inbox commands retain their roster after edits; revoke their generation or cancel an accepted Task explicitly. Same-context drafts survive polling; server rejects stale source/generation. New3 actual tasks and original8 groups/5 tasks passed (combined7 completed/1 cancelled;3 original Recovery Lab tasks); keep both count gates and historical reports. Tests pin guest5 and identify ask_user by name despite initialization screenshots. Main0.8.1/SQL0011/guest2 unchanged,0012-0015 not applied. Original squad selection/@member, retained features, real services/new deployment/comparison remain open. See model execution21/migration0.15/STATUS. Existing-cloud API/unlimited-spend authorization stays; credentials only in local settings.

## 7. 接手流程编译（1.25，2026-10-26）

主会话读取《主会话指导-流程编译.md》，其中包含可粘贴指导文本。先复核当下源码与 STATUS，再按 C0/C1 做最小纵向实验，C2 完成一个新参数可复用流程。

阶段报告：实际功能、复用/新写范围、输入与通道、动作/模型调用、已知/未知费用、成果核对、接管/取消/恢复结果及支持边界。新协议/迁移与现有版本分别管理；产生新证据后更新 STATUS。
