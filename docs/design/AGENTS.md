# Coding Agent 开发指令

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

## 阅读顺序

先读 README.md、方案总览.md、开发准则.md、设计审查.md；实现具体功能前读详细设计.md、模型执行与成果验证.md，以及流程设计.md、迁移说明.md、实施与验收.md 中对应编号。凭据流程另读凭据与授权设计.md（F14/T18）。agent.md 提供交接与汇报方法。

当前目录是设计包，应用代码在 `.`。先读该工程 docs/STATUS.md 和对应证据；本设计包不运行应用命令。规划接口、受控实验、真实模型结果与产品验收分别汇报。

## 已确认目标

- 产品是单拥有者自托管的个人 Agent，使用独立 Linux Docker 桌面，网页和 Telegram 交互。
- 尽量复用 上游项目 固定提交 `7b08375f3664e550ad89af83fd69923033b6b9c2` 的 UI、provider、工具 schema、桌面和渠道代码。
- 采用 Next.js、TypeScript、AI SDK、独立 worker、DBOS、PostgreSQL/Drizzle、Playwright、Better Auth、Caddy。
- 先验证 G01—G04，再扩展完整业务。Mac 原生、多租户、并行团队、插件市场和复杂向量记忆不在首版范围。

## 必须保持

1. 用户任务、工作站执行段、工具动作各有稳定标识。只有实际换工作站或需要新执行段时才新增段。
2. 提交与入队同事务，来源请求去重；使用核查过的 SDK 接口，不虚构方法名。
3. 执行循环拆为模型和动作步骤，复用旧 runtime 中已存在的上下文与模型兼容处理。
4. 外部结果未知先核对，任意 Shell 不默认重试；截图失败不等同于动作失败。
5. 取消要核对进程和控制连接实际停止；前端 viewOnly 不充当授权边界。
6. 工作站串行，人工接管显式交还；旧控制和观察引用失效后重新观察。
7. 成果有验证级别；模型自评不能替代程序检查或人工确认。
8. 密钥不进入持久化步骤参数、结果、事件或日志；模型发起的任意电脑命令只在工作站执行，控制面记忆/凭据工具由受信任代码限定数据库操作。
9. 上游代码保留版权和来源，第三方许可分别记录；按上层用户要求处理 PR 和提交署名。
10. 只改必须修改的地方，根因修复，保留明确错误，不吞异常，不增加推测性抽象。
11. 凭据只以引用进入模型和恢复账本，自动填写绑定当前动作/站点/现场；未知填写不自动重复，旧授权不刷新控制版本后继续使用。
12. 保留通用 guest Shell 时，明确秘密进入 guest 后可被站点及 guest 代码接触；不以截图遮罩承诺对模型代码的凭据隔离。

## 工作与验证

使用 rg 查找调用链，先确认依赖再改动。每次尽量完成一个可验证纵向流程。先使用固定模型响应和可控网页，真实模型联调用已授权配置并记录费用。

仅运行本次变更相关检查；阶段结束做对应集成验证；完整验收只在发布候选或确有影响时运行。遵守 仓库根目录的 `AGENTS.md` 的工具与算法限制。

本文件不要求普通实现步骤反复征求许可。需要真实账号、凭据、额外产品范围或对外发布时，说明具体缺失或影响，并引用相应用户要求。未获用户授权不新建其他聊天、不委派子 Agent、不向外部人员发消息。

## 汇报

报告完成的实际功能、复用与新写范围、已执行验证和未验证条件。实现与设计发生冲突时更新设计决策，不悄悄绕过验收或保留新旧两套运行入口。

本目录是设计文档维护源；变更同步至 `docs/design`，保持同名文件内容一致。运行状态继续由工程 docs/STATUS.md 和证据管理，规划功能不自动变为已实现能力。

Telegram 按 F09 的冻结 inbox、游标和 outbox 流程工作；未知发送需明确重试授权。配对代、通知和参数版本共同限制回调。真实 Telegram、模型和公网部署与受控检查分别验收。

