# Agent handoff

## 2026-10-30：换机开发快照

本仓库是脱敏后的开发副本。先阅读 docs/DEVELOPMENT-TRANSFER.md；下方旧主机的PID、运行状态和绝对路径仅作历史记录，新电脑需要独立初始化。源码为0.17.0-dev / SQL0018 / 工作站0.6.5 / guest6；多Agent仍暂缓。

原主机.env、账号、模型密钥、数据库、浏览器登录态、桌面文件、截图及私有回滚归档均未上传；运行目录按.gitignore留在各自机器。原始证据保存在原设备，仓库文字报告仅做路径脱敏，原成功、失败与未知费用结论保持。授权记录仅描述对应历史任务；在新电脑调用真实模型、恢复外部动作时按当前用户的授权执行。

## 2026-10-29：OwnDesk 已部署本机预览，旧运行构件已清理

用户明确授权“更新，然后把旧的删了”。本条覆盖此前保持旧主实例的部署边界；历史条目与原报告保留当时状态。6797 为当前源码生产 Web 构建，6798 为当前源码 worker 0.17.0-dev，桌面及 viewer 为正式 Dockerfile 构建的 owndesk-workstation:0.6.5（f3842ddb48f4），guest6 / SQL0018。Web/worker 当前为宿主进程；新版 Compose 镜像及真实 VPS 发布验收保持各自范围。

数据库 dump 实际恢复并逐行核对47表；启动后29张稳定业务表保持。原账号、模型配置和密钥、12Task/65attempt/58action/7artifact保留，0新增Task/0模型调用。原home卷挂载/home/agent，浏览器配置改为.config/owndesk-browser，621个普通文件逐字节保持；默认助手改为OwnDesk Assistant，其他助手保持，旧桌面票据撤销并重建控制代。实际网页标题、原账号登录、成果下载、实时桌面、鼠标打开浏览器、接管及交还均已核对。

旧Web和worker收到TERM后50秒仍未退出；排空状态再次确认0active/0pending后终止对应旧进程，显式停止原桌面，再执行一致备份。该次关闭情况写入私有shutdown-check.json，未冒充正常退出。数据库、home、成果、旧Web及原运行镜像回滚归档保留于data/backups/owndesk-upgrade-2026-10-29T13-28-25-524Z/，原.env独立保存于受限key-backups。此归档含私有数据，只在本地使用。

已删除22个旧停止容器、18个旧镜像引用及约1.55GB旧/临时Web构建；全部98数据卷及其他项目保持。Docker镜像汇总11.48GB→5.439GB；macOS当前可用约50GiB，这两种口径分别记录。当前运行主桌面与viewer继续使用同一原home/display卷。证据docs/evidence/owndesk-upgrade.json；后续复用既有验收，避免重跑历史付费任务。

## 2026-10-29：产品更名 OwnDesk（源码已验证，主实例保持）

产品、npm包、UI/导出、默认镜像与Linux桌面脚本已统一OwnDesk/owndesk，桌面用户与目录改为agent及/home/agent，模型截图元数据改为providerOptions.owndesk。许可证和上游sourcePath保留；原docs/evidence与实验回执不改写。DBOS身份、Docker标签、快照格式及浏览器草稿键保持稳定。工作目录及主6797/6798/.env/数据库/home保持，旧镜像不会自动获得新名称或新目录；发布需新镜像配对与显式迁移，见docs/RENAMING.md。

类型及45项定向单元通过；一次旧断言把已重新接入的AT-SPI依赖误列为撤回对象，收窄至编号/OCR并明确检查原生依赖后该文件2项通过，未重复全套。复用保留依赖层的隔离镜像通过5组浏览器冷启动/接管交还/重启/并发DOM截图和1项原生包/AT-SPI检查，0模型/0业务Task；这属于更名打包检查，未做从零正式生产构建。2临时容器和镜像已删除，188份原始报告逐字节保持，运行资源数保持33镜像/28容器/98卷。证据docs/evidence/owndesk-renaming.json；源码备份在data/backups/owndesk-rename-20261029-204502/。历史条目继续保留当时实际镜像名，勿为更名重跑历史付费任务。

## 2026-10-29：用户授权清理历史测试资源

清理记录见 data/backups/storage-cleanup-20261029-182944/。三份实验 .next 已删除，旧实验镜像及引用它们的97个停止容器已清理；当前0.6.3、最新0.6.5工作站、0.17.0-dev和atspi-candidate的Web/worker保留。独立Colima测试profile pa-linux-1792959408122 已删除，12卷（含两套PostgreSQL）及3容器可写层先完整归档至该目录isolated-test-vm-data.tar.gz并通过gzip/目录检查。需要恢复旧VM状态时使用归档；复现构建时重建相应产物。保留原报告/回执/费用记录，避免为恢复缓存重跑已验收的付费任务。主预览、主环境全部数据卷及其他项目资源保持。

## 2026-10-29：GUI压缩连续性根因已修复并真实验收（最新）

用户明确请求上限属于正常暂停，重点维护原目标/当前状态并解决实际卡住。旧80预算任务已满足宿主目标，但因摘要把应用/目录/操作进度写成未知，反复打开字体对话框4次；原40/80任务、回执、费用和失败目录全部保留。根因是摘要请求未带目标/用户补充，旧工具输出再对SDK包装递归裁剪，语义证据丢失。

lib/agent/context.ts现向摘要传入currentTask，从完整原历史生成有界语义来源，保留窗口/路径/文本/值/选中状态及错误，明确已确认进度/待核实项/下一步。原目标/合同/用户补充在普通请求保持原文，原checkpoint持久化兼容，最多2张有效图及旧授权失效保持；没有新增工具、SQL、依赖或每轮摘要器。源码变更尚未打包部署。

实际6.1 Terra Task f9085c12-4d5b-4d11-81ef-f3f1386b51bf，经13次真实压缩、46次普通决策、45条GUI动作后complete_task，59请求/约710秒。文件字节/源文件保留与移动/字体11/最终交付窗口全部独立通过，0unknown；字体对话框进入2次（修改与重新打开确认），原生动作工具调用0，仍是截图键鼠+AT-SPI观察。隔离上限200，实际59低于原80；不把预算调大当作修复证据。

见docs/CONTEXT.md最新段、docs/evidence/context-continuity.json与data/experiments/gui-complex-1793263334969/verified-results.json。5Task合计196真实请求/40摘要/153动作/0unknown，全部Terra请求无价格，总费用未知。此前控制台导航与缺失目标案例没有重跑。原回执深比较、只读home卷的三个目录字节核对通过；原失败数据不改。实验worker/桌面已停止，主6797/6798/PID26072/25794/.env与12Task/65attempt/58action/7artifact/0active保持，工作站仍0.6.3。勿重复--run/--native-tail/--continuity，这些授权测试键均已消耗。

模型证据图片使用原回执导出的*-last-observation.jpg和逐动作frames。早期*-final.png辅助scrot导出复用了旧临时文件，保留为历史，既未进入模型也未参与评分；测试代码已改为导出最后原观察，不能因图片导出问题重跑模型。相同历史离线前后对照和6个不同上下文定向单元/类型检查通过；未声称全模型/全软件/竞品优势或统计成功率。下方原生迁移及更早记录保留其各自范围。

## 2026-10-29：完整 AT-SPI 迁移开发版已验收

固定上游 a0-connector 3741c880 的9个规范AT-SPI接口已迁移到原X11/Xvfb/XFCE/noVNC与Task/DBOS/action/journal/control链，11项要求逐项通过。窗口/PID范围、有界完整树、index/path/语义定位、press/focus/set_value、三种派发、双重焦点确认输入/submit、@a0 context/replace/release均接入；原图与最多两张有效图保留，编号/OCR继续撤回。见docs/AT-SPI-MIGRATION.md、docs/evidence/atspi-migration.json的requirementAudit。

干净工作站personal-agent-workstation:0.6.5（27dfeeb41697）已构建并刷新当前源码，7个最终原生专项通过，关键源码与许可证逐字节匹配；原浏览器冷启动/交接/DOM兼容5组通过。正式根Dockerfile的worker/web候选0.17.0-atspi-candidate（154387cefef5 / b9ab423c2df8）已完成导入和实际Web/login200。原构建80750、52368、16751均已结束，不要再轮询或重复构建。

最终生产worker容器配对Task bb4f2b95-960b-4a1d-955c-6531bf5d8732（DB agent_native_35ecfdb9a07349a2ad44f5a5aa41491e）完成真实重启/DBOS恢复：11次本地决策+1次本地摘要、10条动作，重新发现窗口并focus/set_value/submit到/tmp，原回执不重放；0云请求/0新增unknown。此前真实取消和guest未知效果故障注入证据沿用，成功样本不重跑。关闭只读审计7隔离Task/65attempt/54action，保留早期4unknown及原失败；没有重试历史收费请求。真实模型质量、任意软件支持与跨宿主云部署没有据此认证。

主预览未部署：6797/6798原PID26072/25794、.env448字节及2026-10-26T15:55:04.877Z保持；仍0.17/SQL0018/工作站0.6.3/guest6，12Task/65attempt/58action/7artifact/0active。隔离Web/worker/桌面均已停止。证据root为data/experiments/atspi-migration-1793251516845，新增final-db-audit.json与main-final.json。用户另有明确升级授权前保持开发版本，无SQL迁移。

本条覆盖下方“待干净构建/待容器Task/目标active”的历史进展；下方原失败与授权边界继续保留。

## 历史进展：两个原构建保持运行（2026-10-29，现均已完成）

本回合属于进展＋已核实等待：逐方法补齐并定向验证多处真实迁移缺口，正式根Dockerfile Web/worker构建通过，Web实际/login200、9工具/许可证导入、worker到Mac/PG/Docker访问均通过。主预览未动，整体仍未完成。

接下来先轮询原句柄：工作站80750/happy_ellis（clean-build.log，当前APT chromium 79.4MB下载中，已持续增长）；应用16751（official-worker-build-2.log，随后official-web-build-2.log），后者仅因最后补上“后台控件树坐标回退需先前台聚焦并取新图”的提示而刷新正式候选。不要并发启动重复构建，观察超时不表示构建停止。旧正式应用首次构建成功的证据仍保留。

工作站完成后，用当前源码缓存重建0.6.5一次以刷新很早捕获的controller。验证干净依赖/AT-SPI能力/许可证与实际app_name/count，选取native scope/actions/tag/long-type/safety/applications必要分支一次，并复用PA_BROWSER_TEST_IMAGE=personal-agent-workstation:0.6.5 tsx tests/browser-startup.ts确认新Chromium的旧DOM/冷启动兼容（不跑全仓套件）。之后运行一项最终生产容器配对Task：ATSPI_TEST_IMAGE=personal-agent-workstation:0.6.5 ATSPI_WORKER_IMAGE=personal-agent-worker:0.17.0-atspi-candidate ATSPI_MODEL_HOST=host.lima.internal tsx tests/atspi-native-runtime.ts --recovery-tail。该容器模式已类型检查、网络前检，尚未实际跑Task；会自动创建独立DB/owner/keys并清理自己的worker容器，0云模型。不要重跑原host成功Task或重试历史收费unknown。完善证据并逐项审计后才可complete；用户主预览仍须另授权部署。

## 2026-10-29：上游逐方法补验与正式应用镜像（目标仍 active）

此前回合为具体进展：补齐整桌面索引/路径/语义目标推导窗口、@a0元信息/最新单令牌/幂等释放/只读与标题检查、隐藏范围沿用、长输入独立执行预算、空语义条件及submit组合边界、Action读取失败和缺失PID的无效果拒绝。scope-parity/tag-parity/long-type/hidden-semantic/preflight-tail/window-resolution已分项验证；3项native输入/上下文/实际SDK定义单元通过，0云。窗口查询现复用上游ID解析直接读取路径/PID，移除100应用暗限，补应用名/可见性/count与截断；105应用及限额/精确窗口/错误路径的纯检查通过。原fault注入后纯导入错误与Colima不可见宿主bind失败保留，没有重发成功原生输入来刷结果。

根Dockerfile正式Web与worker均构建成功：personal-agent-{web,worker}:0.17.0-atspi-candidate。Web实际9工具/许可证导入和/login200通过，隔离Web已停止。worker到Mac loopback（host.lima.internal）及network=host到Postgres发布端口55433已确认。tests/atspi-native-runtime.ts增加ATSPI_WORKER_IMAGE/ATSPI_MODEL_HOST可选生产容器模式，仅测试代码；最终可用ATSPI_TEST_IMAGE=personal-agent-workstation:0.6.5 ATSPI_WORKER_IMAGE=personal-agent-worker:0.17.0-atspi-candidate ATSPI_MODEL_HOST=host.lima.internal tsx tests/atspi-native-runtime.ts --recovery-tail 做一项配对Task，勿重跑原host成功样本。该新模式尚未运行实际Task。

干净工作站仍为原80750/happy_ellis实时构建，日志clean-build.log已到APT第165个包附近，不能当作完成，也不要重启重复构建。构建完成后必须用当前controller缓存重建（原构建上下文很早），再检查依赖/许可证/版本与原生专项/上述容器Task。主预览和原密钥/费用记录保持，整体goal active。见docs/evidence/atspi-migration.json新证据。下一步只补最终镜像和容器配对所需检查，不重复全量套件。