0.5.0-dev 的逐次费用账本、月预算、人工核对与价格快照按模型协议第 13 节实现；升级先排空旧执行段。保存与人工核对的费用来源分开，月预算不等同于服务商硬额度。

例程按 F10 与模型协议第 14 节实现：一个 DBOS 定时唤醒、业务游标/运行先冻结、原 Task 入口、独立对话与工作站串行。日期以计划时区和预定时刻固定；未知外部效果继续按既有复核规则处理。

周期比较按模型协议第 15 节：两个明确 CSV 合同、宿主成果字节、精确数值与程序决定。只有已完成且程序 send=false 的通知可静默，问题/异常继续原渠道；0.6.0-dev 排空旧段后升级，不能以模型摘要替代比较。

0.8.0-dev / 0011 与工作站 0.2.0 已通过 S1—S4 受控验收，本机 Web/worker 已升级。runtime-vaultfill.json 覆盖 13 个实际任务、一次授权、密码/验证码、三类回执窗口、部分/超时与实际取消。来源仍为 44 copied、36 adapted、1 excluded；真实模型、S5、云部署和整体对照未完成。

接手凭据流程先读凭据设计第 13 节和实际报告。test:runtime:vaultfill 已有实际用例与 13 任务数量门槛，保持该覆盖；日常只跑受影响检查。未知填写仅允许继续/取消复核，旧授权不得刷新 epoch。源码、运行版本、已应用迁移和已验收能力分开报告。

实施顺序按新版 P7：稳定链路具备后提前完成 Linux 私有部署、网络负向检查与恢复演练；保留功能及同条件对照继续作为整体替代门槛，不为提前部署降低安全条件。

0.8.1-dev 桌面传输走 Docker exec stdio，guest/viewer 无发布端口，viewer network=none；保留只读侧、原票据与 epoch。旧发布端口/网络的容器在启动前拒绝，排空后显式冷重建，保留 home/profile。新传输通过不等于 Linux guest 网络隔离或完整恢复通过。

用户已确认真实验收用已有云端 API、费用不设上限；当前项目尚无 provider/model 配置。只通过本地设置页接入，不重复询问这两项授权，不读取其他工程凭据。未知计费/外部效果继续逐次复核。

源码 0.9.0-dev 的 Linux Compose/HTTPS 与宿主 iptables guest 策略处于部分验收，主服务仍为 0.8.1-dev/0011。最近尝试普通公网 HTTPS 失败：本机 DNS 回答为 198.18/15 fake-IP，启用规则后命中保留范围 DROP；DoH 诊断成功不代表应用已支持该网络。保留失败门槛，不放行保留地址或以固定公网 IP 演示取代普通 DNS 验收。前提未变化时不重复整套实验。接手先读部署说明与 deployment-private-attempt.json，继续 F12/直连环境验证；当前来源 44 copied、38 adapted、1 excluded。

始终按本包设计和流程推进；不确定时先核对固定 上游项目 对应调用链，优先复用可保留部分。发布前仍需完整第三方镜像/依赖许可清单、真实模型/服务与同条件对照。

F12 已在两台独立 Linux ARM VM 受控通过（restore.json）：format-2 全库、成果、六个 home、固定镜像与独立密钥；旧会话/票据/现场授权失效，例程暂停、Telegram 撤销，未知请求仍待复核。操作见工程 deploy/BACKUP.md；恢复完成只启动 PostgreSQL，核对后显式启用应用。两台 VM 已停止，主服务保持 0.8.1-dev。普通公网网络、实际 VPS/ACME 与跨架构仍未验。

Shell 的 signal 或 timedOut 回执在 guest-terminal/cached-host 两个入口均进入复核，不推动新模型规划；普通非零退出保留原含义。使用实际镜像 ID 区分已修正候选和未升级主服务。容量与直连 DNS 门槛继续推进，策略生命周期的后续证据见下文；整体目标保持进行中。