## 2026-10-29：完整 AT-SPI 能力迁移（开发版，目标仍 active）

原生9工具、窗口/PID范围、完整有界树、索引/路径/语义匹配、press/focus/set_value、后台/前台、已验证窗口输入与submit、@a0 context/replace/release已接入原Task/DBOS/action/journal/control链。复用a0-connector 3741c880的34个命名辅助函数，保留MIT许可证；适配X11，保留原图与两图规则，编号/OCR仍撤回。见docs/AT-SPI-MIGRATION.md、docs/evidence/atspi-migration.json。

真实GTK、Thunar、XFCE Appearance/Terminal已验：无Action标签页明确返回none，随后原坐标点击并用selected核对。恢复Task11决策+1摘要、本机取消Task5决策通过，均本地固定响应/0云；worker重启后重新枚举窗口，focus/set_value/submit到/tmp，原回执不重放；取消确实释放容器边界。guest故障注入在一次真实效果后截断回执，unknown跨重放和冷重启保持，原效果仅一次。原observe/actions部分已过分支只引用证据，原报告仍失败；四个失败本地runtime的4unknown保留（6隔离Task合计53attempt/44action记录），不碰历史付费unknown。

本轮根因修复：Text接口GI重名、application树层、焦点缓存、tag路由、模型上下文丢focus/dispatch字段、动作后观察预算退回深度5、submit前目标字段聚焦、PID范围检查。原同名对象重绑定/接管/密码拒绝保持。隔离Next生产构建、基于已有生产runtime的候选worker镜像9工具/许可证实际导入通过；类型/定向单元/JS/Bash/Python语法通过。真实模型准确率未评估。

仍须完成干净工作站0.6.5镜像：构建session80750、容器happy_ellis仍在APT下载，日志data/experiments/atspi-migration-1793251516845/clean-build.log。不要因轮询超时启动重复构建。现0.6.5-atspi测试镜像复用历史依赖层；干净构建完成后用当前源码缓存重建一次（该构建启动时的controller早于后续修正），再对最终镜像做定向验收。不要标goal complete。未发布、无SQL迁移。

主6797/6798/PID26072/25794/.env固定0.6.3保持，12Task/65attempt/58action/7artifact/0active未变；不要隐式升级/重启。实验探针已停止，其他测试容器自停，干净构建保持运行。

## 2026-10-29：只读 AT-SPI 进入原桌面观察（开发版）

按用户新要求接入原生控件观察，保留原图、坐标/键盘输入及原动作/回执/控制链。没有恢复截图编号、OCR、desktop_observe/desktop_act 或语义动作。captureDesktop 附带活动窗口内 AT-SPI 的 name/role/text/value/states/bounds 与可用性/截断/采样时间；输入后自动刷新，密码角色不读取正文，失败时显式 unavailable 并保留截图。上下文复用完整元素投影，最多两张近期有效图。见 docs/AT-SPI-OBSERVATION.md 与 docs/evidence/atspi-observation.json。

18 项 context 单元、真实 Thunar/GTK 的8组隔离检查、类型/格式/JS/Bash/Python 检查通过；真实坐标点击后读到新状态，回执重放/旧观察/接管检查保持。模型输入通过实际 SDK 的本地 fetch 捕获验证，0云请求/0业务Task，没有声称真实模型点击准确率提升。最初缓存测试镜像 home 权限、夹具漏 application 参数及软件源超时记录保留；最终夹具复用已装 GTK 库，无额外测试包下载。

源码默认工作站候选0.6.4/guest6，新增 atspi-observation-v1，无SQL迁移。真实测试镜像0.6.4-atspi由既有含依赖镜像覆盖当前源码构建；干净 Debian 构建下载缓慢已停止，正式镜像打包待验。主6797/6798/PID26072/25794/.env固定0.6.3及12Task/65attempt/58action/7artifact/0active保持，禁止隐式升级。下方10月27日撤回条目仍适用于编号/OCR/语义动作，本条仅恢复只读 AT-SPI 观察。

## 2026-10-28：语义手册 Terra 续验与九单元对照已完成（开发版）

见 docs/MANUALS-BENCHMARK.md、docs/evidence/manuals-benchmark.json、data/experiments/manual-benchmark-1793096130841/verified-results.json。原 semantic Task 0d7364e6-15b5-4e36-b07a-a92a89991c78 的 Sol attempt1 仍为 unknown。用户指示“改为使用6.1-terra”，已核对网关 ID gpt-6.1-terra，原复核链单次重试成功；原快照、模型和未知费用均保留。授权已消耗，禁止重复 --terra-retry；成功来源、草稿和九单元均不重跑。

三案例×无手册/旧版手册/语义手册各一次，执行统一 Terra、纯桌面截图/键鼠、新会话和新页面。导航三组均通过；私有交接流程+布局变化仅语义手册通过，实际华北二/db-eval-209/归档日志/最近30分钟/仅异常/已应用；缺失目标仅旧版手册触发 ask_user，通过检查，另外两组安全停止且未进错实例，但 complete_task 收尾，未达到等待答复标准。总计 none1/3、lossy2/3、semantic2/3；不能声称语义版全面优于旧版。下一步保留具体操作语义并补明确阻塞/询问分支，同时落地真实截图语义提炼。未改生产编译器、用户界面或模型默认设置。

九单元共75次完整回执/60个Task GUI动作/0新增unknown；本轮额外1次Terra编译成功。整个准备与试验累计13个逻辑Task/120attempt（119成功+原1unknown）/101个Task GUI动作。已知目录估算583951microUSD；Terra76成功请求无价格配置，连同原Sol unknown共77条未定价，总费用未知。缺字体失败探索30请求/30动作、两项原链取消的流程提问和一项缺失目标提问均保留；不清零、不替换Task刷结果。

基础评分器、三场景实际浏览器前检、类型及变更文件格式检查通过。语义材料来自夹具可见事件，尚非自动截图提炼；来源/lossy编译Sol与semantic编译Terra不同是混杂因素，此为表示原型实验，没有运行三种上游产品排名。主6797/6798/PID26072/25794/.env和12Task/65attempt/58action/7artifact/0active保持，仍0.17/SQL0018/工作站0.6.3/guest6。隔离worker与工作站已停止；只构建测试用manual-benchmark-cjk字体镜像，workstation/Dockerfile补中文字体但主镜像未覆盖。无迁移、无部署。

## 2026-10-27：操作手册真实 Sol 补验（开发版）

实际 `openai/gpt-6.1-sol` 已完成草稿生成→网页保存已检查草稿→未指定 manualId 的新任务主动 load_manual→4 个 GUI 动作访问 `/tmp`。最终截图地址栏 `/tmp/` 与独立窗口标题 `tmp - Thunar` 一致。来源沿用先前本机固定响应完成的 4 动作轨迹，没有重跑或改称真实模型来源。本轮新增 3 个 Task、22 次真实请求、Task 账本内 17 个 GUI 动作；均收到完整模型回执，目录价格估算 $0.259811，无新增 unknown。

首个执行目标 `/home/agent/Downloads` 在新容器中不存在，13 个动作后模型明确报告核对未完成，独立验收判失败；全部 15 次请求、原报告和截图保留。同容器无模型诊断确认现有 `/tmp` 能正常导航，缺失目录不会切换；只更正测试目标，原草稿/已保存手册继续复用。初次报告 SQL 误用 input_tokens/output_tokens 已改为原 usage JSON；修复只涉及测试脚本，没有重发成功编译。见 `docs/evidence/manuals-live.json`、`docs/MANUALS.md` 和 `tests/manuals-live.ts`。更多模型/软件/参数泛化、插件 Skill 导入和主预览部署仍待验。

主 6797/6798、PID 26072/25794、.env 与 12 Task/65 attempt/58 action/7 artifact/0 活跃保持，仍 0.17/SQL0018/工作站0.6.3/guest6；独立测试 Web/worker/容器已停止，全部成功、失败和费用记录保留。此前固定响应验收与历史 unknown 保持各自范围。

## 2026-10-27：操作手册生成、审阅与按需复用（开发版）

已接通成功Task→白名单依据预览→原模型账本生成草稿→网页编辑/审阅保存→新任务目录发现/load_manual→当前截图/DOM执行。沿用Task/DBOS/预算/回执/未知效果复核；草稿保存在Task结果，固定手册复用settings，无SQL/guest/依赖升级。受理快照固定目录与正文，加载正文重建在系统参考区，普通压缩和DBOS恢复后保留；停用只影响后续任务。原Thunar有限计划继续保留，控件编号继续撤回。新增/manuals、完成任务入口及SKILL.md下载，社区插件内部Skill自动发现仍未接入。

见docs/MANUALS.md和docs/evidence/manuals.json。23项定向单元/类型/隔离生产构建通过；独立DB/0.6.3桌面/生产worker/网页完成来源、草稿、新执行3个逻辑Task，成功链13次本机固定响应/9真实GUI动作/0云请求。来源4动作只执行一次，网页按钮修正后复制原成功来源只补尾段；真实worker重启、按需正文固定、停用后原任务继续/新任务拒绝、幂等保存及390px检查通过。早期图像工具返回解析夹具失败Task的1unknown、网页提交按钮失败和隔离构建漏复制类型源码均保留，不能清零或冒充成功。真实模型提炼/相关性质量、多软件泛化、插件Skill导入和主预览部署尚未完成。

主6797/6798未重启，.env未改，仍0.17/SQL0018/工作站0.6.3/guest6，原PID26072/25794及12Task/65attempt/58action/7artifact/0活跃保持。生产构建只在隔离web-source内执行，不覆盖主.next。

## 2026-10-27：撤回控件编号功能（当前决定）

按用户要求放弃三层截图标注，移除 desktop_observe/desktop_act、网页编号截图、AT-SPI/OCR 识别器及其镜像依赖；恢复原截图/坐标/键盘和纯文本网页 DOM 引用操作。guest 的 desktop.mjs、server.mjs 与桌面启动脚本逐字节恢复为已部署 0.6.3 的实现，保留按需启动浏览器、控制代/观察失效、凭据与付款审批。新构建默认镜像恢复 0.6.3；通用工具返回裁剪、完整 DOM 记录投影及最多两张近期有效截图继续保留。

实验源码与六个专项测试/夹具已移到 data/deferred/ui-annotations-withdrawn-20261027/source，退出默认测试与产品路径；原报告、图像、实验容器/数据库和 unknown 账本保留。下方同日编号开发版/准确度条目为历史记录，以本条撤回决定为准。docs/UI-ELEMENTS.md 与 docs/UI-ACCURACY.md 已标为历史，相关功能不继续开发、不升级部署。

19 项工具/上下文定向单元、类型检查及 guest JS/Bash 语法检查通过，0 模型请求、0 Task、0 桌面动作。主 6797/6798 未重启，.env 未改，仍 0.17/SQL0018/工作站 0.6.3/协议6，PID 26072/25794；主计数保持 12 Task/65 attempt/58 action/7 artifact/0 queued-or-running。证据见 docs/evidence/ui-annotations-withdrawn.json。

最新上下文与记忆v2（2026-10-26）：各SDK工具返回统一有界投影，覆盖JSON/错误/拒绝/混合文本/媒体及provider-executed结果；当前控制代最多保留最近2张有效图。默认总窗口65536，预留8192输出，输入估算达80%且有有效旧段时自动摘要；规则、当前目标/合同及用户补充保留原文。摘要边界和费用复用原决定/attempt表，负数决定对应压缩；新进程复用摘要，unknown仍需原确认，明确上游超限在获准继续后强制先压缩。持久记忆沿用原事务，程序重建变更覆盖层。15项context＋原5项workflow单元、类型/格式和10项隔离账本检查通过；8次本机固定响应、0云模型、0真实桌面。主0.15.1/SQL0015/guest5、PID/env/原Task保持，新源码未打包部署；云端摘要质量、精确token元数据与缓存收益待验。详见工程docs/CONTEXT.md及context-compaction{,-ledger}.json。下方v1及旧验收记录保留其历史范围。

## 2026-10-26：Sol网关根因已定位（只读诊断，未追加模型请求）

本地8917的sub2api原日志已核对到两次失败请求：安全检查均allow；上游404明确报告相同rs_推理记录不存在、store=false时未保存，网关将其包装成502/Upstream request failed。该rs_编号与原成功响应中保存的reasoning itemId精确一致。实际安装SDK默认序列化发送item_reference；离线使用原响应和模拟fetch复现，显式providerOptions.openai.store=false时改为发送完整encrypted reasoning，工具调用/结果仍正确配对，零网络/模型请求。见workflow-sol-gateway-diagnosis.json及workflow-sol-serialization.json。

修复方向为本工程OpenAI Responses无状态历史适配；本轮仅诊断，没有修改runtime/provider、网关配置、运行服务或Task/费用记录，也未实施真实续验。原两次unknown费用和当前needs_review保持，不通过另建Task或继续盲重试绕过复核。该原因只确认Sol这两次续轮失败，Gemini超时仍保持独立结论。下方“网关原因未知”为诊断前历史状态。

## Latest handoff — real Sol switch and single authorized retry (2026-10-26)