网络策略定向续验现已通过（network-lifecycle.json）：十个有真实宿主正向对照的端点被 guest 阻断，受控公网站点可达；三种规则/顺序篡改拒绝检查/创建，缺出站规则拒绝 worker 启动，排空/显式重建后恢复 home。任务/动作/模型数未增加。普通公网、实际云网络、持续 root 篡改防御和容量另验。接手继续容量/直连门槛与剩余产品能力，勿重跑已知 fake-IP 全流程；VM 已停止，原失败保留。

短程容量与空闲停机已通过（capacity-baseline.json / idle-workstations.json）：8/9 个实际任务，真实 leased-worker 定时停机后由第9任务唤醒，home 保留；七种 SQL 状态属合成资格检查。WORKSTATION_IDLE_MINUTES 默认15、0禁用，先核对 idle/无占用/无待交接/无未终止任务，持原生命周期锁重查，再停机、核对、推进epoch并清boot。保留容器/home，不开启 guest 独立idle watcher。受验worker54af95cddc0d，主服务0.8.1-dev未升级；应用0.9/SQL0011/guest2及来源计数不变。长期容量、最低规格、闲置后的真实登录/人类等待、公网与真实模型/对照另验。下一项按剩余产品范围推进，不反复跑已通过的容量实验。

S5-A source is now 0.10.0-dev, paired workstation0.3.0/guest protocol3, SQL0011 unchanged. Identity uses the existing exact-action vault_fill with up to10 fields and a1210-character derived address; missing fields roll back before any release. Cards/UPI remain rejected. Actual health must match protocol3, including custom/old images carrying a new label. Main stays0.8.1-dev/guest2; old F12/network/capacity images remain immutable. Follow credential section14 and the migration addendum; identity ten-task and original thirteen-task login-code checks passed with controlled services. Do not claim S5 or overall product complete. Local existing-cloud/unlimited-spend authorization remains; provider/default model are still unconfigured.

S5-B当前源码0.11.0-dev/SQL0011配工作站0.4.0/guest4。支付准备15任务与原13任务在期限窄修正前通过；修正后单个慢DOM案例验证零释放/输入/提交，分别存证。身份10维持guest3历史结果，不重写其版本。当前44 copied/40 adapted/1 excluded。支付选择/填写分两次批准，实际takeover/决定/DBOS同事务；来源与页面同guest，不能宣称防Shell篡改。期限在DOM读取后、解密前使用数据库当前时钟，不能用事务开始时间放行；已知回执不再解密，未知仅继续/取消。详见凭据设计15、迁移末节、工程payment-preparation.json与D59—D61。下一项S5-C提交批准/未知效果/结果证据；主服务0.8.1-dev/guest2和旧恢复/网络/容量镜像保持。真实云API与无费用上限已授权，provider/defaultModel仍待本地配置，不重复询问。

S5-C源码0.12.0-dev/SQL0012/工作站0.5.0/guest5已通过受控机制门槛：原九任务完整命令（8完成1取消）和独立edges11任务全部通过，数量门槛分别9/11。首两次失败、单任务补验及1.18部分聚合保留，原失败不改写。新增host-only Docker代理只对edges worker设置PATH，stdin不落盘；marker-before-send需杀掉进程组、核对代理死亡并在重启前撤掉断点，验证未知仅继续/取消且零点击。guest核对后变化、结果缺失/金额或商户不符、跨站/特殊控件/iframe、UPI与host回执→框架检查点窗口已实测。读凭据16.3/16.4、工程payment-submission.json与D65；生产代码/依赖/镜像未变，来源44/40/1。主服务仍0.8.1-dev/SQL0011/guest2；0.12/SQL0012/guest5只作为受控验收候选。真实模型/网站、财务服务与外部核销、候选Linux/云部署、剩余保留功能和同条件上游项目对照继续验收，S5/T18整体不标完成。用户已有云API/无费用上限授权保持，配置只通过本地设置。