User requested openai/gpt-6.1-sol. Read STATUS and workflow-sol-{closeout,attempt,before-authorized-retry,main-state}.json. First real compilation 192d6ff2-fe9b-46a0-8547-e1ee35be77b9 produced34 schema-valid steps with an incidental outside-app human checkpoint; verification09eae96a-6f08-4216-bd9a-281050339f55 was actually cancelled after0desktop actions. It is still verifying, never ready. Preserve workflow-{compilation-sol-first,sol-first-attempt}.json. Clarified compiler instructions distinguish explicit private/human evidence from omitted pointer targets; guards remain unchanged. Second Sol Task f9cb0de4-5ed7-471c-91c7-bc9e978614fa returned31steps but typed /home/agent/ instead of exact allowed /home/agent, so plan was rejected. Its correction attempt and the ONE later explicitly owner-authorized retry both returned Upstream request failed. Current needs_review/draft/null plan,2unknown attempts plus1successful rejected response. Consent consumed; no further API request authorized. Exact typing rule was added to the prompt, not yet live-verified. No provider workaround without evidence.

Sol totals:3Tasks/4attempts/2unknown-unpriced/0desktop actions; known catalog estimate47178microUSD, total unknown. Original Gemini cancelled via original chain; its2unknown attempts and checked source Task/container remained unchanged. tests/workflow-sol.ts supports --resume saved directory and --owner-approved-single-retry DIRECTORY, but retry consent key already consumed. Do not rerun either paid entry point or create a replacement to bypass review. Saved latest directory:data/experiments/agent_compile_89b32692f49640c5b7887bb19091d06f/sol-1792978851395. Three GUI samples+ready reuse remain unpassed; no workflow-sol.json success artifact.5targeted workflow units/typecheck passed. Source/app/SQL/guest unchanged; main0.15.1/16migrations/0active/PIDs/env/settings preserved, experiment jobs/desktops stopped. Updated canonical setup63Tasks/133attempts/108unknown-cost/7unknown-outcome; original10frozen samples separate(total73), original60Task report preserved. FullC4/cloud/上游项目 goal remains incomplete. Earlier handoff entries retain their dated scope.

## Latest handoff — authorized retry and production root fixes (2026-10-26)

Original C1 authorization was received and consumed once on the same Task. attempt2
timed out180s (Taipei08:34:13—08:37:13), leaving exactly2unknown/unpriced attempts;
attempt1 unchanged, needs_review/draft/null plan, no third request or replacement paid
Task. See workflow-compilation-authorized-retry.json. Earlier consent waits are historical.
Production Chinese directory bytes are correct: original retained home read-only evidence
proves GNU tar C-locale quoting caused the false missing-directory report. Fixed tar
subprocess LC_ALL=C.UTF-8, verified against Linux/Mac native tar; no guest/input changes.
Terminal blocked checkpoint now enters workflow_review; final-step label is defined.
One actual27-action regression proves stable review, Continue with no new input, no ready
certification and actual cancellation. First fixture-count failure remains in trials and
its original Task cancellation was confirmed; no full-suite rerun. 7units/typecheck pass.
Web/worker images rebuilt, the two runtime files byte-match source. Four production
workflow Tasks completed(108actions); post-completion canvas fixture timed out after
control release. Raw failure remains. Observe while active; targeted production-ui tail
retained those4 unchanged and ran just1 new27-action Task. Composite production.json:
5complete/135actions/0model/0human, separate gates4+1, actual optimized noVNC canvas/CA
WSS/readonly/network/secrets/rootfs/reviewed export/390px passed. Do not rerun successes.
Keep original3Tasks/81actions/2complete/1cancel and489-step loop in historical costs.
Metrics-only closeout is60setupTasks/129attempts/106unknown-cost/5unknown-outcome, plus
original10frozen checked samples(total70). Original46Task report preserved; no matched
savings/fullC4 claim. 40files/9configured secrets scanned clean. VM/jobs/desktops stopped;
main0.15.1/16migrations/0active/PIDs/env unchanged. FullC4/real-model quality/public DNS/
VPS/long-run/matched 上游项目 superiority remain open; never claim overall completion.

## Current handoff — C5 local sharing/revalidation (2026-10-26)

Source0.17.0-dev/SQL0018/workstation0.6.2; main remains0.15.1/SQL0015.
Read docs/WORKFLOW-PACKAGES.md and workflow-sharing{,-provenance,-trials,-main-state}.json.
lib/workflow-package.ts defines strict portable projection/validation; no local Task IDs,
source values/evidence, old controls/approval, scripts or source free-text are exported.
lib/workflow-packages.ts reuses owner versions; import persists an honest unverified draft,
nullable local source references, imported_package and owner/import-key idempotency.
SQL0018 origin constraint permits compiled or imported origins; imported repair revisions
preserve external metadata and a real local repair Task. Existing finite execution, exact
environment checks and3-new-sample certification are reused, without a second runtime.
Owner APIs and reviewed download/upload UI are at /workflows. Actual committed response
loss/reload/re-review and concurrent reuse passed. Fresh empty target DB/new owner/keys/
INSTALL_ID/home:3 real new GUI samples certified, fourth Task reused ready(108actions,
0model/0human requests). Target agent_flowshare_e1b366c4df2041ba81118894118926c9,
version3ffe532e-3368-4c89-a19d-17b05741b4a9. Same host/architecture/image only.
Three SQL provenance checks are synthetic rollback-only, not real model repair evidence.
Initial browser prerequisite failure is preserved,0Tasks; existing UI_BROWSER_PATH enabled
the successful run. 11related units/typecheck/changed-file formatting passed. All jobs/
desktops stopped; source original/env unchanged, main health0.15.1/16migrations/0active.
C1 original remains1unknown/draft/no plan, awaiting already-sent retry consent. Do not
repeat that question or silently replace the paid attempt. Full C4 baseline/repair/costs/
ablations, real-model quality, more task families, production/cloud/long-run and matched
上游项目 superiority are still incomplete. Keep the original goal active. C4 reports below
retain46 historical setup Tasks; add the4C5 tasks when doing later all-in collection.

## Current implementation handoff — C4 measurement tooling (2026-10-26)

Source remains0.17/SQL0017/workstation0.6.2; main0.15.1/SQL0015 unchanged.
Read docs/WORKFLOW-BENCHMARK.md and workflow-benchmark{,-protocol,-closeout}.json.
lib/workflow-benchmark.ts: strict10-case bindings, exact BigInt micro-cost totals,
logical Task/attempt dedup with conflicting-copy rejection, token/time/wait/unknown
metrics, shared-first-delivery accounting and unmatched/failure/unknown savings gates.
lib/workflow-benchmark-db.ts + scripts/workflow-benchmark.ts: freeze/submit/collect/report
over original Task/DBOS. Fresh manifests pin model/provider endpoint and3 separate desktops.
workstationChannel=desktop freezes tool restrictions in tools/runTool/executeAction;
desktop_environment events retain actual image/locale/protocol per boot, without env dumps.
Core DB agent_flowbench_e7942c8cc8fb43a0a2c701187ac5ef5f has10 pre-frozen checked
GUI Tasks(all270actions/0model), one initially failed channel fixture and one successful
ordinary-model channel fixture(16local fixed responses). Initial parsing failure mistook
SDK screenshot text-part array for metadata; corrected fixture/resume reused the SAME10
Tasks and verified unchanged receipts, never reran GUI. Original failed result preserved
as resume-1792957649473-previous-result.json; unknown local model attempt retained.
The earlier manifest lacks endpoint pinning, so cannot admit baseline/repair model arms.
Fresh protocol test agent_benchprotocol_4932f78f2c5341a6bb9ffa4495d8ee17 verifies endpoint
changes/unpinned model arms/shared desktop reject;2Tasks only queued/cancelled(no worker/API).
Final report benchmark-report-status-counts.json includes46 canonical setup Tasks,
128actual model attempts/105unknown costs/4unknown outcomes, all97C0calls, and shared
first delivery charged once per strategy. Completed22 includes18program-checked deliveries;
cancelled22/unfinished2. Do not call unknown subtotals zero or waiting time active labor.
Matched baseline/repair0of10; no money/call savings, all-in costs or 上游项目 superiority claim.
Active human labor/environment/infrastructure/parameterization/unchecked replay remain
missing; fullC4Accepted=false. C1 original cloud unknown still awaits explicit consent;
do not repeat that question or silently run replacement paid trials. Next:C5 local
export/import/privacy/schema checks/independent environment revalidation. Overall active.

## Current implementation handoff — C3 bounded repair (2026-10-26)

Source remains0.17.0-dev/SQL0017/workstation0.6.2; main unchanged0.15.1/SQL0015.
workflowExecution.allowRepair is explicit/default-off; selected model frozen at admission.
worker/workflow-repair.ts calls original decide/ledger, exposes only submit_workflow_repair,
sends failed fragment/current frame/confirmed effects/frozen contract, and stores a<=6-step
variant/cursor inside checkpoint.repair. Prefixes recover GUI navigation/dialog state; last
intended effect stays fixed. Same runTool/executeAction chain executes new actions.
Saved response before variant commit survives worker SIGKILL after reobservation/native
window matching in current epoch. Manual handback/reboot discards old candidates. Unknown
effect/cost never automatically retries; second drift stops. Only fully checked repaired
completion saves a new draft/repairOrigin. Source version immutable; repaired sample cannot
certify that source method. Owner may explicitly verify draft; still needs3 distinct samples.
Reports: workflow-repair.json(core7Tasks,2complete/5cancelled), workflow-repair-controls.json
(3actual cancelled Tasks:pending model takeover/deadline/cancel), workflow-repair-ui.json
(queued/cancelled Web submission and screenshots), workflow-repair-certification.json
(4synthetic transaction checks,not GUI Tasks). All model responses controlled/local,no cloud.
Initial failed recovery/certification records retained. C1 unknown cloud attempt still awaits
the already-requested explicit retry consent; no reply observed, do not repeat question.
Next:C4 matched10 inputs/full costs, C5 export/import/revalidation, real-model quality,
production candidate deployment and pinned 上游项目 comparison. Goal remains active.

## Current implementation handoff — C2 native execution (2026-10-26)

Source is0.17.0-dev/SQL0017/workstation0.6.2/guest6; main stays0.15.1-dev/SQL0015/guest5.
C2 adds workflowExecution input, atomic version/parameters/contract/run snapshots, finite
next-step selection INSIDE original runAgent/DBOS, original executeAction, latest native
window guards and fixed host directory checks. No second executor or new dependency.
The0.6.2 guest advertises thunar-keyboard-v1; exact source image and independently verified
execution image are separate. A new boot rechecks the actual image/capability/locale.
Ready requires3 distinct fully traversed checked samples on the same image; early human
completion/unknown actions cannot certify. Run actions/time are bounded independently of
model maxSteps; no provider is needed for deterministic execution.
Read STATUS and workflow-execution-core/controls/certification/UI.json. Core has4 real Tasks
(3 varied samples incl spaces/Chinese + ready reuse), zero model attempts. One worker was
SIGKILLed after key_type receipt/before checkpoint; typing was not repeated. Controls include
actual cancellation, action/time limits, takeover/window move/handback and real lost input
receipt after directory creation/restart; Continue never replays the uncertain action.
All candidate-generation evidence remains controlled-provider. The cloud C1 Task
5b0ad29b-a729-439b-91a0-13f34fb090fc in agent_compile_89b32692f49640c5b7887bb19091d06f
is needs_review after180s timeout/1unknown unpriced attempt; its worker is stopped. An
explicit retry-consent question was sent. No reply has been observed: do not retry or
replace that paid attempt. C0 retains97 successful unpriced requests; costs are separate.
C3 bounded repair, C4 matched full-cost trials, C5 sharing and overall 上游项目 superiority
remain open. All tests use isolated clones/install ids; main is untouched. Preserve all
failed trajectories/UI checks and source images. Do not implicitly restart/migrate main.

## New handoff — CUA workflow compilation (design1.25, 2026-10-26)

Owner confirmed successful traces → parameterized checked workflows → fresh Task execution → bounded repair → full-cost comparison. Read docs/design/主会话指导-流程编译.md and docs/design/CUA流程编译与自动化复用.md first; continue C0→C5 on the single-agent path. Teams stay deferred.

Reuse Task/DBOS/runtime/model/actions/control/artifacts. Source receipts are compilation evidence; new Tasks dispatch real actions with fresh identities. Same-Task recovery reuses known receipts. Unknown effects keep existing review. This increment is design-only: no code, migration, image change or service restart was performed by the side conversation.

## Current handoff — usable single CUA preview (2026-10-25)

Read docs/QUICKSTART.md, docs/STATUS.md, real-models.json and approved-local-upgrade.json.
Owner approved backup+upgrade and supplied the two gateway models. Main is now0.15.1-dev/SQL0015/
guest5, listening6797/6798. Old44 tables/5491 row values and10 artifacts preserved; two real tasks
completed on one Personal Assistant: GPT8 calls (estimated$0.035439), Gemini9 calls (unpriced).
Default is openai/gpt-6.1-sol; custom/gemini-3.8-flash-high is configured. Credentials are encrypted
through authenticated settings, absent from logs/44 database tables; do not echo or rewrite them.
Old blocked audit is historical/resolved. Failed launchd registrations were removed; preview uses
detached Node processes, no auto-login/restart supervision. Keep the server usable and avoid
unnecessary restarts. Teams remain deferred. Guarded Linux public DNS/VPS and matched 上游项目
comparison remain unverified; local real tasks do not certify those production gates.