F07 source0.13.0-dev/SQL0013/guest5 now supports sequential delegate(agentId,brief,files). Original eleven actual tasks passed (nine completed/two cancelled), including real busy targets and original-thread follow-up. Keep the eleven-task gate. Use existing snapshot/collectArtifacts/releaseWorkspace/target DBOS partition; prepared event before release, segment+current task+enqueue+handoff receipt in one transaction. Segment snapshots freeze model/config/memory (never API values); host files transfer to new Transfers paths with byte checks. Old segment mutations/requests are fenced; known receipts remain reusable. All segments share task step/cost budget and original conversation anchor. Delegation is bounded by the owner-approved per-task delegateAgentIds roster (empty by default); model discovery/execution cannot expand it. Squad UI, Shell handoff/large files/long chains, real models and cloud/comparison remain open. Read F07 implementation/T16/migration0.13/STATUS. Main0.8.1/SQL0011/guest2 unchanged; do not apply new migrations or restart it implicitly. Runtime fixtures must pin protocol5 instead of inheriting old main WORKSTATION_IMAGE. Historical reports retain actual versions; new reports derive current source/migration metadata. Existing cloud API/unlimited-spend authorization stands, keys only local settings.

Source0.14.0-dev/SQL0014 adds an explicit per-routine delegateAgentIds roster (empty by default). Freeze nonempty ids with the existing routine run input; preserve omitted task fields for empty rosters and old request keys. Plan edits/toggles never mutate accepted runs. Reuse assertDelegationRoster at plan save/Task admission and the same F07 worker/queue/segment; no second executor. Three actual controlled tasks passed (two no-file handoffs and one denied delegation), including actual DBOS timed trigger and phone form. Preserve the three-task gate, the initial fixture-history failure and historical0.13 eleven-task report; do not relabel earlier suites as0.14 regressions. Guest stays0.5.0/protocol5; provenance44/40/1. Telegram roster entry/squad UI/real models/new-candidate deployment remain open. Main0.8.1/SQL0011/guest2 unchanged;0012-0014 not applied. Keep existing cloud API/unlimited-spend authorization; configure only locally.

Source0.15.0-dev/SQL0015 adds Telegram owner-approved delegation rosters to the existing connection. API grants bind generation+source agent; inbox first transaction freezes nonempty ids, empty input remains omitted. /use or Web agent selection, rotate/unpair/token/bot-identity changes clear permissions; /new preserves the same source. Already frozen inbox commands retain their roster after edits; revoke their generation or cancel an accepted Task explicitly. Same-context drafts survive polling; server rejects stale source/generation. New3 actual tasks and original8 groups/5 tasks passed (combined7 completed/1 cancelled;3 original Recovery Lab tasks); keep both count gates and historical reports. Tests pin guest5 and identify ask_user by name despite initialization screenshots. Main0.8.1/SQL0011/guest2 unchanged,0012-0015 not applied. Original squad selection/@member, retained features, real services/new deployment/comparison remain open. See model execution21/migration0.15/STATUS. Existing-cloud API/unlimited-spend authorization stays; credentials only in local settings.

## 流程编译接手约束（1.25）

先读《主会话指导-流程编译.md》和《CUA流程编译与自动化复用.md》，按 C0—C5、T19—T22 推进。该增量接 P6/F11，单 Agent 和部署剩余门槛分别验收。

同 Task 回执恢复与跨 Task 方法复用分开；来源轨迹用于提炼，新运行走原 executeAction 并产生新回执。固定版本和参数在受理时冻结，旧授权与观察在当前现场重新取得。宿主解释有限计划，任意生成代码只在 guest 执行。各阶段进入原请求/费用账本。

C0 定向核对无提示 Thunar 任务、坐标和语义观察。先做显式保存/运行与有限修订，市场、训练和多 Agent 暂缓。本次仅改文档；主会话以实际代码、未提交改动和具体操作授权为准继续实施。