This is the implementation repository. Read AGENTS.md for binding development rules.
Start with docs/STATUS.md and the most recent experiment report under docs/evidence/.
Use docs/design/agent.md for the planned sequence, but rely on actual files and test results
for implementation status. Keep the pinned reference checkout read-only. Update the live design package only for verified decisions; preserve the original baseline and distinguish implementation status.

The product objective is a self-hosted personal computer agent with at least 上游项目's
retained capabilities, stronger interruption recovery and controlled browser/human collaboration.
The comparison must use the pinned upstream version and matched tasks; new dependencies
alone do not establish a usability improvement.

Latest verified gates: G01—G04, containment and visible-framebuffer desktop UI; production
provider/SDK runtime, durable model recovery, DOM/human handoff, checked artifacts, memory
write/forget/replay and owner UI also have controlled-provider evidence. Read
docs/design/模型执行与成果验证.md for the current runtime and its boundaries.
Durable multi-turn conversations, question waits/restart, ordered pagination, drafts,
response-loss/reload deduplication and rename/export now have focused chat/UI evidence.
Real-model judgment remains unevaluated. Request-level billing, monthly admission, timezone/DST,
unknown-cost reconciliation and usage UI now have controlled-provider evidence; model recovery remains verified.
Timezone routines and host-verified two-period CSV comparison now have controlled-service evidence.
Vault S1/S2 storage/provisioning is implemented: v2 bound envelopes, masked owner APIs/forms,
versioned references, atomic request wakeup, task-scoped expiry and cleanup.
S3/S4 authorized DOM filling and transient secret transport now have thirteen-task controlled
evidence, including receipt/checkpoint interruption, unknown review and real cancellation.
The last fully accepted local application/DB and running main are 0.8.1-dev/0011; workstation is
0.2.0/protocol 2, image 441e717eefd1. Read runtime-vaultfill.json, preview-vaultfill.json and
credential design section 13. Preserve the actual integration cases/count gate; ordinary action
input and guest params are journaled and must never receive plaintext vault fields. S5 payment
requests, richer chat controls, cost trends/agent summaries, delegation and deployment/comparison remain.
Telegram text pairing, durable inbox/outbox, private replies, notifications and owner mobile settings have controlled-service evidence; real Telegram and extended control branches remain unevaluated.
Do not repeat the whole gate suite for unrelated changes or equate fixture success with product completion.

Private Linux deployment and guest-network checks remain partially accepted; F12 controlled
backup/restore, focused network lifecycle and short-run idle/wakeup have passed. Continue
retained product features (next F14/S5), ordinary public DNS/actual-VPS prerequisites,
long-running evidence and matched real-service comparison.

Desktop stdio now has four Docker-stream cases, six control/legacy-network cases, actual
framebuffer UI and model-recovery evidence. Read preview-desktop-stdio.json for the current
main deployment. No guest/viewer ports are published; the viewer has no network. Actual-cloud
and ordinary-public-network acceptance remain P7 work. Scoped guest egress now has separate
network-lifecycle evidence below. Controlled Linux
packaging/HTTPS and full restore now have scoped evidence described below.
The user authorized an existing cloud API with no acceptance spending cap. There is currently
no configured provider/default model; only request safe local settings, do not repeat the
service/budget questions or inspect unrelated credentials. Unknown request/effect consent remains.

The 0.9.0-dev baseline introduced production Web/worker images, private Compose/Caddy entry,
separate bootstrap files and scoped Linux guest filtering. Read deploy/README.md and
deployment-private-attempt.json: the attempt passed initialization/HTTPS and a controlled
desktop-login/crash/download task, then failed ordinary Internet HTTPS. The local DNS
returns 198.18.1.34 (fake-IP); guarded counters confirm reserved-range DROP. DoH-only
curl succeeds with valid TLS, but normal application DNS is unverified. Keep the gate
failed and do not repeat a guaranteed-failing full attempt without a changed prerequisite.
The dedicated VM is stopped with failed data retained; main/global Docker context remain
unchanged. At that initial attempt, full backup/restore was still pending; the following
F12 record supersedes that part. Focused policy lifecycle also passed subsequently; capacity
and actual VPS/ACME still need evidence. Source provenance is 44 copied/38 adapted/1 excluded.

F12 has since passed on a second, clean Linux ARM engine: restore.json links the initial
clean import and resumed verification. Source preparation is
pa-linux-1792898258832/attempt-1792903681417 (format-2 snapshot-full + keys-full.env),
target initial import pa-linux-1792903976167/attempt-1792903998168 and validation
attempt-1792904201499. Checkpoints contain test credentials; never print them.
Both VMs are stopped. Read deploy/BACKUP.md for the offline commands and recovery policy.
The source SIGTERM Shell receipt was incorrectly treated as success; lib/action-receipts.ts
and both host/guest receipt checks now stop for review. Fixed images: worker 182dc2e2d4d2,
Web 600afb5d58dd. The host snapshot CLI is format 2; image IDs in snapshots remain exact.
The original DNS deployment gate, capacity, actual VPS/ACME, remaining
retained features and matched 上游项目 comparison still need work. Short-run capacity now has
separate evidence below; long-running retention remains open. Do not repeat the known
fake-IP full deployment attempt unchanged. Main remains 0.8.1-dev/0011 and has not received
this candidate fix; no real provider is configured there.

Focused network continuation passed at target attempt-1792905740639: ten live endpoint
pairs (including DNAT to a controlled public fixture), three rule/order tamper cases,
worker startup rejection, explicit drain/reinitialize and retained home. Task/action/model
counts stayed 6/12/17. Initial attempt-1792905630400 failed only because the new fixture
subnet overlapped the retained restore network; the focused test now uses the existing
offline fixture network at an unused address. Both results remain. See network-lifecycle.json
and deploy/README.md section 7. The VM is stopped; no ordinary Internet/model calls were
performed, and full deployment/comparison remain pending.

Short-run capacity passed at attempt-1792906944635 (8 report tasks/56 controlled model
calls), followed by idle-stop/wakeup at attempt-1792907342959 (9 tasks/63 calls). The real
leased-worker timer stopped guest/viewer after the eighth task, fenced epoch 32→33/boot,
and the ninth task woke it and retained a home marker. Seven eligibility SQL states and
the disabled/no-DB branch are separately flagged. No long-running/minimum-spec/real-login
conclusion. Read deploy/RESOURCES.md, capacity-baseline.json and idle-workstations.json.

New worker image 54af95cddc0d adds host-owned idle maintenance; tested Web remains
600afb5d58dd and workstation 441e717eefd1. Application protocol 0.9.0-dev / SQL0011 /
guest2 stay unchanged. Default idle15 minutes (0 off); never stop nonterminal work or
enable the guest timer. No new framework/dependency; provenance remains 44/38/1.
VMs are stopped and retained. Main is still 0.8.1-dev, and actual settings/registry checks
show zero configured providers and no resolvable default model; preserve the user's existing
cloud/unlimited-spend authorization without repeating it or reading other projects' keys.

Current S5-A source:0.10.0-dev, workstation0.3.0/guest3, SQL0011. Extends the same sensitive batch to identity, including long joined address; rejects an empty optional field before any release. UI/tool instructions follow the same boundary. Actual health rejects a guest2 image even with a new creation label. Identity ten-task and original thirteen-task login/code targeted checks passed with controlled provider/site. Do not upgrade main0.8.1 automatically or reuse its old0.2 image for the new worker; original baseline snapshots remain pinned. S5 payment, real models/network and comparison remain open.

S5-A evidence:runtime-identity.json(rawagent_runtime_9f81f6a3f31f468f984446ad049f97aa), runtime-vaultfill-0.10.0.json(rawagent_runtime_83c9184bdd504261bd61dc20a18d1825). Keep old0.8 guest2 evidence in runtime-vaultfill-0.8.0.json. Guestfdccff8575be; productionworker/Webaf4bff1c91b5/4e558c792da2 built; runtime89/controller5 source files byte-match, lock810/3 version entries match. Actual integration uses isolated host Node/Web/DB plus guest, not a new cloud deployment. UI screenshots were inspected. Four test-boundary failures preserved; no production gate weakened. Five vault units, two config checks, type/build passed. Continue payment request/card/UPI, remaining retained scope and real services; do not repeat all app/network/resource suites for these docs.

Current S5-B:0.11.0-dev/SQL0011/workstation0.4.0/guest4. Fifteen payment-preparation and original thirteen login/code tasks passed before the narrow deadline fix; the one actual slow-DOM task passed after it with zero releases/inputs/submits. Read payment-preparation.json, credential design15, D59-D61 and migration tail. Preserve the two failed audit attempts and the raw15 footer metadata typo. Source/image scope is isolated host integration plus production build, not a0.11 cloud deployment. Main stays0.8.1-dev/guest2, old F12/network/capacity and identity10 reports stay pinned. Next is S5-C explicit submission approval/unknown effect/result evidence; no full-S5/comparison claim. Current provenance44/40/1.

S5-C source0.12.0-dev/SQL0012/workstation0.5.0/guest5 passed controlled mechanism gates: full original9 tasks (8 completed/1 cancelled) plus separate11 edge tasks. Preserve original9/edges11 count gates, both early failed attempts, the focused recovery1 report and payment-submission-1.18.json. Marker-before-send recovery is verified with a host-only test proxy, process-group death and gate removal before restart; unknown submits still allow continue/cancel only and never resend. UPI, no complete fill, three invalid results, cross-site/unsupported/iframe, guest recheck after host marker and host receipt before framework checkpoint all passed. The proxy never journals stdin and applies only to the edges worker PATH; no production hooks, runtime/controller code, lockfile or images changed. See credential16.3/16.4, D65 and payment-submission.json. Existing guest5 preparation15/login13 regressions stay valid; do not rerun unrelated full suites. Main0.8.1/SQL0011/guest2 remains unchanged. Real models/services, new-candidate cloud deployment, retained features and matched 上游项目 comparison remain open; S5/product goal stays active. Existing cloud API/unlimited-spend authorization remains, keys only through local settings.

F07 source0.13.0-dev/SQL0013/guest5 now supports sequential delegate(agentId,brief,files). Original eleven actual tasks passed (nine completed/two cancelled), including real busy targets and original-thread follow-up. Keep the eleven-task gate. Use existing snapshot/collectArtifacts/releaseWorkspace/target DBOS partition; prepared event before release, segment+current task+enqueue+handoff receipt in one transaction. Segment snapshots freeze model/config/memory (never API values); host files transfer to new Transfers paths with byte checks. Old segment mutations/requests are fenced; known receipts remain reusable. All segments share task step/cost budget and original conversation anchor. Delegation is restricted to owner-approved per-task delegateAgentIds (default empty); models cannot expand the roster. Squad UI, Shell handoff/large files/long chains, real models and cloud/comparison remain open. Read F07 implementation/T16/migration0.13/STATUS. Main0.8.1/SQL0011/guest2 unchanged; do not apply new migrations or restart it implicitly. Runtime fixtures must pin protocol5 instead of inheriting old main WORKSTATION_IMAGE. Historical reports retain actual versions; new reports derive current source/migration metadata. Existing cloud API/unlimited-spend authorization stands, keys only local settings.

Source0.14.0-dev/SQL0014 adds an explicit per-routine delegateAgentIds roster (empty by default). Freeze nonempty ids with the existing routine run input; preserve omitted task fields for empty rosters and old request keys. Plan edits/toggles never mutate accepted runs. Reuse assertDelegationRoster at plan save/Task admission and the same F07 worker/queue/segment; no second executor. Three actual controlled tasks passed (two no-file handoffs and one denied delegation), including actual DBOS timed trigger and phone form. Preserve the three-task gate, the initial fixture-history failure and historical0.13 eleven-task report; do not relabel earlier suites as0.14 regressions. Guest stays0.5.0/protocol5; provenance44/40/1. Telegram roster entry/squad UI/real models/new-candidate deployment remain open. Main0.8.1/SQL0011/guest2 unchanged;0012-0014 not applied. Keep existing cloud API/unlimited-spend authorization; configure only locally.

Source0.15.0-dev/SQL0015 adds Telegram owner-approved delegation rosters to the existing connection. API grants bind generation+source agent; inbox first transaction freezes nonempty ids, empty input remains omitted. /use or Web agent selection, rotate/unpair/token/bot-identity changes clear permissions; /new preserves the same source. Already frozen inbox commands retain their roster after edits; revoke their generation or cancel an accepted Task explicitly. Same-context drafts survive polling; server rejects stale source/generation. New3 actual tasks and original8 groups/5 tasks passed (combined7 completed/1 cancelled;3 original Recovery Lab tasks); keep both count gates and historical reports. Tests pin guest5 and identify ask_user by name despite initialization screenshots. Main0.8.1/SQL0011/guest2 unchanged,0012-0015 not applied. Original squad selection/@member, retained features, real services/new deployment/comparison remain open. See model execution21/migration0.15/STATUS. Existing-cloud API/unlimited-spend authorization stays; credentials only in local settings.
