# 实施状态

## 2026-10-31：控件优先与模型主动截图完成（开发版）

完整原生观察/正常后台动作/核对窗口的输入可不生成截图，只返回新控件状态与 ID；缺失/不完整、数字文本和值矛盾、原生回退或前台派发自动补图。系统提示和原 screen_capture 明确允许模型疑惑时主动取图、视觉结果按需核验。坐标输入硬性要求最新观察含图；无图 ID/旧 ID 在输入前拒绝。原 Task/回执/未知效果/两图上限/DOM/noVNC 保持。17 项不同离线检查与定向类型/语法/格式通过，真实 GTK 5 组/14 回执（12 成功、2 预期拒绝）通过，0 云请求/0 业务 Task。两次共享路径准备失败保留，最终复制源码进隔离 0.6.5 容器验收；临时容器/匿名卷已删，资源仍 6 容器/104 卷，无生产构建或预览部署。数值 setter 尚未修改。见 docs/CONTEXT.md 与 docs/evidence/adaptive-desktop-observation.json。

## 2026-10-31：AT-SPI 模型观察精简完成（开发版）

JSON/附图观察统一去掉重复树、title/frame、节点 PID/D-Bus 身份及冗长动作说明，保留操作引用、名称、状态、值、像素位置和安全/派发元数据；状态证据、按钮/页签优先于大列表，过大节点不阻断后续选择，完整原始回执保持。12,000 字符预算、最多两张有效图、DOM/摘要/路由保持。9 项定向离线检查及定向类型检查通过；合成 51 控件同预算保留数 10→51、字符 10,137→9,068，尾部状态栏保留。真实模型效果未重跑，字号数值接口问题保持待修；无部署/SQL/guest/新增依赖。详情见 docs/CONTEXT.md 的 10 月 31 日条目，原对照报告保持。

## 2026-10-30：AT-SPI 与纯视觉真实配对对照已完成

六个隔离 Terra Task，每场景每组一次、每Task最多48请求；137次请求均成功回执、0unknown、137条无价格，费用保持未知。原生优先完整3/3、纯视觉完整2/3；表单、文件字节和字体核心状态两组均正确。纯视觉文件Task达到48次预算后停在父目录未完成收尾，评分needs_review后仅清理取消，原48次请求和失败报告保留；没有重跑刷结果。

混合组实际22次原生派发、25次鼠标键盘输入。表单4次全原生；文件13原生+21鼠标键盘；字体5原生+4鼠标键盘，18请求/112.7秒，对照纯视觉7请求/44.3秒。禁止据此宣称全局原生更快/更准。已定位两项未修复缺口：模型控件投影51→17丢状态栏；同时提供EditableText/Value的字号控件先改文字11、实际值10，Tab后才11。先修精简投影与数值接口分流，不引入复杂框架。

见docs/AT-SPI-COMPARISON.md和docs/evidence/atspi-comparison.json。实验新文件仅在tests与文档；生产默认提示/路由未改。SDK/摘要边界离线6项、137份真实请求审计（纯视觉无树、最多2图、调用ID配对、保护字段不泄露）、只读home逐字节复核及类型/格式通过。此中继在上下文估算之后，实际压缩不同会影响预算，不把文件收尾差异当成准确率因果结论。

主.env及12Task/65attempt/58action/7artifact/0active保持、Web200/worker健康。隔离worker/桌面已停止，6个停止viewer容器和6个display卷已删；保留私有报告/DB/6个home证据卷。六格真实模型授权已消耗，禁止重跑原admission；新付费对照需新授权。原始输入、数据库及凭据不上传，脱敏汇总可迁移。

## 2026-10-29：OwnDesk 已部署本机预览，旧运行构件已清理

用户明确授权“更新，然后把旧的删了”。本条覆盖此前保持旧主实例的部署边界；历史条目与原报告保留当时状态。6797 为当前源码生产 Web 构建，6798 为当前源码 worker 0.17.0-dev，桌面及 viewer 为正式 Dockerfile 构建的 owndesk-workstation:0.6.5（f3842ddb48f4），guest6 / SQL0018。Web/worker 当前为宿主进程；新版 Compose 镜像及真实 VPS 发布验收保持各自范围。

数据库 dump 实际恢复并逐行核对47表；启动后29张稳定业务表保持。原账号、模型配置和密钥、12Task/65attempt/58action/7artifact保留，0新增Task/0模型调用。原home卷挂载/home/agent，浏览器配置改为.config/owndesk-browser，621个普通文件逐字节保持；默认助手改为OwnDesk Assistant，其他助手保持，旧桌面票据撤销并重建控制代。实际网页标题、原账号登录、成果下载、实时桌面、鼠标打开浏览器、接管及交还均已核对。

旧Web和worker收到TERM后50秒仍未退出；排空状态再次确认0active/0pending后终止对应旧进程，显式停止原桌面，再执行一致备份。该次关闭情况写入私有shutdown-check.json，未冒充正常退出。数据库、home、成果、旧Web及原运行镜像回滚归档保留于data/backups/owndesk-upgrade-2026-10-29T13-28-25-524Z/，原.env独立保存于受限key-backups。此归档含私有数据，只在本地使用。

已删除22个旧停止容器、18个旧镜像引用及约1.55GB旧/临时Web构建；全部98数据卷及其他项目保持。Docker镜像汇总11.48GB→5.439GB；macOS当前可用约50GiB，这两种口径分别记录。当前运行主桌面与viewer继续使用同一原home/display卷。证据docs/evidence/owndesk-upgrade.json；后续复用既有验收，避免重跑历史付费任务。

## 2026-10-29：产品更名 OwnDesk（源码已验证，主实例保持）

产品、npm包、UI/导出、默认镜像与Linux桌面脚本已统一OwnDesk/owndesk，桌面用户与目录改为agent及/home/agent，模型截图元数据改为providerOptions.owndesk。许可证和上游sourcePath保留；原docs/evidence与实验回执不改写。DBOS身份、Docker标签、快照格式及浏览器草稿键保持稳定。工作目录及主6797/6798/.env/数据库/home保持，旧镜像不会自动获得新名称或新目录；发布需新镜像配对与显式迁移，见docs/RENAMING.md。

类型及45项定向单元通过；一次旧断言把已重新接入的AT-SPI依赖误列为撤回对象，收窄至编号/OCR并明确检查原生依赖后该文件2项通过，未重复全套。复用保留依赖层的隔离镜像通过5组浏览器冷启动/接管交还/重启/并发DOM截图和1项原生包/AT-SPI检查，0模型/0业务Task；这属于更名打包检查，未做从零正式生产构建。2临时容器和镜像已删除，188份原始报告逐字节保持，运行资源数保持33镜像/28容器/98卷。证据docs/evidence/owndesk-renaming.json；源码备份在data/backups/owndesk-rename-20261029-204502/。历史条目继续保留当时实际镜像名，勿为更名重跑历史付费任务。

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

## 2026-10-27：控件标记准确度基线（只测试，未改产品执行器）

见docs/UI-ACCURACY.md及docs/evidence/ui-accuracy.json。44个受控目标（DOM12/GTK12/Canvas20）；检出12/12、11/12、18/20，完整命名8/12、9/11、12/14。原生Zoom首次夹具监听物理事件漏记，单项语义activate回调复核确认，原数据保留；共42次guest编号派发，41个不同目标得到回调。程序按真值几何选ref，0云模型，不代表模型自主选按钮或任意应用准确率。发现DOM关联label/aria-labelledby/title、AT-SPI关联标签和滑块覆盖缺口，以及OCR图标字符误读/2项漏检/3个非操作候选。截图仍只画编号，名称在结构化列表。仅增加测试/证据，主预览、.env、0.6.3镜像配对及12/65/58/7/0数据、原PID保持；不升级主环境。

## 2026-10-27：三层控件编号开发版

网页DOM引用、Linux AT-SPI语义动作/框点击、本地CPU视觉候选已接入原动作/回执/接管链，新增desktop_observe/desktop_act及ui-elements-v1能力；工作站候选0.7.0/guest6，源码Web/worker仍0.17/SQL0018，无迁移。详见docs/UI-ELEMENTS.md及docs/evidence/ui-elements.json。直接guest分段11项、独立生产worker一项Task（4本地固定响应/3真实动作/原动作重放）、3新增单元及16原context单元通过；0云模型请求。另一个夹具失败Task保持needs_review及1unknown，失败实验全部保留。标记只绘制截图副本，默认DOM读取不自动截图，当前控制代最多2张图。CPU OCR/边框识别不保证复杂无文字图标；仅Thunar、网页iframe/open-shadow与Canvas验收，真实模型质量/其他软件矩阵未认证。用户明确选择先留开发版：主6797/6798、.env、0.6.3工作站和原12Task/65attempt/58动作/7成果保持，禁止自动升级/重启主预览。新源码默认镜像0.7.0不表示主环境已配对升级。

2026-10-26：桌面优先/浏览器按需启动已部署主预览，工作站0.6.3/guest6，Web与worker仍0.17。见 docs/BROWSER-STARTUP.md 与 docs/evidence/browser-startup.json。冷启动无 Chromium/空白标签，热交接保留页面；空闲冷启动同步boot/epoch。主12任务/65attempt/58动作/7成果保持，0新增模型请求。旧镜像、配置、数据库与home备份保留；不重跑历史完整套件。

## 2026-10-26：Agent Zero 社区 Python 工具兼容

设置页新增官方插件索引、固定提交安装、兼容范围说明、普通 JSON 配置和启停。支持原 Tool/Response 与插件内部 usr.plugins 导入、工具提示词、默认配置和基础状态/日志；前端、API、生命周期 hooks、完整 Agent Zero helpers/模型/项目功能及 Skill 自动发现继续未接入。源码检查与保存不会执行插件；实际工具仅在桌面 guest 中通过原 executeAction Shell、控制代、动作回执和未知效果复核执行。settings 保存不可覆盖的固定源码包，任务/执行段冻结引用，无新 SQL、工作站镜像或协议。

6 项定向单元和生产构建通过。隔离生产 Web/worker、新拥有者/数据库/桌面的原生调用通过：官方索引安装原 rg 66e6d6d 与 todo_list 888b8c3，一个完整 Task、5 次本地固定模型响应、3 次插件实际调用，覆盖搜索、待办创建/读取、同动作回执复用以及停用后已受理任务保持原配置。0 云模型请求。完整源码/任务/动作/费用结果见 docs/evidence/agent-zero-plugins.json 与所引用 result.json。前两次纵向尝试分别暴露官方索引缺 commit/null tags、settings 原表无 updated_at SQL 默认值，均在创建 Task 前失败；根因修正并保留失败数据库和日志，不冒充已通过任务。成功任务没有重跑。

新增说明见 [Agent Zero 兼容](AGENT-ZERO-COMPATIBILITY.md)。本轮验证明确限于 Python 工具合同子集与这两个真实插件，不代表全部社区插件兼容或真实模型选用质量。

已在 0 活跃任务时更新本机预览（Web 24404、worker 24405），无 SQL/guest 升级；原版 rg 和 todo_list 以已验证提交预装并保持停用。设置页实际浏览官方索引、搜索 todo、显示已安装状态及兼容范围已视觉核对，页面已定位社区插件区域。健康/安装/无新增主任务见 agent-zero-plugins-preview.json；原插件注册表备份在 data/backups/agent-zero-plugins-1793002624338。

## 2026-10-26：前端白棕暖色主题与排版优化

按用户要求将前端调整为Claude风格的暖白与棕陶配色（浅色优先，保留深棕暗色变量），优化标题衬线层级、侧边栏分组、对话卡片、输入框、任务详情与设置/用量/例程/流程页卡片排版；保留原有ARIA角色、标签、交互与390px无横向溢出。隔离Next预览＋Playwright桌面/移动端实测通过，0页面错误、0模型请求、0桌面动作；经用户要求已备份主库/成果/配置（approved-upgrade-1792992023648），应用SQL0016—0018并重启本机预览至0.17.0-dev/SQL0018/workstation0.6.2（6797 PID 76792 / 6798 PID 76793）。

## 2026-10-26：截图上下文上限调整为两张

按用户要求将模型视图调整为当前epoch/boot最近最多2张有效截图；共用原compactContext，保留原审计、元信息和过期过滤。4项截图定向单元通过，覆盖第三张淘汰、控制代/启动代失效、跨消息类型共享上限、provider图片提升及混合媒体裁剪。0模型请求、0桌面动作；主预览/数据库/镜像保持，源码尚未部署。下方单张截图记录保留其历史范围。

## 2026-10-26：通用工具投影、自动摘要与记忆覆盖层

最新上下文与记忆v2（2026-10-26）：各SDK工具返回统一有界投影，覆盖JSON/错误/拒绝/混合文本/媒体及provider-executed结果；当前控制代保留1张图。默认总窗口65536，预留8192输出，输入估算达80%且有有效旧段时自动摘要；规则、当前目标/合同及用户补充保留原文。摘要边界和费用复用原决定/attempt表，负数决定对应压缩；新进程复用摘要，unknown仍需原确认，明确上游超限在获准继续后强制先压缩。持久记忆沿用原事务，程序重建变更覆盖层。15项context＋原5项workflow单元、类型/格式和10项隔离账本检查通过；8次本机固定响应、0云模型、0真实桌面。主0.15.1/SQL0015/guest5、PID/env/原Task保持，新源码未打包部署；云端摘要质量、精确token元数据与缓存收益待验。详见工程docs/CONTEXT.md及context-compaction{,-ledger}.json。下方v1及旧验收记录保留其历史范围。

隔离账本验证使用真实PostgreSQL和生产模型调用层，health-only CLI夹具拒绝所有桌面操作。独立新进程恢复已保存摘要；费用/unknown/月预算/取消/软硬门槛/冻结预算及上游超限路径有受控证据，未作为DBOS整段工作流、真实模型质量或生产发布验收。首次CLI语法和月预算夹具失败保留，后续只续验剩余门槛及新边界项。15项context由14项定向用例和单独新增DBOS错误codec用例组成；原5项workflow通过后未重跑。

## 2026-10-26：上下文裁剪与OpenAI无状态续轮已接入

最新上下文接入（2026-10-26）：pa-context-v1已进入原decide/generateText链。原审计及thread/task/call ID保留；近期工具文本每条12000字符，按6条批次把旧输出缩至600，保留头尾与当前控制代1张图。OpenAI显式store=false＋加密推理历史＋稳定thread/segment缓存分组，避免未保存rs_引用；custom Chat保持原provider协议。13项相关单元/类型/格式通过，原真实Sol响应经生产准备函数离线序列化为0个item_reference，0次模型请求，原attempt与needs_review保持。当前仅文本裁剪，整段语义压缩/模型总token预算/实际缓存收益待验。主预览0.15.1、SQL/guest/PID/env不变，镜像未重建。详见docs/CONTEXT.md、context-assembly.json及STATUS；下方“仅诊断、未改代码”保留其诊断时范围。

范围取舍：缓存复用计算，文本裁剪减少输入；批次边界会改变旧前缀，真实命中和费用未测，不宣称性能收益。已冻结的当前目标/用户补充、工具参数及完整调用结果关联继续保留；本轮没有语义摘要器或新的对话数据库。实际裁剪例70031→12000字符，开头与错误尾部保留；本次未执行Sol GUI三样本及ready复用。原未知审批授权已用完，未新增付费请求。

## 2026-10-26：Sol网关根因已定位（只读诊断，未追加模型请求）

本地8917的sub2api原日志已核对到两次失败请求：安全检查均allow；上游404明确报告相同rs_推理记录不存在、store=false时未保存，网关将其包装成502/Upstream request failed。该rs_编号与原成功响应中保存的reasoning itemId精确一致。实际安装SDK默认序列化发送item_reference；离线使用原响应和模拟fetch复现，显式providerOptions.openai.store=false时改为发送完整encrypted reasoning，工具调用/结果仍正确配对，零网络/模型请求。见workflow-sol-gateway-diagnosis.json及workflow-sol-serialization.json。

修复方向为本工程OpenAI Responses无状态历史适配；本轮仅诊断，没有修改runtime/provider、网关配置、运行服务或Task/费用记录，也未实施真实续验。原两次unknown费用和当前needs_review保持，不通过另建Task或继续盲重试绕过复核。该原因只确认Sol这两次续轮失败，Gemini超时仍保持独立结论。下方“网关原因未知”为诊断前历史状态。

## 2026-10-26：切换 Sol，真实候选已返回，GUI复用验收暂停于上游错误

用户要求改用`openai/gpt-6.1-sol`。保留原成功来源`2935de0d-e34e-467a-bbdf-0f1135f5428b`和原容器；原Gemini Task经原取消链终止，两条unknown账本逐字段不变。仅把本工程主库已有OpenAI设置的密文复制到隔离库，未改主设置或`.env`。当前仍为源码0.17.0-dev/SQL0018/工作站0.6.2，主预览0.15.1/SQL0015/guest5。

- 首个Sol编译Task `192d6ff2-fe9b-46a0-8547-e1ee35be77b9`用1次真实请求、31.6秒生成34步结构有效候选。模型把来源开头的其他应用观察/脱敏鼠标操作设为人工准备。独立验证Task `09eae96a-6f08-4216-bd9a-281050339f55`按计划请求接管，执行0桌面动作后取消；版本保持verifying。没有假装人工完成或手改候选。见workflow-compilation-sol-first.json及workflow-sol-first-attempt.json。
- 澄清编译提示：真实`human_checkpoint`证据仍强制保留；可由打开全新Thunar/重新观察建立的初始状态，不要求重放已脱敏的其他应用鼠标动作。第二Task `f9cb0de4-5ed7-471c-91c7-bc9e978614fa`的首个真实响应为31步、无人工步骤，但输入`/home/agent/`未满足现有`/home/agent`精确校验。候选被拒绝，没有写入计划。随后纠正请求返回`AI_APICallError: Upstream request failed`，另记unknown/费用未知。
- 用户明确授权同一Task追加一次。台北2026-10-26 09:44:49—09:44:56的追加仍为同一上游错误，原attempt保持，恰好新增1次请求。当前needs_review/draft/null plan，未追加下一请求。提示词已补精确可输入值及尾斜杠要求，模型遵从这一补充尚待真实复核；没有放宽输入校验或猜改provider。现有日志只保存错误摘要，无法据此判定网关内部原因。

`tests/workflow-sol.ts`沿用原submitTask/DBOS/模型账本/取消和动作链，支持原目录恢复和一次显式授权追加；保存随机请求键后受理，恢复复用同一Task，待复核的Sol Task阻止另建付费编译。5项workflow定向单元与类型检查通过。三组不同参数GUI验证及第四次ready复用仍为待验目标，本次0个Sol GUI样本完成，未生成成功workflow-sol.json。

本次Sol合计2个编译Task＋1个已取消验证Task、4次模型attempt：2次成功响应的目录价格估算合计$0.047178，2次上游错误费用未知，0桌面动作。全历史setup按Task去重更新为63Task/133attempt/108未知费用/7unknown结果；原10个冻结checked样本保持，合计73逻辑Task。原60Task报告原样保留，未知费用未清零。证据：workflow-sol-closeout.json、workflow-sol-before-authorized-retry.json、workflow-sol-attempt.json及workflow-sol-main-state.json。

主健康0.15.1、16迁移、0活跃Task、原PID、主配置和.env保持；实验worker/桌面已停，原来源容器未重建。 收尾36份源码/文档/报告/日志与本工程4个配置秘密值比对为0匹配，4份设计镜像逐字节一致；见workflow-sol-secret-scan.json。仅进程观察的首次子串匹配误计了父shell，改为完整命令行匹配后确认只剩原主worker，未重跑Task/GUI/API；原观测失败与修正见workflow-sol-closeout-trials.json。完整C4、真实模型修订质量、更多任务族、公网/VPS/长期运行和上游项目同条件比较继续未完成。下方旧统计保留各自历史范围。

## 2026-10-26：C1单次授权追加仍超时；生产目录检查与最终复核修复

**真实模型**：用户已明确同意同一原编译Task追加一次请求并接受费用。原Task `5b0ad29b-a729-439b-91a0-13f34fb090fc`的第二次Gemini请求在台北08:34:13—08:37:13运行180秒后超时；attempt1原记录逐字段保持，attempt2另记unknown。当前累计2次unknown/费用未知、0桌面动作，仍needs_review/空计划，没有第三次请求或替代付费Task。详情见workflow-compilation-authorized-retry.json。下方旧“等待首次授权”记录保留历史范围，当前授权已使用完。

**生产失败根因**：首次0.17生产容器验收实际3Task/81GUI动作/0模型，2完成、1取消；原中文任务完成了正确的`已完成`目录。只读检查原home确认Unicode码点5df2/5b8c/6210；生产worker默认C locale使GNU tar把中文输出为八进制转义，目录匹配因此误报。固定tar子进程使用C.UTF-8，Linux生产镜像和Mac原生tar对同一保留归档读取正确；guest/xdotool/字体/SQL/依赖保持。旧失败、489条workflow_step事件和实际3Task指标分别保留于workflow-production-before-tar-fix、tar-diagnosis、failure-metrics报告。

**最终复核**：修正执行完步骤后忽略blocked阶段、反复完成检查的条件；失败现在进入原workflow_review，末步骤说明为Fixed completion check。新定向真实GUI Task执行27动作后稳定等待；显式Continue仅重新只读检查，动作/检查点数量保持，版本未认证，再经原取消链终止。见workflow-final-review.json。首次测试夹具少算workflow_assert的1条检查点而退出，原Task/日志保留并已确认取消；修正计数后只重做该项定向Task，见trials报告。7项相关单元、类型检查通过。

**生产续验**：新Web/worker镜像分别为fdfeac24fe14/df82548bd24a，两份运行时代码逐字节匹配；工作站仍0.6.2/guest6。独立Linux生产安装实际完成3组新参数验证与第4次ready复用，108动作/0模型，中文合同通过。之后观看夹具在任务释放控制权后寻找桌面而超时，原命令报告仍保留passed=false；修正为运行中观看，并在同一安装只补1个真实27动作UI任务，原4Task指标完全不变。合成验收workflow-production.json为5完成Task/135动作/0模型/0人工请求，保留核心4与UI1各自门槛。实际优化网页noVNC画面、CA验证的HTTPS/WSS、服务端丢弃观看输入、真实Web端点worker可达/guest阻断、guest无秘密/socket/端口、Web非root/只读、审阅下载与390px界面通过。实际截图已查看，详情见workflow-production-ui.json；这次没有重跑原4Task或历史基础套件。

**成本与保护**：workflow-costs-production-closeout.json在原46个历史setup上加入C5、失败/成功生产、复核夹具及本次授权追加，当前60个唯一setup Task/129模型attempt/106未知费用/5unknown结果；原10个预冻结checked样本另列，合计70个逻辑Task。首个探索仍只计一次，旧46Task报告不改；缺匹配模型组/主动人工/环境成本，整体C4保持未通过。40份相关文件/日志对本工程9个配置秘密值扫描未见明文。专用VM、实验worker及桌面已停，保留数据；主health0.15.1/SQL0015的16迁移/0活跃Task、原PID和.env保持，见main-state报告。主预览未升级。真实模型候选质量、普通公网/VPS/长期运行及上游项目同条件比较继续未通过。

## 2026-10-26：C5本地分享与独立安装重新验证通过

当前源码为`0.17.0-dev / SQL0018 / 工作站0.6.2 / guest6`，没有新增依赖或guest能力。SQL0018增加导入包/请求键来源，允许本地来源Task引用为空，并以来源约束保留真实溯源。主预览仍`0.15.1-dev / SQL0015 / guest5`，未迁移、重启或覆盖生产构建。使用方法见 [流程包说明](WORKFLOW-PACKAGES.md)。

**实际实现**：ready版本经拥有者API生成白名单投影，使用新的包身份、中性名称/参数/步骤及三组虚构说明样例；删除原sourceValue、本地Task/版本/动作证据、修订来源、费用、截图与所有旧控制/授权信息。目录名必须参数化，任意固定生产目录/窗口文字拒绝便携导出。人工检查点保留，私有说明移除；下载前展示完整内容并要求审阅。外部包严格嵌套校验、有限Thunar操作、同源/owner/JSON/128KiB流式边界。导入只存draft，validated_environment为空，不建假来源任务、不启动桌面/模型；外部样例不计成功。原Task/DBOS/runtime/executeAction和三组独立认证机制直接复用，没有第二执行器。

**真实纵向证据**：workflow-sharing.json对应`agent_flowshare_e1b366c4df2041ba81118894118926c9`。从保留C2来源复制隔离库并应用0018后导出，接收端从空数据库初始化新owner/密钥/INSTALL_ID/home，没有provider配置。实际Web上传、服务器已提交但回执被丢弃、刷新重新审阅、同键重试/并发重试返回同一版本，内容冲突409；导入后0Task/0工作站，draft禁止普通运行与再导出。三组新参数分别完成27动作，第三组后ready，第四新Task再复用27动作；共4完成Task/108真实GUI动作/0模型attempt/0人工请求，全部宿主program_checked。空格/中文/新路径检查通过；中文截图仍有缺字，与既有字体问题保持相同边界。

7组纵向检查包含真实owner下载脱敏包、桌面/390px界面和无JS错误；原生桌面与Web截图已人工查看。来源原库/版本/Task数量和`.env`逐字节保持，原source环境与验证环境区分。目标版本`3ffe532e-3368-4c89-a19d-17b05741b4a9`拥有本机新身份，source/compilationTask为空，导入包不伪造本地成本来源。新库和源副本各19条业务迁移；原始C2库没有迁移。

**定向与失败记录**：6项新增包单元+5项原流程单元、类型及改动文件格式通过。workflow-sharing-provenance.json另外3项合成事务检查验证缺来源拒绝、导入流程修订草稿继承包来源/实际修订Task引用、草稿显式验证和全部回滚；它们不计真实GUI或模型修订质量。首次纵向因默认Playwright浏览器不存在，在创建Task前退出；改用本机既有UI_BROWSER_PATH后通过，未重做已完成GUI。失败库/日志与成功一起保留在workflow-sharing-trials.json。24份当时新增JSON/log/报告检查未见本工程配置秘密明文，见secret-scan报告；main-state确认主16条迁移/0活跃Task、原PID与0.15.1health，原C1仍恰好1次unknown、needs_review/draft空计划。所有实验Web/worker/桌面均已停止。

**边界与下一项**：这验证同一宿主/架构/镜像上的独立安装和home，不证明跨架构/远程云兼容。仅支持当前Thunar目录任务族，通用AT-SPI/按钮编号、网页与LibreOffice流程、市场/自动安装均未新增。C1真实模型提炼/修订质量仍未通过，已发送的C1重试授权问题继续等待，不重复发问或另建替代付费Task。完整C4匹配模型组/人工与环境全成本/消融、生产部署/普通公网/VPS/长运行和同条件上游项目比较仍未完成；C4原46Task成本报告保留原统计范围，本轮4个验证/复用Task单列，后续总成本收集需纳入。整体目标保持进行中。

## 2026-10-26：C4 计量工具与10组确定性GUI样例通过，正式对照未完成

源码仍`0.17.0-dev / SQL0017 / 工作站0.6.2 / guest6`，没有新依赖、迁移或guest镜像。新增`workflow:benchmark` CLI（freeze/submit/collect/report），复用原Task/DBOS/模型attempt/动作/人工请求/宿主检查，详见 [对照说明](WORKFLOW-BENCHMARK.md)。主0.15.1/SQL0015未升级。

**协议/通道**：预先固定恰好10组不同参数、独立三工作站、模型/指令/记忆、ready计划、实际验证镜像/协议/locale与坐标格式，私有manifest禁止覆盖。三个组使用同一目录路径但不同home，避免互相碰撞。受理比较冻结配置/安装/版本；新协议另固定provider端点，模型组在端点变化或旧协议缺端点时拒绝。`workstationChannel:desktop`可选字段在Task配置冻结；模型工具、runTool和executeAction共同限制为原生GUI/固定Thunar启动，直接Shell也在意图前拒绝。动作链按boot记录实际镜像/locale/协议的desktop_environment事件，只投影所需元数据，不输出容器环境。

**10组真实GUI**：workflow-benchmark.json对应agent_flowbench_e7942c8cc8fb43a0a2c701187ac5ef5f。manifest在2026-10-25T19:40:07.202Z（台北10月26日03:40）冻结，全部样本随后受理。checked组10/10完成，每Task27动作，合计270实际工作站动作/0模型请求/0人工请求，空格/中文/大小写变化均通过原宿主目录检查。任务墙钟中位33.8455秒，范围33.553—35.828秒，只有该组原始耗时，不作为对照加速证据。ASCII和中文截图已实看，中文名称字节检查通过但guest仍缺部分中文字形。该早期manifest在端点冻结改动前生成；现明确禁止用它受理模型组，baseline/repair保持0/10。

**本地通道夹具与恢复**：同库额外一个普通模型循环的本地固定响应Task完成目录检查，16请求，验证工具过滤、固定启动、逐次新观察、真实镜像事件和直接Shell拒绝。早期夹具把SDK截图的文本part数组误作metadata对象，在第二请求失败，形成1个成功响应/1个unknown后取消。修复仅针对夹具解析；resume保存旧失败result及日志，重复原source key/Task核对完整指标一致，10个已完成GUI样本没有重做。最终库12个新桌面Task（10确定性成功、1通道夹具失败取消、1修正夹具成功），原失败请求进入成本，不从新报告移除。没有追加云请求。

**成本**：workflow-benchmark-closeout.json和该库benchmark-report-status-counts.json收集46个唯一历史setup Task：22完成（18宿主检查交付、4编译结构候选）、22取消、2未结束。128个实际模型attempt包含全部97次C0探索、成功/失败编译、C3修订和本地夹具；105条费用未知、4条请求结果unknown，原始价格/人工独立核对值与未知状态保留。逻辑Task/segment/decision/attempt去重，数据库克隆不增加调用数；冲突副本明确报错。首个已交付探索a459092e在各策略中各计一次，另10个新样本形成11个交付位置的账，未把历史探索冒充预冻结样本。费用、token、模型时间、任务墙钟、人工请求等待分别统计，等待区间取并集，终止任务在终止时截止，不把等待时间当主动劳动。

**新协议定向检查**：workflow-benchmark-protocol.json对应agent_benchprotocol_4932f78f2c5341a6bb9ffa4495d8ee17。3检查通过：同工作站复用/端点改变/缺端点旧协议在模型组入队前拒绝；确定性组仍可零模型受理；相同端点基线受理冻结模型/合同，2个Task均只排队后取消，0桌面/0请求，不计真实GUI样本。

**结论范围**：12项相关单元、类型和变更文件格式检查通过。缺失匹配组仍按10的分母列出，未结束/失败/合同/模型/环境/通道不匹配不产生节省结论；费用未知总额保持null，只有两组全部完成固定检查才计算API差。主动人工劳动、专属环境准备、参数提炼劳动、基础设施费用和无检查复放消融未测量，all-in收益保持空，fullC4Accepted=false。真实C1未知云请求未重试；真实模型提炼/修订质量、匹配基线、更多任务族、完整云部署和整体超过上游项目继续待验收。收尾扫描57份C4顶层JSON/日志/报告，未见当前配置provider密钥或生成夹具密钥明文。主health仍0.15.1、16条迁移、0活跃Task；原C1仍needs_review/1次unknown，确认未追加云请求。全部实验worker/桌面已停止，主服务保留。下一可独立推进部分为C5本地导出/导入/隐私与外部schema/独立环境复核；多Agent继续暂缓。

## 2026-10-26：C3 有界局部修订与新草稿已接入

源码仍`0.17.0-dev / SQL0017 / 工作站0.6.2 / guest6`，无新依赖/SQL/guest改动，主预览0.15.1/SQL0015保持。`workflowExecution.allowRepair`默认关闭；开启时受理阶段检查并冻结所选模型，网页展示可能产生费用并沿用全局预算/最多1个模型决定。普通确定性流程不要求provider，旧请求payload保持原值。

**实现**：当前Thunar精确窗口条件等待10秒失败且本步未派发时，可沿原decide/模型账本生成一个局部候选。只提供失效步骤/下一步、当前截图/原生窗口、最近10条已确认键盘效果、参数和冻结完成合同；站立指令/记忆不进入修订。工具仅submit_workflow_repair，最多6个有限步骤；前缀可观察/关闭弹窗/打开适配对话框/导航，保留最后原定输入或按键。前缀不能重做创建/重命名、整段重启、Shell或修改合同。候选、失败、原观察/决定号和游标保存在checkpoint.repair，操作继续原runTool/executeAction。

**恢复/版本**：已保存模型响应但variant事务未提交时，worker恢复先重新观察当前控制代并匹配原生窗口，再复用语义候选；旧observation不授权输入。人工交还/boot变化丢弃旧候选。第二处失效/非法候选转review；未知动作不进入修订，Continue只核对固定结果；响应丢失保留unknown，普通Continue不创建替代请求。完整走完且宿主program_checked、无unknown的修订运行，在原完成事务另存下一revision草稿/repairOrigin，源ready不变。修订样本不认证源方法。拥有者可显式用新参数验证草稿，仍需3组完整独立同环境样本才ready。

**真实GUI核心7Task**：workflow-repair.json对应agent_flowrepair_c7b80f8aa7014e439bb8b5d187ab0e83，2完成/5取消、8检查。真实GUI Enter创建父目录后，测试控制台额外插入Create New Folder弹窗。成功Task f1eab809-066b-4b06-a9a1-511b4da1ce14在保存响应后/variant提交前SIGKILL；恢复只有1本地请求、父目录文字和escape各1次，45实际动作后固定检查通过并生成v2草稿。独立新参数Task在相同声明弹窗条件下29动作/0模型请求通过，v2仅verifying。另覆盖第二失效+Continue无新增请求/输入、非法整段重启拒绝、0费用上限请求前拒绝、真实目录效果后重启造成unknown不重派、模型回执丢失不自动重试。4本地请求3成功/1unknown，0云端请求；不据此证明模型判断能力。

**在途控制3Task**：workflow-repair-controls.json对应agent_repaircontrol_f1759fb247a843c1852a2012e3c0efd4，3实际Task按预期取消。真实请求期间接管/迟到响应/显式交还拒绝旧候选；真实60秒总时限在请求期间耗尽后无新输入；取消中断在途模型并保留unknown。3本地请求2成功/1unknown。workflow-repair-certification.json另外4项合成事务检查覆盖修订样本排除源认证、原3样本认证、完成重放草稿去重、unknown不生成草稿，不计新GUI任务。

**网页**：workflow-repair-ui.json在agent_repairui_c3746c0605004a0c9acb99ec9c0d5bba克隆库验证草稿/费用入口、显式修订checkbox、丢失响应刷新恢复checkbox/参数/同请求键、真实受理冻结模型/1决定预算、完成页显示修订及草稿。1WebTask只排队后取消，未启动worker/桌面/模型。桌面/390px截图已实看，无客户端错误。9相关单元、类型和变更文件格式通过，未重跑支付/Telegram等无关整套。

**失败/余项**：首次恢复agent_flowrepair_751fd6740d4c4eb498bd9e4e6264723c失败：刷新观察覆盖repair阶段为act，已保存候选未再处理；根因修复为保留请求阶段、重新观察后复用。首项合成认证夹具删草稿违反独立run外键，改为可回滚事务内先移除关联夹具；原失败库保留，不属于产品GUI失败。真实云C1原unknown仍待先前问题的明确授权回复，未重试。收尾检查：28份C3顶层JSON/日志/报告扫描未见配置provider密钥明文；主health仍0.15.1、16条迁移、0活跃Task。原C1真实Task仍needs_review/1次unknown，确认没有追加云请求。所有实验worker/Web/桌面已停止，只有原主worker运行。当前修订草稿要求相应弹窗前置条件，未宣称任意界面自适应。真实模型提炼/修订质量、其他应用、C4冻结10组匹配基线/全成本、C5导入导出、生产候选部署与整体超过上游项目继续未完成。

## 2026-10-26：C2 已有真实原生桌面复用与控制边界证据

源码候选 `0.17.0-dev / SQL0017 / 工作站0.6.2 / guest6`。0017增加task_workflow_runs和版本validated_environment，只在独立副本应用，主预览/主SQL0015未改。guest协议仍6，0.6.2新增thunar-keyboard-v1能力声明和固定Thunar启动适配。ready流程精确绑定独立验证时的实际镜像，历史来源镜像单独保存；每次新boot复核镜像/协议/locale与能力，禁止旧协议6镜像假装支持新适配。

**实际执行**：TaskInput.workflowExecution显式指定versionId、purpose=verify/run、参数与动作/时限；受理事务锁定版本、固定计划/参数/合同、创建运行记录并沿原Task/DBOS入队。普通任务仍原模型循环；流程下一步在同一runAgent里确定，经原runTool/executeAction派发。固定启动Thunar，其他文件修改只使用GUI键盘，无Shell/fs_*或宿主写入。每次输入先生成本控制代观察，核对当前Thunar精确标题；窗口移动不依赖旧坐标。动作后重新观察/前置检查，最终沿原完成入口只读提取目录树并独立核对。

已知动作回执与流程步骤检查点分开保存；同Task恢复按相同动作身份复用回执，步骤推进/事件同事务防重复。新Task重新执行，旧observation/epoch/boot不跨次使用。输入效果未知时checkpoint=blocked并走原review；Continue只复核固定结果，无法重新派发未知输入。控制交还先清空操作观察，检测人工已完成的最终结果时可交付，但不计入自动验证样本。

独立动作/总时限（默认120动作/300秒）覆盖零模型路径；界面等待上限10秒。达到限制后只读核对/请求处理，不继续输入。执行不需要配置provider，也不触发模型账本。3组不同参数、完整走完并通过检查且无unknown动作、同一实际环境，才能把verifying变成ready；提前人工完成或未知轨迹不会帮助认证。已受理Task使用冻结计划，版本状态变化不更改它。

**原生实测**：workflow-execution-core.json对应agent_flowrun_2b122e03d4344f0985e94f316e77e1a1：4Task全部完成，每Task27工作站动作/0模型尝试；前3组变化路径与名称（含空格、中文），第4组使用ready版本。第2Task在真实key_type成功回执后、流程检查点事务提交前SIGKILL，恢复后同一文字只输入一次；固定目录检查均program_checked。4Task实测运行约35.761/37.262/32.236/32.681秒，不作为同条件速度收益。中文文件名宿主字节检查正确，当前镜像截图有中文字形缺失，保留视觉兼容边界。

workflow-execution-controls.json对应agent_flowcontrol_83091083e85d4f8891e0d5ad98cb1b06：5实际Task/1完成4取消，0模型尝试。覆盖真实原生动作后取消与工作站停止；maxActions=1继续后无新增动作；实际10秒时限；接管后计数稳定/移动窗口/显式交还新epoch后继续完成；GUI Enter已创建目录但回执未完成时重启容器，unknown保留，Continue只检查结果且不重派，最终取消。原4Task较早版单独归档initial，新增期限用例不冒称原版已覆盖。

workflow-execution-certification.json是独立数据库事务内基于保留真实样本的合成状态检查：提前完成/unknown样本排除，3条完整样本才认证。仅证明认证逻辑，不增加真实GUI Task数量。8项相关单元及类型通过；额外5项目录检查/CSV比较单元通过。最后补充原executeAction派发授权回调再次检查动作数/数据库墙钟，拒绝中断恢复后缓存的过期决定，4项认证事务检查含该边界；此前真实core/control/UI结果在这项窄授权复核之前，未无必要重跑全部真实任务。原test:runtime:cua的1项人工等待重启→交还→下载/CSV检查通过（agent_runtime_b05a9b5c747b4d35a9128057660a3cc5，SQL0017，原0.6.1通用guest），无需重复其余支付/Telegram/容量全套。

**界面**：流程页新增样例验证/ready运行、工作站与新参数表单；未确认回执的参数和请求键重载恢复。原任务页显示版本模式、当前步骤/停止原因。workflow-execution-ui.json对应agent_flowui_503fce3cec7b4a00be014980588cba85：真实网页提交Task d1ccf7b1-e133-4aee-a0bf-ee1c46f2631d，27工作站动作/0模型请求并通过program_checked。截断第一次表单请求后重载，原工作站/参数/请求键恢复，第二次真实POST受理；桌面与390px表单/完成页实看，显示15/15步骤，无横向溢出或浏览器错误。页面使用既有样式，无新UI依赖。

**失败与保留范围**：首次C2源适配用了Thunar不支持的--new-window，启动后窗口检查停在Chromium，无文件修改；保留agent_flowrun_464f52b62fe04d2599adef992fb92c70。核对容器原生--help后改为--window，并记录启动退出错误，后续真实样本通过。原始initial成功和最终boot/认证规则收紧后的4Task分别保存。Web检查中严格定位歧义/新页面开发热更新造成的失败分别保留，不转写成用户任务失败或模型费用。临时tsconfig方案未解决热更新，已移除；最终测试采用Next自带--webpack模式，暴露共享CSV比较UI经artifact-checks导入node:path。固定目录合同已保证无尾斜线，改用字符串末段提取同义basename，移除客户端Node依赖；目录/CSV相关5单元和实际Web任务通过。生产配置保持原样。

C1真实模型成功候选仍未验收：原Gemini超时unknown1/费用未知，仍待明确追加授权，未重试。当前C2候选由受控提供者从真实来源的受理链生成，不能写成真实模型自动提炼并复用成功。C3局部修订、C4预先冻结10组匹配基线/全成本、C5本地导入导出及完整云部署/长期容量/上游项目对照继续未完成，整体目标保持active，多Agent继续暂缓。

## 2026-10-26：C1 已接入并通过受控检查，首次真实编译请求暂停

当前源码 `0.17.0-dev / SQL0016 / 工作站0.6.1 / guest6`。新增0016仅创建 `workflow_versions`，属于流程编译，与已归档且从未应用的0.16团队迁移分别保存；17条迁移只在独立实验副本应用。主6797/6798仍为0.15.1-dev/SQL0015/guest5，未升级、重启或改主配置。

**已实现**：拥有者从已完成、单执行段、宿主目录树检查通过的任务声明目录名参数；受理时固定源段/动作序列、清洗轨迹和原完成合同，编译Task、版本草稿与DBOS入队同事务。模型沿原runtime/model/预算/计费链，仅能调用submit_workflow；固定JSON/Zod计划包含观察、Thunar启动意图、键盘操作、窗口断言、人工检查点，宿主只校验有限结构，无生成代码求值。源截图、秘密输入、指针坐标、浏览器/观察/控制引用和审批不进入编译输入；不明私有或人工片段保留检查点。原窗口标题仅保留与目录合同相符的allowlist。

候选schema通过后和Task完成同事务保存为verifying，原检查合同由宿主绑定；仍然禁止作为ready流程运行。记录来源工作站实际镜像ID/协议/locale，拒绝在源容器重建后猜测原环境。网页新增“保存为流程”、目录参数/固定检查展示、可读步骤、来源和编译费用入口；提交回执丢失后保留自定义表单与同一请求键，刷新后可恢复。当前open_application仅为计划操作，实际驱动解释与新Task执行属于C2，尚未实现。

**定向证据**：3项workflow单元通过，包含绑定/输入边界、秘密及旧引用清洗、人工检查点和编译专用上下文/工具；TypeScript通过。共享完成入口抽取为finishTask，原 `test:runtime:cua` 的1实际受控Task通过：DOM→人工桌面键盘→交还新观察→下载与宿主CSV检查，含worker在人工作业等待期间重启，原始 `agent_runtime_70add242a8654e009a658be9b015d32f`。没有重跑支付、容量、Telegram等无关全套。

`workflow-compilation-controlled.json`：真实C0来源Task2935de0d的轨迹进入原受理/队列；受控本地提供者1次响应生成15步候选，0个工作站动作，3参数换为中文新值的固定合同绑定正确。owner越权/合同削弱/重复参数/来源键冲突、候选ready拒绝、认证API、桌面/390px页面和拦截模拟的表单回执丢失/刷新去重通过；自定义流程名和参数名恢复已验，截图实看无横向溢出。最后原始目录 `agent_compile_71ca1b29f16140aeb24f3b5b3c4449fb`。此前两个受控Task同样保存候选，整项分别因缺Playwright默认浏览器和开发时热更新导航中断而失败；另一个较早受控成功保留。四项均为本地固定响应，不作为真实模型提炼质量或模型费用收益证明。

**真实模型未通过**：Task `5b0ad29b-a729-439b-91a0-13f34fb090fc` 在 `agent_compile_89b32692f49640c5b7887bb19091d06f` 的首个Gemini请求180秒超时。账本保留1次unknown/unpriced尝试，Task为needs_review，版本draft/plan=null，未自动重试。已向拥有者提出一次明确追加请求授权问题，回复前不再请求此验收。隔离worker已经停止。28份C1记录/日志和主.env扫描未见配置provider密钥明文（workflow-compilation-secret-scan.json）。报告 `workflow-compilation-real-attempt.json`，全部尝试见 `workflow-compilation-trials.json`。C0的97次成功/未定价请求与本次未知尝试分别保留，均不当成零费用。

**余项**：C1真实模型成功候选及恢复验收未完成；C2确定性解释器/运行记录/变化输入/取消接管未知效果验收，C3局部修订、C4正式匹配成本对照与C5导入导出仍待实现。T19只具有上述受控范围，T20—T22未通过；尚无可复用的真实Thunar自动化闭环，也未证明整体超过上游项目。容量夹具关页多一次新截图，精确调用门槛由每轮7改为8；本轮未跑Linux容量套件，历史容量证据不改。

## 2026-10-26：C0 已有无提示成功来源，C1 尚待接入

源码候选 `0.17.0-dev / SQL0015 / 工作站0.6.1 / guest6`。复用原 Task/DBOS、模型和动作分步账本、控制权、取消、成果与价格记录，没有新数据库迁移。主预览6798实际仍报告0.15.1-dev；本轮未升级主库、配置或主服务。0.16团队代码保持归档。

实际新增：每帧 observationId 与 epoch/boot 绑定；每帧只授权一次桌面输入；窗口变化、接管交还及控制器重启后旧观察拒绝；指针显式坐标格式和确定性转换；模型上下文只保留当前控制代最新一帧，原始审计图不删除；X11原生窗口标题/类别/客户区绝对位置；固定宿主目录树检查器。GUI能力目前是窗口状态和键盘/鼠标，尚无通用AT-SPI控件树或视觉按钮编号。

`desktopCoordinateMode`由Task受理时固定，系统指令、工具literal schema与输入校验使用同一值；支持pixels/normalized_1000，默认pixels。禁止按坐标数值或模型名称自动猜格式。该字段已有任务API和定向验收入口，网页选择控件尚未新增。驱动记录原输入和实际像素输入。

**已执行检查**：10项相关单元通过、TypeScript通过；`npm run test:c0:desktop`在0.6.1实容器通过10项，涵盖坐标映射、边界、一次消费、重复dispatch回执、接管、窗口尺寸变化、原生Thunar观察、控制器重启和动作后截图丢失，见 [desktop-observation.json](evidence/desktop-observation.json)。此前并发试跑有一次状态轮询超时，原失败目录保留；当前检查按90秒实际期限轮询并保留动作状态/失败容器日志，不重派未知动作。`test:runtime:cua`一项受控Task通过，但发生在最终格式冻结/窗口修正之前，不作为最终候选全部回归结论。

**真实任务来源**：Task `a459092e-9f6a-41fb-8af7-a13bfa2ba0a6` 无人工提示/桌面输入完成Thunar创建目录→Draft→Ready→分享截图；23次成功模型请求、22个工作站动作，仅screen/pointer/key工具，实际key_type仅目录名、Draft、Ready。宿主在完成入口只读提取目录快照、拒绝链接并核对Ready存在/Draft缺失，Task结果为program_checked。这次成功发生在0.6.0镜像，原始结果保留于 `data/experiments/agent_flow_90d5c576902249bc8bf4d21c11c6a425/result.json`。窗口位置修正后的0.6.1又完成独立Task `2935de0d-e34e-467a-bbdf-0f1135f5428b`，17次成功请求/16动作，新目录输入，无人工提示或桌面输入，宿主检查通过；截图已实看Ready。最新结果见 [flow-c0-baseline.json](evidence/flow-c0-baseline.json)。两项均只通过GUI修改文件。

前两次像素契约/模型自行选择格式的探索均在请求间隙取消，32+25次请求全部收到成功回执；与两次成功的23+17次合计97次，均未定价，金额未知，未知请求结果0。费用不清零，不将取消试跑从成本中删除，见 [flow-c0-trials.json](evidence/flow-c0-trials.json)。该组未做同条件上游项目对照，也未证明净收益。

窗口位置修正来自现场诊断：Xfwm下xdotool返回Thunar位置325,216，xwininfo实际客户区位置320,187；差值等于装饰边距5,29。0.6.1改读绝对客户区位置，并明确boundsSpace。源0.6.0证据保留其原范围，未覆盖为修正后结果。随后缺失截图程序的故障检查暴露spawn错误监听晚于异步fd.close的问题；修正为同步注册监听、在完成/失败后关闭fd。缺程序错误从崩溃变为明确回传，动作后截图失败保留成功回执、清空已消费观察，10项guest检查再次通过；未为该错误分支重复运行真实模型整任务。

**后续关键路径**：C0已有两个无提示真实来源；将最新成功Task提炼为参数化候选（C1/T19），然后同执行链交付一个新Task可复用流程（C2/T20）。编译器、流程版本/运行记录、候选验证和修订尚未实现；多Agent、云部署余项和完整上游项目比较继续分别验收。

## 2026-10-26：流程编译已确认，设计待实现

设计稿1.25新增《CUA流程编译与自动化复用.md》和《主会话指导-流程编译.md》，同步设计源与 docs/design。用户确认成功轨迹→参数化候选→验证→新 Task 执行→有界修订→全成本对照，按 C0—C5 推进。研究参考为 AgentRR、MobiAgent、PACE，原文来源和本项目取舍分开登记。

当前新增范围只有文档。编译器、流程版本/运行记录、逐帧绑定、跨输入复用和局部修订尚待实现；未新增 SQL、guest 协议、模型调用或性能证据，未重启/迁移服务。最近运行快照仍见下方2026-10-25记录，本次未重新探测在线状态。

主会话按 [指导文本](design/主会话指导-流程编译.md) 先复核当前代码，再做 C0/C1 和一个 C2 纵向流程。原生无提示可靠性、当前观察/坐标、同执行器与未知效果规则是前置条件。多 Agent 暂缓，云DNS/VPS/长期运行另验。

更新日期：2026-10-25。当前已接入自然语言模型运行时、控制/恢复和基础记忆，处于 P2—P7 部分实现阶段。
已完成两项公网浏览任务及一项带监督提示的桌面软件任务的真实模型验收；通用任务可靠性、完整保留功能、云部署和 上游项目 对照仍待验收，整体超过参考项目的目标保持进行中。

**桌面软件定向实测（2026-10-25 22:10，Asia/Taipei）**：按用户要求打开本机 Web 界面，通过正常任务入口测试容器里的 Thunar 文件管理器。GPT 成功3次模型请求后连续两次上游错误，其中一次重试获用户明确授权；保留2次费用/结果未知记录，并按授权取消后切换 Gemini。Gemini 同一助手新任务完成：应用菜单打开 Thunar→图形界面创建 `CUA-GUI-Demo-20261025`→新建 `Draft`→重命名为 `Ready`→`screen_share`。40次成功模型请求、39次成功工作站动作；全部模型决定核对未使用 Shell、fs_* 或 browser_*，40次请求未定价，费用未知。宿主在完成后只读核对 Ready 存在、Draft 已消失。

该次完成包含一次监督提示：初期点击偏差与0—1000归一化坐标被按像素执行相符，测试端通过接管/交还说明明确1280×800绝对像素约定，没有人工操作容器内应用或创建文件；随后模型改用应用菜单与键盘导航完成。当前 Alt+F2 未打开启动器。此证据记为**提示辅助通过**，通用无人干预桌面能力仍待验证，坐标说明尚未修改到运行时代码。默认模型已恢复GPT，未迁移数据库、重启服务或调整网络规则。两个本轮任务最终1完成/1取消，0活跃任务。原始动作截图、Web实时画面及明细见 [desktop-apps.json](evidence/desktop-apps.json)。

**当前交付（设计稿1.24，2026-10-25 20:07，Asia/Taipei）**：用户已明确授权备份升级，并提供模型网关及两个模型。主服务现为 `0.15.1-dev / SQL0015 / 工作站0.5.0 / guest5`，网页6797/worker6798均在线，拥有者登录200；原44张表/5491行旧值及10份成果保留。新增一个Personal Assistant，默认 `openai/gpt-6.1-sol`，可切换 `custom/gemini-3.8-flash-high`。本机使用见 [QUICKSTART](QUICKSTART.md)。此前“待升级确认/无模型/预览停止”已解除，保留为历史记录。

**真实模型结果**：同一个助手/工作站的2Task全部完成：公网HTTPS→截图→DOM→键盘刷新→重新观察→Markdown交付，两个下载均独立核对标题/来源和实际DOM原文。GPT8请求，目录估算$0.035439；Gemini9请求尚未定价，显示未知，未按免费处理。无失败/未确认请求。实际桌面/390px完成页实看，无浏览器异常/溢出；见 `real-models.json`。新密钥通过拥有者设置API加密保存，44张业务/认证/DBOS表及运行日志扫描未见明文，.env仅改工作站镜像。

**边界**：B1—B5受控生产容器证据继续有效，B6本机真实模型/公网任务已通过；当前Mac开发预览没有启用Linux出站守卫，原带守卫DNS/fake-IP失败与实际VPS/ACME/长期容量、完整上游项目对照仍待验。主预览为独立Node进程，无登录自启动/自动重启监督；launchd尝试在Node启动前返回EX_CONFIG，已移除注册并归档。产品整体目标未完成，多Agent继续暂缓。用户当前可直接使用本机基础版，不等待这些后续范围。

### 历史：基础候选与升级前准备

**当前优先级（设计稿1.23）**：用户要求先交付单 Agent CUA，多 Agent 暂缓。未完成0.16团队代码已归档并撤出，0016从未应用。基础候选`0.15.1-dev / SQL0015 / 工作站0.5.0 / guest5`沿用0.15运行逻辑，修正Compose/配置生成器/说明的版本配对，新增生产容器基础定向检查；完整范围见 [基础交付单](BASE-DELIVERY.md)。主服务保持`0.8.1-dev / 0011 / guest2`，没有隐式升级。

本轮部署配置2项单元、TypeScript和Web/worker生产镜像构建通过。`test:delivery`已在独立Linux VM的生产容器通过2项实际任务（1完成/1取消）：同一浏览器DOM操作→可见桌面→人工登录→worker SIGKILL恢复→交还→一次报表下载/CSV金额620；实际Shell心跳启动后取消，guest移除、保留home心跳停止。真实Web端点有宿主可达/guest阻断对照。实际健康0.15.1、16条业务迁移、guest5配对，见 `basic-cua-production.json` 与 `basic-cua-delivery.json`。首次脚本沿用旧弹窗关闭假设而失败，原记录保留；只修测试并重跑这两个相关任务，生产UI未改。

B1—B5已有受控生产容器证据，B6真实模型/公网仍待验。原0.15手机3+5Task、0.13交接11、0.14例程3和0.12支付9+11保留各自历史证据；均不增加本轮前置需求。普通公网原失败保持，基础检查不代替真实模型、完整云部署或上游项目对照。

**当前本机入口状态（11:17 UTC复查）**：6797/6798均ECONNREFUSED，无对应监听进程，停止原因未确定；本轮未停止/重启主服务。保留安装的最近运行版本为0.8.1，主库仍12条迁移/5完成Task/0工作站，provider0/默认模型未解析，配置guest2未变。先前给出的设置页当前不可达；已请求确认备份后配对升级预览，未获确认前不迁移或重启。原主服务健康快照保留为历史，不作为当前可访问证据。

**升级准备（11:22 UTC）**：已在预览停止、源库无其他客户端且无工作站/home卷的条件下，保存私有数据库导出、10份成果文件及独立600权限配置副本。在独立新库实际恢复，再执行同一生产迁移脚本0011→0015；44张旧表的5491行原字段逐行保持一致，历史执行段快照回填正确。原主库仍12条迁移，配置/成果字节不变，成功演练库已删除；见 `basic-cua-upgrade-rehearsal.json`。这是本机数据备份与副本升级演练，没有启动主预览，不包含缺失的0.8.1应用镜像，不能代替完整F12回退包。

**自动推进阻塞审计（11:25 UTC）**：连续三轮观察到同一前置条件：旧预览未启动，实际升级确认尚未回复，本工程provider0/默认模型未解析。上一轮已完成备份及副本迁移，本轮只做当前状态复核，没有在跑的实验可等待。基础检查/升级保护均已有证据；当前不重复这些检查、不扩展已暂缓功能、不越过确认迁移或寻找其他工程密钥。目标按blocked保留，尚未完成；收到原升级确认并完成本地模型配置后再推进B6/实际部署与整体对照。审计见 `basic-cua-blocked-audit.json`。

## 已实现的实际能力

| 范围               | 实现                                                                                                        | 证据                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 来源与独立工程     | 固定 上游项目 v0.6.0；保留 MIT；选择性迁入 UI、模型与桌面模块                                               | provenance.json、LICENSE                       |
| 数据与拥有者       | PostgreSQL/Drizzle；部署端一次创建；公开注册关闭；拥有者资源检查                                            | db、scripts/owner.ts、web.json                 |
| 持久化执行         | 单 worker 数据库租约、工作站队列分区串行、任务与 DBOS 入队同事务                                            | g01.json                                       |
| 请求与事件         | 来源键去重、参数冲突、事件顺序和 SSE 续读                                                                   | G01、Web 检查                                  |
| 模型与 Agent 设置  | 11 个 provider 工厂、异步配置、密钥加密/脱敏、环境来源、创建/编辑 Agent                                     | runtime-ui.json；实际模型服务仍待逐家联调      |
| 自然语言运行时     | 生产 AI SDK/HTTP 请求；模型决定与工具分步；DOM、桌面、Shell、文件、人机问答和完成工具                       | runtime.json、runtime-cua.json                 |
| 模型回执与恢复     | 回答保存后无需重新生成；未知可能计费的请求等待用户同意；保留未知费用                                        | runtime-recovery.json                          |
| 上下文与预算       | 复用上游压缩/图片适配；逐任务步骤/费用边界，未知计费可见，支持用户追加额度                                  | runtime.json、runtime-usage.json               |
| 共用浏览器         | DOM、桌面、人工登录、下载共用一个有界面 Chromium；正常重启保留 Cookie                                       | g02.json、runtime-cua.json                     |
| 动作回执           | 稳定派发 ID、guest journal、已知结果复用、未知外部提交等待复核                                              | recovery.json                                  |
| 服务端只读         | 独立不可由 Agent Shell 修改的只读 sidecar，服务器丢弃观看输入                                               | control.json                                   |
| 人工交接           | 持久化请求、epoch、撤销旧连接/票据、释放残留按键、交还说明和新截图                                          | control.json、runtime-cua.json                 |
| 实际取消           | 中止模型 HTTP 请求；停止容器及逃离进程组的 Shell；框架取消 outbox                                           | runtime.json、containment.json                 |
| 控制故障处理       | 控制器挂起仍可取消；不同工作站独立控制作业；停止确认后隔离                                                  | containment.json                               |
| 成果提取与验证     | 有界普通文件提取、宿主侧 CSV 字段/日期检查、模型修正、人工确认、实际下载                                    | runtime.json、runtime-ui.json                  |
| 基础长期记忆       | 按 Agent 存储；模型 write/forget；设置页添加/刷新/忘记；事务回执防重放复活；下个任务加载                    | runtime-memory.json、runtime-ui.json           |
| 任务界面           | 真实模型任务和 Recovery Lab 分开；控制、请求响应、用量、成果与手机布局                                      | desktop.json、runtime-ui.json                  |
| 多轮对话           | 同线程追问、逐轮任务和快照、人工问答历史、旧成果保留、有序分页、重命名/导出、会话草稿和跨重载请求去重       | runtime-chat.json、runtime-ui.json             |
| Telegram 文字入口  | 加密 Token/配对、单 worker polling、冻结 inbox/游标、任务去重、多轮、实际停止、问题答复、版本按钮和通知     | telegram.json；真实连接尚未验收                |
| Telegram 发送恢复  | 先保存派发意图；断连与在途退出登记未知，不盲目重发；明确授权重发；已拒绝的 429 延迟重试                     | telegram.json                                  |
| 持久化例程         | 五种计划、IANA 时区/DST、版本/日期/输入快照、漏跑、独立任务与一次性忙时排队                                 | runtime-routines.json                          |
| 跨期比较与条件通知 | 两份宿主 CSV 独立求和、精确阈值/方向、零基期核对、原完成事务与渠道决定                                      | runtime-reports.json                           |
| 用量与月预算       | 逐次请求/价格快照、拥有者时区、付费容量互斥、月度等待、到期重查、未知费用核对、模型汇总与明细               | runtime-usage.json、spend.test.ts              |
| Linux 部署候选     | Web/worker 镜像、Compose/HTTPS、独立配置和 guest 宿主规则已实现；整套部署未放行                             | deployment-private-attempt.json（失败）        |
| 一致备份与干净恢复 | format-2 的全库/成果/home/固定镜像、独立密钥、控制/会话失效及未知等待恢复；两台 Linux ARM VM 受控通过       | restore.json                                   |
| Shell 中断复核     | signal/timedOut 回执在 guest 与 host cache 两个入口进入复核，保留普通退出码语义                             | action-receipts.test.ts、restore.json          |
| 短程资源与空闲停机 | 受控 8 任务基线、9 任务实际定时停机/自动唤醒；默认 15 分钟、无未终止任务才停机、保留 home/容器              | capacity-baseline.json、idle-workstations.json |
| 凭据与身份填写     | 五类加密存储/安全提供；login/code/identity/card/UPI精确现场单次填写、消费及未知复核；支付选择/来源核对/接管 | identity-fill.json、payment-preparation.json   |
| 手机交接名单       | owner源/代绑定，收件冻结，切换清空与草稿轮询保留；新3Task加原8组/5Task通过                                  | telegram-delegation.json                       |
| 例程交接名单       | 计划权限随触发冻结，编辑/启停保留旧运行；手动及真实定时复用原交接链，空名单实际拒绝（3Task）                | routine-delegation.json                        |
| 顺序交接受控机制   | 原Task总预算/原对话入口、每段快照、目标队列、文件冻结/复制、两个恢复窗口与本轮owner名单（11实际任务）       | handoff.json                                   |
| 最终付款受控机制   | 独立最终批准/单次派发、页面结果独立存证、无效现场/结果拒绝与三种回执窗口；原9任务+edges11通过               | payment-submission.json                        |

## 最新检查与证据边界

证据目录：`docs/evidence`。

| 检查                  | 已验证内容                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| runtime.json          | 错误 CSV → 具体反馈 → 修正 → 人工确认 → 真实提取；4 次不重复模型请求；取消真实 HTTP 请求且不派发工具                                      |
| runtime-recovery.json | 外部锁精确阻塞 DBOS 检查点，回答业务回执已保存后强制退出；恢复复用回答；未答请求等待重试授权并保留未知费用                                |
| runtime-cua.json      | 生产模型循环驱动 DOM → 人工桌面登录 → 交还说明/新截图 → 下载/文件 → 成果；人工等待期间重启 worker；工具图片批次顺序                       |
| runtime-memory.json   | 保存/忘记、拒绝跨 Agent 删除、已提交写入回执重放不复活后续删除的笔记、新任务读取偏好                                                      |
| runtime-chat.json     | 23 个实际轮次（22 完成、1 取消）；同线程上下文/成果路径/人工答复、并发互斥和隔离、问答等待重启、取消后继续、分页和重命名                  |
| runtime-ui.json       | 实际网页配置/Agent/记忆/CSV；同线程修改文件、受理响应丢失→刷新→原任务复用、草稿、重命名/导出、私有 Markdown 与手机/最新回复滚动           |
| 既有 G01—G04          | 事务/去重/步骤恢复、共享浏览器、只读/交接/取消、已知下载复用和未知提交复核                                                                |
| telegram.json         | 精确阻塞任务已提交/收件回执前窗口后退出；恢复只有一个任务；问题等待重启与原生回复、同线程追问、回调版本、发送未知与撤销；实际手机设置界面 |
| runtime-usage.json    | 台北/纽约月界与 DST、双工作站付费准入、零/耗尽/未知费用、人工核对、期限恢复、bigint/旧记录和实际费用界面                                  |
| containment / desktop | 控制器挂起、跨工作站控制、真实停止边界及实际可见 noVNC 画面                                                                               |

受控 provider 按预定协议返回工具调用。realModelJudgmentEvaluated 为 false；它证明运行机制，未评估真实大模型理解、规划或网站适应能力。
配置密钥已检查加密落盘、优先级、脱敏视图和不进入任务/DBOS 记录；定价来自固定上游与测试价格，金额属于估算。

费用阶段 TypeScript 与 production build 通过。已排空旧任务、应用数据库迁移并定向重启本工程预览；0.5.0-dev 健康检查、生产页面/API、拥有者登录/退出授权检查通过，见 preview.json。这是本地生产构建预览，尚未对外发布。

## 已发现并修正的根因

1. 早期为 Docker/Colima 发布端口增加真实连接探测；0.8.1-dev 桌面传输改用 Docker exec，已移除该依赖。旧次转发失败的 Colima 内部原因未诊断。
2. 只读 sidecar 与工作站 IPC 隔离导致共享内存截图黑屏，观看端使用 -noshm；最初仅握手成功的 UI 记录已作废。
3. Chromium 信号退出重复处理导致 Cookie 未正常保存，由唯一 controller 关闭 context。
4. AI SDK 7 使用 instructions 参数，运行时将内部 system 历史单独传入。
5. 模型取消需传播 TaskCancelled，避免误走一般故障隔离并与取消控制器同时移除容器。
6. Base UI Button 默认不提交表单，默认模型/Agent 按钮明确 type=submit。
7. 同批工具含截图时，先汇齐全部 tool results，再添加截图/用户说明，避免破坏 provider 消息协议。
8. 交还说明从已提交请求读取；人工等待重启或模型请求期间交还都保留说明并重新观察。
9. 记忆修改与回执同事务，重放旧写入读取原收据，不重新创建已被后续忘记的笔记。
10. 对话使用独立轮次和受理锁，历史在受理时冻结，避免并发交叉和旧桌面引用复用。
11. 待确认提交键跨重载保留，成功受理才清空草稿；已受理但响应丢失时重试不会新增轮次。
12. Markdown 禁用原始 HTML 和远程图片自动请求；实际截图检查发现需跟随最新消息，复用滚动依赖并加入位置断言。

早期失败记录保留在忽略目录 data/experiments；证据汇总指向通过的原始目录。

## 仍需完成

本轮执行顺序：基础生产容器闭环 → 配置后的真实模型/普通公网任务 → 用户可照做的交付与升级。下列完整产品余项保留为后续路线，不自动续做团队、支付、例程或高级记忆。

1. **真实模型验收**：使用拥有者授权的 provider 或本地模型，完成实际输入任务并记录选择工具的效果和费用。本机已配置用户网关并完成两个模型的两项公开网页任务；后续扩展真实网站及用户实际任务，不把两项通过泛化为总体成功率。
2. **保留功能**：更完整的工具输出卡片、语音输入/对话管理、付款提交的真实站点/模型适配、周期报表真实网站验收、费用趋势/按 Agent 汇总、squad配置/成员限制与交接更多分支。逐次费用、月预算与核对界面已接入，真实账单联调待验收。Telegram 文字配对/通知已接入，真实 bot 网络、附件与接管/预算等更多联动分支仍需验收。
3. **记忆与重复流程**：目前最近 30 条/12,000 字符快照；相关性选择、冲突修正、经过验证的周期流程与历史彻底删除待完善。
4. **安全与故障范围**：ask_user 的高风险识别目前依赖模型提示词，任意 Shell/网页操作尚无完整语义级硬审批。复核、预算和传输分支仍需按变更逐项扩展。
5. **部署发布**：受控 Linux Compose/HTTPS、F12、scoped 网络、单工作站短程容量与空闲唤醒已有分项证据；普通公网 DNS、长期容量/磁盘保留、实际 VPS/ACME、升级和第三方许可库存继续验收。实际云厂商网络及元数据另验，当前端点模拟不能代替实际部署结论。
6. **对照验收**：固定 上游项目、同模型/任务/初始账号条件，对比成果、人工介入、恢复、资源、耗时与费用。

## 已接受的边界与代价

- 一个 worker、单工作站串行，人工等待占用其队列；多 worker 不在首版范围。
- Shell 可修改 guest 系统，冷重建丢弃系统层和内存现场，保留 home/profile。
- 只读 sidecar 保护观看边界，不把可修改的 guest 当可信验证器。
- CSV 结构/日期检查不证明网站数字与业务结论真实；摘要单独标注模型报告或人工确认。
- 笔记会发送给选定模型；删除笔记影响未来任务，已受理任务保留审计快照。
- 整机断电、Docker 守护进程故障、公网 HTTPS 与长期负载尚未验收。

具体实现协议见 `docs/design/模型执行与成果验证.md`、
`docs/control-protocol.md` 和 `docs/decisions.md`。

## 当前环境与资源

新增会话边界：侧栏显示最近 50 个对话，每个对话分批读取 20 轮；模型读取最近最多 50 轮、64,000 字符，省略明确记录。完整工具原始输出、语音和对话删除管理继续迁移。浏览器草稿为标签会话内数据。

Node.js 24.20.0、Docker Engine 27.4.0（Colima）、独立 PostgreSQL 16 开发容器绑定本机 55433。
已有 PostgreSQL 15 的 tablespace 问题保持原样；未修改既有服务。

本地预览：Web 6797、worker 6798，运行 worker/源码为0.15.1-dev；主库已应用0015（16条业务迁移）。当前工作站配置为personal-agent-workstation:0.5.0 / 协议5。旧0.8.1预览记录见下述历史证据。此前已在零活跃任务/零工作站情况下定向重启，类型/生产构建、拥有者授权与手机设置检查通过，见 preview-desktop-stdio.json。后续候选和 F12 未自动升级主服务。
旧拥有者不重复初始化，旧恢复实验保留；真实 Agent 可在设置页创建。

`.env` 与 data/dev-owner.json 仅用于本地开发，凭据不输出到文档。集成检查使用独立临时数据库、
安装 ID、端口和 Docker 资源；成功后删除数据库/容器/volume，保留日志与截图。

## 发布前依赖事项

- 首次审计的 4 条 moderate 关联记录集中于 drizzle-kit 旧 esbuild 链；未使用其开发服务，发布前核对兼容修复。
- pg 8 的同连接并发 query 弃用提示仍需定位；没有静默压制或直接改依赖源码。
- 模型费用已改 bigint，并校验安全整数/非负用量；受控大额存储通过，真实 provider 费用差异仍需核对。

## Telegram 本轮落地与边界（2026-10-25）

新增迁移 0007：telegram_connection、telegram_updates、telegram_outbox。来源清单现为 44 copied、26 adapted、1 excluded；新增 API、配对字母表、命令语义和设置流程来自固定上游，生命周期改接既有任务入口。Telegram 初次迁入保持当时 0.4.0-dev 任务版本；费用版已升级 0.5.0-dev，渠道继续使用同一个任务运行器。

`npm run test:telegram` 已通过 8 组检查。真实 worker、DBOS、模型 HTTP、Docker 工作站和浏览器实际运行；Telegram 与模型回答受控，realTelegramConnectivityEvaluated/realModelJudgmentEvaluated 均为 false。原始目录见 telegram.json，包括 telegram-mobile.png。首次检查仅在缺少匹配 Playwright 浏览器处停止；使用本机已安装浏览器后该定向检查通过，早期证据保留。

Telegram 传输错误仅写渠道状态并等待，不影响桌面控制循环；已有 webhook 显示冲突，不自动删除。`/stop` 使用实际取消入口，不能把“请求停止”立即展示为停止完成。群聊、其他发送人、过期口令、旧配对代和过期参数按钮被拒绝。

已发出的网络请求可能在解除配对后到达；撤销阻止旧代继续派发与作答，不承诺撤回外部消息。通知显示短摘要和认证网页链接，暂不发送截图/文件附件；需要输入秘密时使用网页与后续保险箱流程。未知通知在设置页显式授权重发可能产生重复。

本次迁移前已保存本工程 PostgreSQL 16 自定义格式备份并解析归档清单，文件位于忽略目录 data/backups。宿主 pg_dump 15 与服务器 16 不匹配，改用该 PostgreSQL 16 容器自带工具；原 PG15 服务保持原样。此记录不代替 P7 的完整恢复演练。

## 逐次费用与月预算（2026-10-25 / 0.5.0-dev）

0008 新增 task_model_attempts 并回填旧决定尝试；旧重试时间未知的记录标 legacy，不伪造准确时间。模型费用列改为 bigint，保留价格快照、用量、未知费用与独立人工核对值。getTask 的未知费用字段改为 unknown_cost_attempts，明确按请求尝试计数。

月预算配置与实际调用准入共享短事务锁。启用预算时付费请求串行；已达上限、无定价或本月未知费用会暂停，没有发生新的付费请求。一次在途请求仍可能超过剩余额度，本地模型继续运行。月度到期以 calendar 身份自动重新检查，仍受当前费用条件限制。

验证：4 个金额/日期/渲染单元检查；runtime-usage.json 的 7 组受控检查通过；runtime-recovery.json 定向回归通过。重放已有回答不新增尝试；未知重试保留旧记录。用量历史分页使用明确插入的 53 条样本，没有把它们当真实调用。真实模型规划和实际服务商账单仍未评估。

首次 usage 检查在等待月底自动重查时，由验收辅助函数把 pending 请求直接判成失败；改用明确的期限恢复检查后通过。视觉检查发现原生 progress 控件的绿色会误导预算耗尽状态，改用显式红色进度与暂停说明，新增渲染断言；生产页面另用拦截响应验证警示样式，未改动主库预算。

升级前已有任务全部终止，PostgreSQL 16 自定义格式备份已保存并解析清单；原数据库与其他项目保持原样。生产构建、拥有者费用 API/手机界面与授权边界见 preview.json。趋势图、按 Agent 汇总、时区例程、真实账单与整体 上游项目 对照继续推进。

费用明细时间显式使用拥有者时区与固定中文 locale，避免浏览器所在时区或语言改变月界日期；跨 en-US/纽约浏览器的生产渲染与服务端断言一致。该复核使用拦截数据，主库预算/单价/费用保持原值。

## 例程本轮实现（2026-10-25 / 0009）

新增计划字段与冻结运行记录，保留上游五种计划和交互。一个 DBOS 30 秒调度器在 worker 内扫描业务游标；任务仍通过既有 submitTask 同事务入队，工作站忙时保留队列。计划编辑、启停和归档按版本核对；既有运行输入不变。每次运行独立对话，历史链接原任务。

PostgreSQL 实测台北与纽约 DST：缺失时间顺延、重复时间取后一次；自然周固定含首尾日期与 UTC 区间，纽约回拨周为 169 小时。间隔小时保留绝对时刻锚点。latest 只补末次，skip 超过 60 秒跳过；较旧触发合并登记，不逐条灌入旧任务。

runtime-routines.json 的 7 组检查通过，包含真实 DBOS 定时触发、Task 提交后运行回执前精确阻塞/强制退出、原键恢复、一度繁忙的一次性计划排队及归档不删任务、实际手机/桌面配置与认证边界。受控模型回答，realModelJudgmentEvaluated=false。首次失败来自测试读取公开 DTO 中刻意省略的时区字段，改查数据库快照；第二次发现 select 标签计算包含 option 文本，增加明确 aria-label 后通过。早期证据保留。

来源为 44 copied、31 adapted、1 excluded。新复用 schedule、routines 和 routines-view 的计划/配置/历史语义；旧 Web setInterval 与 startTurn 不注册。文档源与工程镜像已更新，设计稿 1.6。

保留边界：新建计划请求级去重、历史分页/自动刷新、完整合同编辑、可信周期比较与条件通知继续完善；旧 SQLite 数据导入未实现。约 30 秒心跳会积累框架记录，长期容量与清理策略列入 P7。计划回执冻结在 Task 受理之前，Agent 模型/记忆在 Task 受理时冻结。

预迁移备份：data/backups/pre-routines-0009-1792885483.dump，权限 600，PostgreSQL 16 归档清单已解析。这不替代完整恢复演练。生产迁移/预览状态以本节后续记录为准，前文 0008 记录保留其历史时间。

0009 已应用到本工程主库，源与运行 worker 保持 0.5.0-dev。新 Web 6797 / worker 6798 已定向启动，生产构建、拥有者例程 API/手机/桌面页面与退出授权通过，见 preview.json。主库仍只有 5 个已完成实验任务、0 条例程，月预算 null、已知费用 0；无真实模型/Telegram 配置。启动的 personal-agent-routines 计划为 ACTIVE。初次生产预览使用了与配置 localhost 不同的 127.0.0.1 Origin，被正确拒绝；改用配置 APP_URL，未放宽认证。

最终 runtime-routines 定向复核通过，截图中的网页运行已显示完成；runtime-recovery 定向回归通过，模型回答保存/未知计费等待语义保持。未运行无关全量验收。通过实验的临时数据库与工作站已清理，早期失败数据库与原始文件保留。下一条纵向流程是受信任的跨期报表比较和条件通知，继续保持整体目标进行中。

## 跨期报表与条件通知（2026-10-25 / 0.6.0-dev）

在原 CSV 合同上增加 comparison，例程冻结本期及基期两周日期。Agent 下载/合并，worker 读取宿主已提取字节，用 BigInt 六位固定点求和并核对阈值/方向，保存两个成果 ID、程序依据和通知决定。阈值含边界，零差额不命中；百分比零基期需要核对，缺数据或非法数值不能静默完成。

复用原 CSV parser/字段日期检查、成果授权、完成事务和 Telegram outbox；新增纯计算模块和结果展示。来源仍为 44 copied、31 adapted、1 excluded，没有增加框架或服务。任务完成、comparison 和 notification 同事务保存；仅 completed/send=false 静默，问题、复核、失败和取消保持原渠道。

实际实验发现并修正根因：人工确认等待时重启，旧模型 epoch 导致已确认完成再次变成 stale。现在只有同一完成动作对应的持久化 resolved/complete 审批能重新取得当前控制用于收尾，复用该动作的宿主成果；旧 GUI 授权继续失效。测试同时修改 guest 原文件并强制退出，要求原成果/合计保留且不重新生成模型回答。

早期报告检查的 fixture 网站在 Shell 冷隔离后被正确结束；把测试基础设施启动移到生产运行器取得工作站之后，未改弱隔离规则。另一次网页检查在登录 POST 未完成时直接导航，定位为验收脚本时序，已增加明确登录完成条件。失败记录保留原始目录。

当前程序范围是单列合计与明确阈值；网站源数据真实/完整、重复业务行、币种/单位与文字事实仍需核对。它提供具体可验证的周期任务闭环，不把条件通知推广为任意业务规则引擎。

TypeScript、production build 与金额/CSV/渲染相关定向单元检查通过。drizzle-kit 核对没有 SQL 变化，数据库迁移仍为 0009。预升级排空主库 5 个已完成任务，未发现活跃旧工作流；PostgreSQL 16 备份 data/backups/pre-reports-0.6-1792886886.dump 已保存并解析归档清单。

源与运行 worker 已为 0.6.0-dev，Web 6797 / worker 6798 已启动；生产规则编辑器、手机/桌面界面、非法阈值和退出授权通过，见 preview.json。主库未创建或执行新例程，既有拥有者尚未配置真实 Agent/provider。受控报告集成与回归的最终结果见后续记录与原始 evidence。

最终 runtime-reports.json 的 5 组检查通过：4 个实际 DBOS 定时任务、16 次源文件浏览器下载和 guest 合并，宿主比较不受矛盾摘要影响；缺基期被拒绝后修正、零基期确认等待重启、guest 原文件被修改但宿主成果仍保持、真实取消、outbox 静默/正常投递与实际网页配置全部覆盖。受控 Bot API 收到 3 条完成、1 条取消和 1 条人工处理通知；等值任务未产生发送尝试。

raw：data/experiments/agent_runtime_892c5a073f9b4e76827d0cc67a185cf6。controlledProvider=true、realModelJudgmentEvaluated=false；Bot API 与网站也受控，不能据此评价真实模型适配或真实 Telegram 连通性。设计稿 1.7 的 13 份源文档与镜像同步，P5 中真实来源核对、完整费用视图和真实账单仍未完成。

本轮 runtime-recovery 定向回归通过，已保存回答复用、未知可能计费请求需授权和过期 GUI 决定仍有效拒绝；未运行无关全量套件。最终文档/镜像/来源及格式检查通过。主库预算/价格/费用保持原值，成功的临时工作站与数据库已清理，早期失败证据保留。下一阶段继续迁移保险箱和明确授权的凭据填写，同时保持真实模型、真实 Telegram、公网部署和 上游项目 对照为独立验收项。

## 设计包补全与合理性复核（2026-10-25 / 设计稿 1.8）

独立设计目录与 docs/design 镜像现有 14 份文档。新增凭据与授权设计（F14/T18）：安全表单同事务保存密文/引用回复、精确 origin 与单次现场绑定、敏感参数不落普通动作日志、一次性消费和未知填写复核。明确通用 guest Shell 下，秘密进入浏览器后可被站点和 guest 代码接触；遮罩不构成对模型代码的凭据隔离。保险箱仍未实现，当前运行版本继续为 0.6.0-dev、数据库止于 0009。

实施与验收增加保留功能门槛、六条真实模型配对任务和六个故障/部署案例，规定输入条件、人工介入、已知/未知费用、失败记录与建议受限 Beta 门槛。新增 P7 的 guest→数据库/控制面/宿主等网络负向检查。以上均为计划，本轮没有真实模型、上游项目 对照或云部署通过结果。

文档定向校验通过：14 份文档共 2897 行、30 个本地链接/片段、编号定义、代码块/JSON、来源统计和镜像一致性；Prettier 格式检查通过。记录为 docs/evidence/design-documents.json。初次校验器遗漏中文冒号，修正匹配规则后通过，未因此改动产品。修复了概览中的旧复用统计、重复节号和落后于例程/比较实现的描述。本轮仅更新文档，无运行代码、数据库或服务变更，未重复执行应用全量测试；整体超过参考项目的目标继续进行。

## 凭据 S1/S2：加密存储与安全提供（2026-10-25 / 0.7.0-dev）

选择性复用固定 上游项目 的五种条目校验/字段/品牌与提示、保险箱表单、列表和请求意图。新增 5 条 adapted 来源记录，现为 44 copied、36 adapted、1 excluded；没有新增依赖或服务。AES-GCM 增加 v2 的安装/行/类型上下文绑定，原 provider/Telegram/工作站连接 v1 密文保持兼容。

0010 增加 origin/revision/Task 范围/期限/消费字段。设置页提供加密保存、完整重填替换和删除；所有查询只返回白名单元数据。API 保留上游短字符串 ID，新的表单生成 UUID 请求键。模型 vault_list 只列永久脱敏条目；request_secret 等待认证网页安全提供/选择。条目、引用决定和 DBOS 唤醒同事务，普通答复不能携密批准。Telegram 指向网页，仅有拒绝/取消按钮。

临时条目和 code 绑定 Task、十分钟有效；leased worker 既有维护批次清理过期、已消费或已终止任务的临时条目，保留非秘密审计引用。删除后的旧表单重放不能复活条目。实际自动填写、使用消费及 guest 敏感派发未实现；工具、网页和文档均明确继续接管登录。不能把本轮数据字段或 UI 当作 S3—S5 已完成。

5 项相关单元检查、TypeScript 与完整 production build 通过。runtime-vault.json 的 6 组受控检查通过：真实设置/手机 UI、五类存储、重复/版本/站点与 Origin、普通批准拒绝、实际 DBOS 等待 SIGKILL 恢复、已有条目选择、OTP 表单事务触发器失败回滚、相同请求重试/冲突、期限清理与防复活、取消、退出授权，以及全部 public/DBOS 表、模型请求和日志的样本值检查。raw：data/experiments/agent_runtime_bd2ffe5e36e04318ab61313d8c495722。受控 provider，realModelJudgmentEvaluated=false；没有真实模型、Telegram 网络或 guest 填密结果。

第一次定向检查发现上游表单错误缺少 role=alert，事务回滚已按预期发生，UI 验收因找不到错误区域超时；修正可访问性后通过。失败库与 raw agent_runtime_84407483b8da48619c0eb0fcb3897e71 保留。另补等待 PostgreSQL 后端连接实际归零再删临时库，消除了连接尚在结束时强制删库的竞态日志；没有吞掉错误。runtime-recovery 的 3 组定向回归通过，raw agent_runtime_64e9231530514170a7cdd00feef90652。未重复无关全量应用验收。

主库核对为五个已完成实验任务、零活跃任务/旧 Task 工作流；只停止本工程原 Web/worker。PG16 备份 data/backups/pre-vault-0010-1792889772.dump，权限 600，归档目录已解析。应用 0010 后启动 0.7.0-dev Web 6797 / worker 6798，health 已确认。未修改主密钥、安装标识或模型配置。

preview-vault.json 的实际生产预览通过：手机/桌面设置 UI、短 ID 条目创建/替换/删除、匿名与退出授权；测试条目已清理。主库继续为五个已完成任务、零例程、零保险箱条目，未配置真实模型或 bot。已实际查看手机截图，无横向溢出。新功能仍属于开发版，Linux 云部署和同条件 上游项目 对照继续独立验收。

设计稿 1.9 的 14 份源文档与镜像按实际 S1/S2 状态更新。下一条纵向流程是 S3/S4 的单次现场授权、瞬时批量 DOM 填写和指定中断复核；支付请求及整体替代范围继续保持未完成，目标进行中。

## 设计交付与开发接力校核（2026-10-25 / 设计稿 1.10）

本轮按独立文件夹、开发准则、AGENTS.md/agent.md、详细设计、分流程、迁移与合理性审查的要求，继续完善既有 personal-agent-design 目录及 docs/design 镜像，共 14 份文档。没有新增另一套设计目录或覆盖在建实现。

核实当前源码的 APPLICATION_VERSION 已为 0.8.0-dev，0011 增加 secret_released_at，工作站目标镜像 0.2.0/controller 协议 2；worker/vault、敏感动作分支和审批 UI 已有在建代码。最后验收基线继续为 0.7.0-dev/0010。test:runtime:vaultfill 有入口、受控模型分支和网站夹具，尚缺实际 vaultfill 集成案例块；不能运行通用分支后将退出成功登记为填写通过。

新增凭据设计第 13 节的接力点、九组案例、派发标记含义和完成顺序；迁移说明增加待执行的 0.8.0-dev 作业单，显式核对环境镜像覆盖、现有容器重建、主密钥与版本配对。README 和两套 Agent 指令分别登记验收/源码/升级状态。没有应用 0011、修改运行配置、重启服务或调用真实模型；本轮未执行应用测试。

合理性审查继续保留现有技术栈，并调整实施顺序：在建填写定向验收后，提前推进稳定版本的 Linux 私有部署、guest 网络负向检查与完整备份恢复。费用趋势、记忆增强和交接界面不阻塞部署演练；公网开放、保留功能与同条件 上游项目 对照门槛保持。整体超过参考项目的目标仍在进行。

文档定向检查覆盖链接/片段、编号、JSON/代码块、14 份镜像字节一致与来源记录；copied 文件和固定参考逐字节核对，excluded 文件按预期缺席。检查结果记录在 docs/evidence/design-documents.json，不将文档通过计为填写、云部署或真实产品对照通过。

## 凭据 S3/S4：一次授权的实际填写与恢复（2026-10-25 / 0.8.0-dev）

已接通 login/code 的 vault_fill。复用现有 Task/request/control/action、DOM locator 和 Docker stdin，在原工具动作上保存精确站点/条目 revision/页面/观察/epoch/boot/字段描述/期限的 grant；批准与实际释放分别核对。0011 的 secret_released_at 在发送前保存，临时条目同时消费；明文仅经调用内存和 transient 进入 guest，普通 input/params、DBOS、事件和安全回执不含值。

guest 批量预检查后逐字段重查，变化/导航/超时保留安全 attempted/filled；CSS 遮罩减少显示，原始 Playwright fill 异常不转发。已有 host/guest 回执可复用，条目已删除不再次解密；已标记但无回执转复核，仅继续/取消。旧批准重启后不可刷新 epoch，填写后不自动截屏；登录由后续 DOM 与网站结果独立核对。S5 身份/支付请求仍未完成。

runtime-vaultfill.json 通过 13 个实际 DBOS 任务（12 明确完成、1 实际取消），带数量门槛：账号双字段、专用验证码表单→引用→批准→单次输入、字段描述/过期/版本/错站拒绝、批准等待 SIGKILL/重新授权、guest 回执后 host 提交前、host 回执后框架检查点前、实际效果后回执丢失、部分/超时、取消后 Docker 容器停止/移除和取消日志卷。独立网站输入匹配/遮罩/提交计数，public/DBOS 表、模型、guest journal、controller/Web/worker 日志样本值检查全部通过。

原始最终目录 data/experiments/agent_runtime_fd2369d6193943f08f277ff26682018e；配套镜像 personal-agent-workstation:0.2.0，ID 441e717eefd1。6 项相关单元、类型与 controller 语法检查、生产构建通过。S1/S2 的六组定向回归通过（agent_runtime_6b98280154c2452a889443fd1f45d2c1），配套镜像下模型恢复三组回归通过（agent_runtime_439df96948ea4cdca91c036c5d30070d）。未重复无关全量套件。

首次填写检查 agent_runtime_b59724d9e9ec4ea7bf5da2d1e9fdcc48 的普通账号已通过，OTP 夹具漏接安全提供后的自动观察而等待超时；补齐受控模型分支后通过，未改弱产品链路。另一轮旧 0.1.0 镜像恢复检查 agent_runtime_850a29ff36554725a1dc2ce8011887c8 在首个模型前遇到 Private control relay did not become reachable，按预期停止并隔离；使用候选配套 0.2.0 的回归通过，原失败数据库/日志保留。中继失败底层原因尚未定位，没有增加超时或声称已经根因修复，列入部署可达性核对。

升级前主库五个已完成实验任务、零活跃 Task/任务工作流；只停止本项目旧服务。PostgreSQL 16 备份 data/backups/pre-vaultfill-0011-1792893896953.dump，权限 600，归档清单已解析。此次为数据库备份，完整成果/profile/密钥恢复演练仍待 P7。应用 0011（累计 12 条业务迁移）并将本项目 WORKSTATION_IMAGE 从 0.1.0 明确改为 0.2.0，未变更主密钥、安装标识或模型配置；主库没有需要重建的业务工作站。

Web 6797 / worker 6798 已运行 0.8.0-dev，health 与实际列已确认。preview-vaultfill.json 通过拥有者生产设置/API、手机/桌面截图、样本创建/替换/删除与退出授权；主库继续五个已完成任务、零例程、零保险箱条目。生产预览没有创建模型任务，实际填写证据来自隔离工作站；受控 provider/网站不证明真实模型判断或真实站点能力。

设计稿 1.11 与 14 份镜像按实际 S1—S4 更新，来源仍为 44 copied、36 adapted、1 excluded，无新增依赖或框架。下一条纵向流程是 Linux 私有部署、guest 网络负向检查和完整备份恢复；S5、剩余保留功能、真实模型/Telegram 与同条件 上游项目 对照继续验收，整体目标保持进行中。

最终文档/来源/格式检查通过。控制器最后仅有格式变化，与已测镜像经现有 esbuild 生成的规范化 JavaScript 一致，证据为 data/experiments/vaultfill-source-image-equivalence.json；没有为格式变化重跑全量应用验收。当前 Web/worker health 正常，隔离测试端口与成功实验工作站已清理，其他项目容器保持运行。

## P7 准备：桌面内部通道与生产升级（2026-10-25 / 0.8.1-dev）

复用现有 Docker CLI、拥有者 WebSocket/票据/epoch、只读 sidecar 和 noVNC。网关用固定内联 Node relay 经 docker exec stdin/stdout 传输容器 loopback 的 RFB 字节：watch 5900 / control 5901。guest/viewer 不发布桌面端口，viewer network=none；worker 无需因为桌面而接入 guest 网络。双向背压、二进制帧边界、stdin EOF 清理与有界 stderr 已实现。未新增依赖、服务、SQL 或镜像协议。

已有旧发布端口的 guest 或网络不符的 viewer 会在启动前明确拒绝，排空后显式冷重建并保留 home/profile。迁移说明提供顺序；本机原为零工作站，本轮只重启本项目服务，没有删除业务容器、主库数据或其他项目资源。运行应用为 0.8.1-dev / 0011，镜像 0.2.0 不变。

定向证据：

- docker-stream.json：四项实际 Docker 检查，一 MiB 二进制往返、非零退出不被 stdout EOF 掩盖、远端 relay/本地 CLI 清理和缺失容器。raw pa-stream-4b33974b-a30e-4a9a-b9c0-db010e3d1cff。
- desktop-transport.json：六项拥有者/真实工作站检查：零发布端口、viewer 无网络、只读、人工控制/按键释放/旧连接票据、三次重连清理/文本帧拒绝、退出登录、旧配置拒绝/显式重建。raw agent_control_682002930074417594516d9b89be945f；早期五项通过目录也保留。
- desktop.json：真实 noVNC 画面像素、接管/交还、手机无横向溢出与实际取消，raw agent_control_995d8671c7c2474682ff2cb05052d3af；手机截图已查看。
- runtime-recovery.json：0.8.1-dev 配套三组恢复回归通过，raw agent_runtime_4fc29c2272ea406a8ac36b12640f0cfd。受控模型，真实规划/费用仍未评估。
- 类型与 production build 通过，构建日志 desktop-stdio-production-build.log。preview-desktop-stdio.json 验证当前 health、拥有者生产设置/API、手机/桌面与退出授权；主库仍为五个已完成实验任务、零活跃任务，未创建主库模型任务。

初次流实验用 Duplex.from 直接 destroy 产生 AbortError；改为标准 Duplex 明确正常关闭语义。测试 docker top 需要 PID 列，改为 pid,args；原错误/复盘保留，没有放宽断言。首次生产预览误把侧栏链接文字当作页面标题而超时，改用实际 h1“模型与 Agent”后通过，未修改产品页面或认证。未重复无关全量应用验收。

新路径移除了 Colima 宿主发布端口依赖；旧次 Private control relay did not become reachable 的 Colima 内部原因仍未定位。零发布端口/只读 viewer 已证明，guest 到数据库、worker、宿主、其他工作站和云元数据的出站负向限制尚未验收。下一项是 Linux Compose/HTTPS 与该网络边界，再进行完整备份恢复；P7 和整体产品目标继续进行。

用户已确认真实模型使用已有云端 API、验收费用不设上限。实际工程配置检查含设置库与支持的环境来源：configuredProviders=[]、defaultModel=null；只等待本地设置页配置，不读取其他工程凭据。未知可能计费请求与未知外部效果仍按单次复核规则处理，授权不改变这两项边界。

设计稿 1.12 已更新迁移、控制流程、精确交接与合理性审查，14 份源文档与镜像保持一致。来源继续为 44 copied、36 adapted、1 excluded；原 MIT 署名保持。

## P7 Linux 部署候选与失败诊断（2026-10-25 / 0.9.0-dev）

新增 Node 24 多阶段 Web/worker 镜像、PostgreSQL/Web/worker/Caddy Compose、独立 600 权限配置生成和专用 Linux guest 网络策略。复用固定 上游项目 的 Dockerfile/Compose 多阶段依赖处理、named data、兄弟工作站和回环入口约定；来源为 44 copied、38 adapted、1 excluded。tsx 保持原锁定版本并移入生产依赖，没有新顶层框架或既有包版本变化；锁文件补齐六项既有 Tailwind WASM 分支的 dev/optional 嵌套记录。

网络采用安装专属 bridge、INPUT/DOCKER-USER 首部规则，限制内部/保留/元数据和控制入口，同时核对 DNAT 后目标及原目标。工作站去掉 CAP_NET_RAW、禁用 IPv6、指定公共 DNS，viewer 继续无网络。只支持专用 rootful Linux + iptables/bridge netfilter + 单安装/直连 IPv4；worker 启动及工作站准备时核对实际规则，活跃 guest 时拒绝 init。尚无持续防御可信 root 篡改规则的保证。

当前主 Docker 宿主缺少 bridge netfilter，首次 DinD 实验明确失败；没有在共享宿主启用模块。随后建立独立 Colima VM（自己的内核、2 CPU/3 GiB/16 GiB，仅挂实验目录），只在专用 VM 启用模块。默认 context 始终为 colima；其他项目和本机主服务没有改动。

两次应用镜像构建/类型检查及配置生成的两项单元通过。候选实际镜像 Web c93f295e6cc3、worker 24e774915a70，工作站仍为 441e717eefd1；SQL 仍为 0011。镜像包含的第三方清单需要在下次构建带入最新文档，完整发布许可审核仍缺失。

最近部署原始目录：data/experiments/pa-linux-1792898258832/attempt-1792900868801。三组检查通过：

1. 缺少策略时失败，安装专属 bridge/规则初始化及 live check 成功。
2. 生产容器迁移、拥有者一次初始化/重复拒绝、HTTPS CA 校验、认证设置页、私有 DB/Web/worker 与只有 worker 的 socket 权限。
3. 受控模型驱动真实浏览器和可见 noVNC，人工 RFB 登录；human 等待时 SIGKILL/restart worker，新的 WSS 连接/只读和 SSE 继续；只下载一次，宿主交付四行/日期字段符合合同、金额合计 620 的 CSV。

随后实际 guest 负向探测循环执行到普通公网 HTTPS，但整套失败。原始 result.json 与 docs/evidence/deployment-private-attempt.json 保留 passed=false，后者补充定位范围；没有 deployment-private.json 通过报告。

根因与修正记录：xt_conntrack 的单地址 /32 原生输出不含掩码；Docker capability 使用 CAP_NET_RAW 规范名；跨 bridge 回复被 Docker isolation 丢弃，实际计数后增加 scoped established reply。测试另修正后台 aria-hidden 状态等待和 worker DB epoch 已更新但 HTTP 尚未监听的竞态。实际 502 日志曾暴露短期票据 header，Caddy encoder 已删除 Sec-WebSocket-Protocol，受控故障请求验证样本票据不再出现在日志。

当前公网失败已定位：Docker stub 及直接询问 1.1.1.1、8.8.8.8、9.9.9.9 均返回 example.com=198.18.1.34；启用规则后保留范围 DROP 为 15 包。显式 DoH 的 TLS 请求可以完成。VM 重启尚未重建规则时的普通请求也可达，那些文件仅作无规则诊断。保持保留地址阻断，不把无规则或 DoH-only 诊断替代普通应用网络门槛。

测试已增加逐端点/DNS 文件、fake-IP 的明确失败提示，以及关闭桌面弹窗/等待“已完成”后再截手机图；这批测试记录调整尚未跑完整流程，不能把旧手机截图当成完成状态的界面证据。最后类型检查通过；前提未变化时不再重复整套已知失败尝试。

专用 VM 已停止并保留失败数据库/卷/日志。本机主服务 health 继续 0.8.1-dev，主库 provider/default-model 记录、活跃任务及工作站均为零。用户已有云 API/无花费上限的授权已登记，仍只在本地设置页接入；没有真实模型调用费用或其他工程凭据读取。

下一步：F12 一致备份/干净恢复与直连 DNS 环境部署放行；活跃规则篡改生命周期、容量、实际 VPS/ACME/真实服务和同条件 上游项目 对照均未完成。设计稿 1.13、迁移、合理性审查、开发准则/交接与部署说明按上述边界更新，P7 和整体目标保持进行中。

## F12 完整恢复与 Shell 中断根因修正（2026-10-25 / 设计稿 1.14）

受控源准备实际生成外部提交中断、模型回复未收两个未知任务。初次运行发现 SIGTERM Shell 终端回执被 host 当作成功，导致第二次模型规划；原失败 `pa-linux-1792898258832/attempt-1792903280202` 保留。`lib/action-receipts.ts` 与动作两个回执入口修正后，原任务外部提交/模型请求各一次，另一模型调用一次，均等待复核；旧 host 缓存中断结果也受检查。普通非零退出保留语义。证据 shell-interruption.json。

新增离线 `scripts/snapshot.mjs` 与部署备份说明：停写核对，format-2 全库/成果/所有 home/固定镜像，独立密钥文件，文件/清单认证与拒绝覆盖。数据包 9 文件、6 home、5 镜像、3,041,186,806 字节；源有 5 Task、10 动作尝试、14 模型尝试。认证不加密敏感内容，存储介质需要保护；早期 format 1 原包保留，当前 CLI 仅支持 format 2。

在另一台真正空的 Linux ARM Docker 引擎导入包内镜像、单事务恢复 PG 和文件，再围栏旧会话/桌面票据/epoch，暂停例程并撤销 Telegram 代。首次 CLI 导入成功，测试因成果相对路径读取失败；修正测试后使用匹配回执在同目标继续 validate，全部通过，未重做约 3 GB 导入。原失败、导入和通过记录同时保留。

核对原四行合计 620 成果/下载、记忆/密文/home、拒绝旧会话/延长票据/样本 grant；启动应用后两个未知任务无新增模型或动作。新生产任务通过 3 次受控模型请求使用恢复的已登录浏览器；目标受控外部服务零新增 POST。手机复核截图已实际查看。Cookie 预置、grant 样本、延长票据、重建外部夹具均明示，恢复后完整填密未重验。证据 restore.json。

源目录 `data/experiments/pa-linux-1792898258832/attempt-1792903681417`，完整包 snapshot-full；初次导入 `pa-linux-1792903976167/attempt-1792903998168`，通过核对 `attempt-1792904201499`。私有检查点/密钥含实验凭据，禁止输出。两台 VM 已停止并保留，默认 context 未改。受验 worker/Web 为 `182dc2e2d4d2` / `600afb5d58dd`，guest 不变；主服务仍 0.8.1-dev/0011，未升级。

检查：action-receipts 1 项、snapshot 2 项、runtime-recovery 3 组与类型检查通过。没有新 SQL/依赖/来源迁入，仍 44 copied、38 adapted、1 excluded。设计包/镜像更新到 1.14。下一项继续网络策略生命周期、容量和直连 DNS；普通公网、实际 VPS/ACME、跨架构、真实模型及整体 上游项目 对照继续未验。F12 分项通过，P7 与产品整体目标仍进行中。

## P7 网络策略定向续验（2026-10-25 / 0.9.0-dev）

新增 `test:network`，只在显式指定的保留恢复目标进行，不重复整套部署或已知 fake-IP 公网检查。十个端点逐一有宿主真实可达的正向对照：PG、Web、worker、宿主网关、宿主发布端口 DNAT、实际 peer 工作站、169.254.169.254、100.100.100.200、168.63.129.16 与控制公网别名。guest 全部拒绝，另一个受控公网服务可达；网络/DNS/IPv6/能力/零发布端口/无 Docker socket 和秘密环境、viewer network=none 一并核对。

三种篡改分别为删掉出站规则、改变 DOCKER-USER 顺序、改变 INPUT 顺序。每种 check 与生产工作站创建均失败，第三个 guest 未生成；缺少出站规则时实际 worker 启动同样失败。排空并显式重建后重新启动工作站，home 标记保留；最后新建 guest 成功。原 Task/动作/模型数量保持 6/12/17，没有新增调用或计费。

首尝试 `pa-linux-1792903976167/attempt-1792905630400` 在夹具创建时因与已有恢复网络重叠失败，未执行端点检查；修正测试复用原离线夹具网络的未用地址。续验 `attempt-1792905740639` 的 5 组检查通过，network-probes.json 保留所有正负结果，规则/拒绝回执/日志保留。证据 network-lifecycle.json；原失败也保留。此次只改定向验收入口和文档，无生产网络规则或依赖变动，来源数量不变。

最终停止 Compose 与专用 VM，恢复源也继续离线，主服务与默认 context 不变。该结论限定受控 Linux 规则与启动/创建卡点；宿主 root 后续改规则不会被持续监控，实际 VPS 元数据、普通公网 DNS、容量和整体对照仍另验。不会把此分项通过写成 deployment-private.json 或整体替代完成。

## P7 短程容量与已完成桌面按需停机（2026-10-25 / 设计稿 1.15）

新增 test:capacity，复用生产镜像/worker、原模型与报表夹具和专用 Linux 主机 helper。2 vCPU / 配置 3 GiB、单 guest 1 CPU/1536 MiB 的基线完成 8 个实际报表任务、56 次受控模型调用、8 次下载，全部四行合计 620，任务结束关闭报表页。最后空闲 30 秒 guest/viewer 展示内存 901.6/31.93 MiB，数据库从 10,206,231 增至 12,033,047 字节；完整测量口径与限制见 deploy/RESOURCES.md。该结果支持先按需停机，不预先增加 worker 或替换虚拟化。

借鉴固定 上游项目 的 15 分钟与 stop/home 约定。候选增加 WORKSTATION_IDLE_MINUTES（0—1440，默认 15，0 禁用），worker 的独立维护循环每约 30 秒检查：idle、无 activeTask/desiredMode、超过阈值；取得原生命周期锁后重查，并拒绝存在任何未终止 Task 的 Agent。实际停止 viewer/guest 后推进 epoch/清除 bootId，保留容器/系统层/home；下一 Task 继续原 ensure/acquire。guest 自行 idle watcher 保持 0。停止错误沿用 fail-stop，普通任务/控制扫描与维护分开。

test:capacity:idle 在新隔离安装完成 9 个实际任务、63 次受控模型调用与 8 个资源样本。禁用分支在不可达数据库下返回空列表；human/quarantined/handoff/reserved/queued/waiting_user/needs_review 七种资格状态以 SQL 合成，未当成实际人工流程。真实 leased-worker 定时器在第八个任务后停止桌面，观测等待约 77 秒，epoch32→33、bootId=null，容器仍在；第九个实际任务自动唤醒并交付 620，home 标记保留，最终只有一个空白页。

原始基线 `pa-linux-1792903976167/attempt-1792906944635`，闲置验收 `attempt-1792907342959`。三次早期基线失败均在任务前：`attempt-1792906654465` 入口就绪未等转发，`attempt-1792906794678` 保留子网冲突，`attempt-1792906847606` Docker host/none 空 IPAM。分别修正外部就绪等待、选择未用子网/独立夹具名、网络元数据空配置处理；失败未删除。两次成功共 17 个实际任务，未重复整套部署/应用验收。

生产 worker 构建/类型检查、部署配置 2 项定向检查与两组容量实验通过。受验 worker `54af95cddc0d`，Web `600afb5d58dd`、guest `441e717eefd1`；应用协议仍 0.9.0-dev、SQL0011/guest2 不变，没有新依赖，来源仍 44 copied/38 adapted/1 excluded。主服务0.8.1-dev未升级，默认 context 未变，两台 VM 与新夹具/安装均已停止并保留。

模型为固定回答、每次人为延时500ms；网站登录旁路、本地测试CA忽略、单工作站和合成状态均单列。实际 provider 配置按 model.default、provider.*.apiKey 与运行时 registry 重新核对，当前仍为零/无可解析默认模型；未产生用户云 API 费用。真实登录在闲置后保持、真实人工等待长时间边界、长期容量/磁盘保留、普通公网/实际VPS、剩余功能与 上游项目 同条件对照继续未验，整体目标保持进行中。

## S5-A 身份资料填写（2026-10-25 / 0.10.0-dev候选）

在原vault_fill的字段/批次/审批卡片上扩展identity；九个保存字段及派生完整地址，最多十个不同目标。复用精确origin/页面/观察/Task/action/revision/epoch/boot/期限的grant、瞬时stdin与原动作回执。空字段在释放事务内明确拒绝并回滚，零输入/零消费；已知回执不重解密，部分/未知输入继续原复核。input/textarea主frame受支持，select/iframe及卡片/UPI继续接管。无新框架、依赖或SQL，来源44copied/38adapted/1excluded。

应用0.10.0-dev与工作站0.3.0/guest3配对。创建标签与真实health均核对，实际guest2携新标签会被拒绝。旧guest需排空后显式重建，保留home/profile；不在等待人类或在途任务中自动替换。主服务继续0.8.1-dev/0011/guest2，没有改.env或执行主库升级；原F12/网络/容量镜像仍固定原版本。

runtime-identity.json：原始agent_runtime_9f81f6a3f31f468f984446ad049f97aa，10个实际任务全部明确结束。十字段/1210字符textarea地址、手机安全提供并明确取消永久保存、单独批准/消费/清理、缺字段/拒绝/类型/select/card/UPI负向、导航部分输入及worker SIGKILL/回执丢失复核均通过；没有自动表单提交。已知回执在删除条目后可复用。手机与桌面批准截图已查看，无横向溢出。

原账号/验证码13任务按新镜像回归通过（12明确结束、1实际取消），原始agent_runtime_83c9184bdd504261bd61dc20a18d1825。两个套件均检查真实旧镜像health拒绝；该探针没有额外业务任务。所有public/DBOS表、模型请求、guest journal与Web/worker/controller日志的专用样本值检查通过。最新runtime-vaultfill.json另存runtime-vaultfill-0.10.0.json，原guest2报告保存为runtime-vaultfill-0.8.0.json，未改写旧证据为新版本。

五项vault单元、两项部署配置、类型与生产构建通过。镜像guestfdccff8575be、workeraf4bff1c91b5、Web4e558c792da2；89个runtime源文件及5个controller文件与镜像字节一致，生产锁810/3项版本匹配源码（prune会改锁元数据）。Next构建时占位数据库不可达的认证schema警告保留，构建成功；实际集成使用隔离真实PG。宿主Web实际界面及Node worker/guest有证据，新生产镜像的Linux Compose/云运行未因此放行。未重复无关整套应用、网络、恢复或资源测试。

前四次失败目录保留：agent_runtime_da2bf13c1b624fafa1d5e3ccc8fbe8f7未指定现有浏览器路径；c6df1787ede84919a379f7b75372b47d将202误写200；ba14d5f934074f5299b5c0a30eb64d69未取消资料表单默认永久保存；7b73d78a0fb94194b05da3b5344e7f2c把拒绝决定误期待成重放错误。后面三项同为agent_runtime_前缀。修正仅涉及测试配置/断言，未放宽程序门槛。源镜像比较最初请求了runtime不携带的UI源目录，并误将prune后锁要求字节相等；改按实际打包内容与精确版本核对，失败原因另记s5-identity-source-image.json。

设计稿1.16与14份镜像同步，迁移作业单和合理性审查增加身份纵向流程。S5仍缺card/UPI、支付请求、金额/商户来源、拒绝与真实接管；下一批沿原持久化request和敏感派发链补齐。真实模型/网站/Telegram、普通公网、实际VPS及整体上游项目比较继续未验。已有云API/无预算上限的授权保留，本地provider/default model仍待配置。

## S5-B 支付准备与慢DOM期限修正（2026-10-25 / 0.11.0-dev）

配套工作站0.4.0/协议4、SQL0011，来源44 copied/40 adapted/1 excluded；复用上游支付卡片/支付选择逻辑和本工程保险箱/请求/控制/回执，无新依赖或业务迁移。新增专用拥有者选择接口，普通responder/Telegram不能批准付款方式。选择不提交付款，另需精确本动作的字段批准。

| 受控检查       | 实际结果与证据                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 支付准备15任务 | 14完成、1实际取消。card六字段、UPI、临时card；网页选择/字段批准、API认证/Origin/版本/引用门槛；重复/不符输入；金额在前/等待/首字段后变化；revision/期限/跨Task；拒绝/实际取消；真实takeover事务回滚、SIGKILL等待恢复/交还；丢失回执未知复核。runtime-payments-0.11.0.json |
| guest4原13任务 | 保留原login/code实际案例/数量门槛，12完成、1实际取消；runtime-vaultfill-0.11.0.json。guest2/guest3原报告保留，身份10未在本轮重跑                                                                                                                                          |
| 慢DOM期限1任务 | 原校验在独立读取之前，且now()固定事务开始时刻；实际1.5秒读跨期限后释放1次、填6字段。移到读取后/解密前用clock_timestamp()，同案例变为零释放/派发/输入/提交；runtime-paymentdeadline.json                                                                                   |
| 单元/构建      | payment3、vault5、config2、类型和生产构建通过；期限修正后重新运行payment3/类型/构建，未重复无关套件                                                                                                                                                                       |

15任务基线与原13回归在期限修正前通过；额外1任务验证最终期限修正，明确保留前后时间顺序。实际集成使用本机隔离Node worker/Next Web/数据库和真实Docker guest；生产镜像构建/源码对应不代替0.11的Linux/云运行验收。最终worker/Web为354dab7e8783/3610d3103ead，guest为f296de7ae730；源码比较与最新主服务只读快照见payment-preparation.json。

host重读原文后校验并解密，guest在批次/每字段前核对付款文本；支付单次消费派生自原secret_released_at账本。已知回执直接复用；未知/部分填写仍仅继续或取消。CVV/PIN不存储，iframe/select等转人工。有效期界定释放/派发授权，不承诺已放行动作在截止毫秒完成每字段。

桌面/手机选择与精确批准截图已查看。完整PAN/持有人/UPI样本未在public/DBOS、模型、guest journal及进程日志意外持久化；有效期/尾号按产品定义披露。原15任务报告末尾错误沿用了storage/provisioning范围文字，原文件保留；实际案例块、逐任务guest归档和前一条结果包括填写检查，后续入口已修正标签，不为标签改动重跑15任务。

审计保留两个失败：首次仪器错误覆盖首个读取时间，原始agent_runtime_080634d191f44bc3b88b3b225bb79fa9；有效旧行为复现agent_runtime_5297a71ab93e4445bd555cbfe0e3f276。修正后agent_runtime_8dc89170de6e49cc82b1473a7ec76ccd通过，观察在断言前保存。早先deadline入口配置的类型检查失败日志也保留，不能记作产品缺陷。

合理性：共用原事务/回执而不增加第二个执行框架；代价为方式选择与字段批准两次人工确认。页面/读取器同属可修改guest，重读仅证明与当前文本一致，不保证商户身份、收款人或防恶意Shell。自动付款提交数为0，人工接管的1次明确模拟提交单列。S5-C提交批准/未知效果/结果证据、真实模型/网站/Telegram、实际VPS与同条件上游项目对照继续未验。主服务保持0.8.1-dev/guest2、五个已完成任务与零工作站；云API/无费用上限授权保持，provider/default model待本地配置。

## S5-C 最终付款提交与页面证据（2026-10-25 / 0.12.0-dev，部分验收）

沿原Task/request/action/DBOS/控制链接入payment_submit和只读payment_result。最终请求在完整填写回执后生成，实际新观察的商户金额/按钮描述冻结；专用拥有者网页批准，通用回复/Telegram不能批准。guest最终复查后点击一次。新增SQL0012仅加dispatch_started_at，原secret标记含义不变。没有新依赖，来源44/40/1。

| 实际检查          | 结果与边界                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原九任务尝试前8项 | 7完成、1实际取消；最终UI确认/一次六字段匹配提交/页面证据、删除条目后历史回执、API门槛/跨Task/跨动作复用拒绝、明确拒绝、改价/换按钮、过期与实际慢DOM跨期、等待重启旧epoch拒绝、guest已知回执在host提交前SIGKILL恢复；原始agent_runtime_eb7f34102dd044769f3e604cf0b03dc9                             |
| 第9项原尝试       | 效果发生后，验收SELECT dispatch_id因连接两表而歧义，中止；整次passed=false。新查询明确a.dispatch_id，没有修改产品逻辑或删除该门槛                                                                                                                                                                  |
| 最后单项恢复      | `npm run test:runtime:payment-submit -- lost-receipt`单任务通过：实际效果一次、guest回执删除/SIGKILL、unknown仅继续/取消、继续后新页面证据；标记与提交数仍1。runtime-paymentsubmit-recovery.json明确focusedLostReceiptOnly=true、整套标志false，原始agent_runtime_078534415b624f18a786a3514c0952b7 |
| 首次失败          | agent_runtime_c5e8e806d69b479abf3d238eaf585c9f第二任务等待人类时被测试直接调用新动作，WorkspacePaused正确拦截。改为Task锁下核对跨Task准备引用，未放宽执行边界                                                                                                                                      |
| 相关单元与构建    | payment4、vault5、config2、类型、guest语法与Web/worker生产构建通过。最终镜像worker313b02d4ac5f/Web4c97e8d75c22/guest24fd2a5471bd；96个runtime源文件、5个controller与810/3锁版本一致，4个可选锁条目由prune移除                                                                                      |

“8+1分项证据”与整条九任务命令分别记录，后者没有通过。原第二次尝试共启动9任务，第9在清理前未完成；补验另启动1任务，没有把失败任务从历史抹除。支付场景均为无财务后果夹具，没有真实扣款/银行核销；API与AI SDK真实执行，模型回答受控。手机/桌面最终确认和结果截图已视觉核对；页面结果由宿主保存并独立显示，page_text_only不认证可修改guest或商户账单。

准备方式/字段/最终提交合计三次确认。marker后未发出也会转未知复核，这是防重复的人工成本，尚需专门实际断点验收。S5-C仍缺UPI最终提交、无完整填写、结果缺失/不符、跨站/iframe/特殊控件及完整命令。原15支付准备与原13账号/验证码在guest5的受影响回归均通过，结果如下；旧guest2/guest3/guest4与原F12/网络/资源报告保留版本。

生产镜像构建不代替0.12的Linux/云运行或整体上游项目对照。当前主库仍0011，主服务0.8.1-dev/guest2、五个完成任务与零工作站，provider/defaultModel仍未配置；用户已有云API/无费用上限授权保持。

### guest5 原链路回归与收尾

runtime-payments-0.12.0.json：15实际任务（14完成1取消），原始agent_runtime_f9620a9b39e646759df4098ef534f0e4；runtime-vaultfill-0.12.0.json：原13任务（12完成1取消），原始agent_runtime_cac77b128dbe4ebb9eb108f52e14d356。两条数量门槛、单次消费/已知与未知回执/实际取消保持；没有重跑未受本次影响的identity10、网络/容量/全应用套件。

对保留的第二次失败库补做只读审计：44张public/DBOS表、26个日志与7份guest归档，检查固定PAN和holder/UPI的UUID样本族；没有重建终止进程中的精确值列表，也没有补出已取消guest的归档。每个模型请求的精确样本检查在运行时执行，最后单项恢复有完整精确值/guest/进程检查。范围见s5-submit-partial-secret-audit.json；不将其写成原九任务命令通过。当时聚合已归档为payment-submission-1.18.json，保留passed=false与分项/整套区别；当前续验结论见下一节。

## S5-C受控机制验收收尾（2026-10-25 / 0.12.0-dev / 设计稿1.19）

完整九任务命令已在独立库通过：8完成、1实际取消，原始`agent_runtime_31d2b8126a084c369176f745dc6c995e`，报告`runtime-paymentsubmit.json`；原9任务门槛保留。额外`-- edges`独立11任务全部完成，原始`agent_runtime_d54f0a82ab7341cfb714394600556f49`，报告`runtime-paymentsubmit-edges.json`。两套合计20个实际Task，使用受控模型/网站，无真实扣款；最初两次失败与后续单任务补验均保留。

本轮新增11场景的验收代码，复用原submit/approval/site/controller/finish/DBOS链：UPI仅id输入并精确匹配；无完整填写拒绝真实提交工具；跨站form/role-button div/iframe在实际DOM改变后拒绝；marker已提交但尚未发送的SIGKILL窗口；host检查后按钮变化由guest拒绝；结果来源缺失、金额/商户不符均无成功证据；host业务回执已提交、框架检查点前SIGKILL后复用。具体外部计数和断点见设计凭据16.3。

新增tests/fixtures/docker-gate.mjs只改变edges worker的PATH，在原生Docker启动前暂停指定Task/动作；不保存stdin、没有生产hook或guest helper改动。marker-before-send先核对已提交marker1/guest无回执/网站提交0，杀掉进程组并核对代理死亡，重启前解除断点，继续后仍marker/attempt各1、零点击/结果。它实证三次确认之外的人工核对成本。

edges11均完成、归档11份guest记录；原完整9有8完成1实际取消、完成任务归档8份，取消发生在填密之后、付款提交之前；已取消guest未包含在这8份归档中。模型每个请求、全部public/DBOS表及相关Web/worker与guest日志精确样本检查通过。最新完整命令的手机页面证据截图已实际查看；原最终确认/桌面检查保留。TypeScript、两个fixture语法与受影响格式检查通过；参数误拼/错focus在创建数据库前拒绝。最初typecheck发现Next扩展的ProcessEnv要求NODE_ENV，worker局部环境覆盖改为Record<string,string>后通过。

候选生产运行逻辑/SQL/guest协议/lockfile/依赖/镜像本轮均未变，源码对应仍为worker313b02d4ac5f/Web4c97e8d75c22/guest24fd2a5471bd、96runtime+5controller；没有重复生产构建或原15/13/身份/网络/容量等无关套件。来源保持44 copied/40 adapted/1 excluded。payment-submission.json现在只对受控机制passed=true，1.18部分聚合归档且原失败不改，completeS5Verified/真实模型/真实付款/独立核销保持false。

主服务仍0.8.1-dev/SQL0011/guest2；0.12/SQL0012/guest5只作为受控验收候选。真实模型/网站、财务服务与外部核销、候选Linux/云部署、剩余保留功能和同条件上游项目对照继续验收，S5/T18整体不标完成。用户已有云API/无费用上限授权保持，配置只通过本地设置。本次只读核对主库仍5个completed Task、0工作站、12条业务迁移、0已配置provider且无默认模型；记录s5-submit-gates-final-state.json。用户服务/预算授权已记录，继续等本地设置接入密钥，无需再次询问。成功的两套临时数据库/工作站已清理，原始证据与失败现场保留。下一步推进剩余保留能力与已配置后的真实服务、候选部署及同条件对照，整体目标保持active。

## F07顺序交接实现与受控验收（2026-10-25 / 0.13.0-dev / 设计稿1.20）

0.13.0-dev/SQL0013已实现F07顺序交接，继续配工作站0.5.0/guest5。原11实际Task受控命令通过（9完成2取消），包含两个真实目标占用任务与原对话追问。delegate保留固定上游项目的agentId/brief与接手剩余任务语义，新增list_agents和最多8个20MB常规文件声明；新执行仍共用单worker/原DBOS队列，不启动子Agent运行器。当前只允许拥有者本轮明确名单中的Agent接手，默认禁用；原squad面板另验。

沿原Task/segment/DBOS/控制/成果链实现，新增worker/delegation.ts和共享lib/agent/snapshot.ts。原受理的模型/记忆选择逻辑移入共享函数，初始段与后续段均保存snapshot。SQL0013仅增加该JSON列并回填旧段/设非空；主库未应用。原delegate字段与接手语义来自固定上游项目；来源44/40/1，无新依赖/guest协议/工作站镜像。

源文件先沿collectArtifacts提取宿主、prepared事件冻结配置/说明/文件与最近20条问答；releaseWorkspace停止源输入并释放；同事务更新当前Agent/段、保存新snapshot和目标分区入队/事件。目标按自己的队列获得控制，将宿主副本复制并逐字节核对到Transfers新路径，重新观察。原Task的完成条件、成本和步骤总量不重置；Task.agentId随执行者改变，conversationAgentId保持原对话入口，当前桌面与下一条原对话分别处理。

`npm run test:runtime:handoff`第一版完整11任务通过，原始agent_runtime_739c2f31fb0a467988eebc0315846dde：目标真实占用/排队、冻结后修改源文件/目标设置与记忆、真实owner问答、相同工作站、无效目标/provider/缺文件、释放后提交前和业务提交后框架检查点前SIGKILL、预算停在目标首个模型前、队列取消不影响另一实际任务、释放后取消不创建新段、旧段动作/记忆/请求/响应拒绝、同批后续工具不执行，以及实际手机/桌面和原对话追问。9完成2取消，成功的临时库/工作站已清理，原始证据保留。手机截图显示交接卡片，原对话列表当时仍在读取，不把该截图说成全部内容渲染完成。

迁移检查在独立PG库创建相关旧表形状，实际执行未改写0013SQL，一条已有段的配置/记忆/上下文/时区精确回填，非空约束拒绝缺snapshot插入；范围见handoff-migration.json，未作完整主安装升级。4个相关单元与类型检查通过；最初类型检查发现SSR/乐观Summary漏加conversationAgentId及测试联合类型读取，补齐所有调用方后通过。

首次恢复回归误继承主.env的旧0.2镜像，实际protocol-5卡点拒绝，模型尝试0，原agent_runtime_2230d87449864753a262ea1e24fe8640/失败日志保留。共享runtime夹具现在统一钉住配套0.5.0，负向旧协议用例仍显式切换；主配置不改。新报告从源码/迁移清单读取版本，原历史报告不修改。配套恢复回归与生产构建的最终结果见后续记录。

主服务仍0.8.1-dev/SQL0011/guest2，未应用0012/0013或修改原配置/拥有者。真实模型/服务、0.13 Linux/云部署、长期容量与同条件上游项目对照继续验收，整体目标保持进行中。云API/无费用上限授权保持，密钥只通过本地设置接入。本批未验证Shell冷交接/大文件/长链、原squad面板/渠道及例程名单入口和真实模型，P6与T16保留范围继续推进。

权限复核：第一轮11任务通过后，将安装全局可见范围收紧为TaskInput.delegateAgentIds（可选最多32个，省略即禁用）。模型发现/执行按owner本轮名单核对，受理校验目标存在/非fixture；当前段及后续段均不能扩大名单。网页提示数据会进入目标provider，受理后清空选择。原11报告归档runtime-handoff-unscoped.json，收紧前构建8e68df49b497未部署；名单收紧后的11任务和最终配对镜像另存，不能沿用旧结果声称新边界已验。

0.13原模型恢复3组与原记忆2任务回归通过（原始agent_runtime_188b67b23eee457ca3eac16f29ba84b6 / agent_runtime_74e45a1543f0436da9d9c110e45ba7f3），发生在名单收紧前；名单字段省略的原路径不变，不将它们描述成收紧后重跑。配套恢复报告保留首次旧镜像失败，无重复当前已通过的支付/网络/容量全套。最终记录见下节。

### F07最终名单版与构建记录（1.20收尾）

最终 `runtime-handoff.json` 对应 `agent_runtime_c905a426a1fa4d6d9cffe66e3d828117`，保留原11任务门槛，9完成2实际取消。已实测名单外发现/执行拒绝、网页POST携带本轮名单及受理后清空；手机图等原对话完整渲染后重拍并检查。第一版 `runtime-handoff-unscoped.json` 与其较早手机图单列历史。当前Telegram和例程尚无名单入口，缺省禁用交接；原squad配置/成员面板继续迁移。

名单收紧后5个相关单元、类型检查通过，worker/Web生产镜像分别为 `27e5d357c177` / `1a69c5045924`，工作站仍 `24fd2a5471bd`。100份源码/分发文件与镜像直接字节一致（其中68份TS/mjs），810项root lock与340项installed lock版本核对，6份controller文件全部匹配。此前恢复3组/记忆2Task通过发生于名单收紧前，保持实际顺序；原支付0.12、网络/容量基线没有重跑。构建/字节匹配不替代生产容器运行套件或新候选云部署。

聚合见工程 `docs/evidence/handoff.json`，源码对应见 `data/experiments/handoff-source-image.json`。只读主状态 `handoff-main-state.json`：Web登录200、worker0.8.1-dev、主库12条/0011、5个完成任务、零工作站/配置provider、默认模型未解析，成功实验库已清理；未应用0012/0013，未改配置/拥有者/运行服务。云API及无费用上限授权继续有效，密钥只在本地设置配置。

## 例程名单受控子项（2026-10-25 / 0.14.0-dev / 设计稿1.21）

新增SQL0014在原例程表保存owner名单（默认[]/最多32个），原编辑器可勾选、回填/显示。Task受理的原校验抽到lib/agent/roster.ts，计划保存共用；freezeRoutine只对非空列表加原Task字段。已触发快照、重复请求键及空名单省略语义保持，编辑/启停只影响未来。执行共用F07/原DBOS/队列，没有第二运行时、新依赖或guest变更；来源44/40/1。

`test:runtime:routine-handoff`完整3实际Task全部完成：两个无文件的2段交接，一个空名单越界实际拒绝后在原段完成；初次受理冻结后UI编辑、启停与旧版本重复请求，真实DBOS一次性计时采用新名单，源/目标发现范围相同，手机/桌面表单/历史/401/403/400与Schema边界检查通过。原始agent_runtime_cb035034d1cc43f2b269e8e4f126eb88，runtime-routinehandoff.json。0014原SQL的默认/非空在隔离schema窄检查通过；完整主安装升级另验。

首轮ee27f9a8bb274cd1a98b4c16e54a01f6失败保留：provider夹具假定初始工具历史为空，实际初始化截图已存在。改成按工具名找list_agents后重跑完整3任务通过，生产runtime没有新增hook。5个相关单元和类型通过；原11交接/支付/网络/容量没有重跑，不能改贴0.14回归标签。截图已经实看，补充“相关问答”披露文字在截图之后，交互逻辑未变。构建/源码配对最终记录见下节。

主服务仍0.8.1-dev/SQL0011/guest2，未应用0012—0014、未修改已有配置/拥有者/服务。Telegram名单入口、原squad界面、规则/流程复用、完整费用视图、真实模型/服务、候选部署/普通公网/实际VPS和同条件产品对照继续推进，整体目标保持进行中。云API/无费用上限授权保持，密钥只通过本地设置，不再重复询问服务或预算。

### 0.14构建与收尾记录

worker/Web镜像 `495a4f5f2660` / `eaabbf371c94` 构建通过，工作站仍 `24fd2a5471bd`。直接字节核对103份源码/分发文件（69份TS/mjs）、6份controller；root lock810项与实际安装340项版本匹配。没有把构建/源文件一致写成生产容器运行套件或新Linux/云部署通过，聚合为 `docs/evidence/routine-delegation.json`。

只读 `routine-roster-main-state.json`：主Web登录200、worker0.8.1-dev、12条迁移/0011、5完成Task、0工作站、0provider/无默认模型；成功的3任务实验库已删除，首次失败库及原始证据保留。未改主配置/拥有者/服务，0012—0014未应用。真实云API/无费用上限已授权，当前仍待本工程本地配置，不搜索其他工程凭据。下一项继续Telegram名单/原squad及剩余产品能力；整体目标保持进行中。

## 手机名单子项与原渠道回归（2026-10-25 / 0.15.0-dev / 设计稿1.22）

SQL0015只在telegram_connection加默认空JSON名单，owner保存按generation/默认Agent复核。原收件第一事务冻结非空delegateAgentIds，空名单保持省略；/use或网页选源、rotate/unpair/Token和bot身份改变清空，/new保留。草稿按源/代绑定，普通状态轮询不覆盖同上下文编辑。沿原Task/F07/DBOS，无新执行器/依赖/guest协议，来源44/40/1。

`test:telegram:handoff`原始agent_telegram_4a018c440e754de2ba3fa66cae269707：3实际Task全部完成，两个无文件2段交接与一次实际拒绝。PG触发器在Task INSERT前挡住，收件已提交且Task/模型调用为0，SIGKILL后撤断点/改名单/重启，旧消息仍用原名单；新追问保留原thread/入口而用新名单。真实手机/桌面表单、轮询草稿、边界状态码/源代过期/清空与bot变化通过，截图已实看。原SQL默认/非空的隔离最小表检查通过，完整升级另验。

`test:telegram`原8组通过，原始agent_telegram_ccef06e016344f8c96ab85e5e05fc5b8；5Task/4完成1实际取消的明确门槛保持，原收件后Task提交的恢复、问答等待重启/追问、取消、回调、未知发送/429、撤销和原UI通过。合计8Task含原3个Recovery Lab，不冒充8个桌面模型任务；两份报告保留0.15版本，旧telegram报告归档pre-roster。协议夹具钉住guest5，受控模型按ask_user工具名识别阶段，日志写入/连接退出后再清理；本批无已知失败。5相关单元/类型通过，构建/源码配对最终记录见后续。

主服务保持0.8.1-dev/SQL0011/guest2，0012—0015未应用；主配置/拥有者和运行服务未改。原交接11/例程3/支付/网络/容量套件未重跑，保持历史版本。原squad配置/选择/@成员、规则复用、完整费用视图、真实模型/服务/Telegram、实际网络/新候选部署及同条件对照继续推进。云API/无费用上限授权保持，密钥只在本地设置，整体目标继续进行中。

### 0.15构建与最终收尾

worker/Web镜像 `43a258910c98` / `987187734d98` 已构建，工作站继续 `24fd2a5471bd`。105份源码/分发文件（其中69份TS/mjs）、6份controller直接字节匹配；root lock810项、实际installed lock340项精确版本匹配。聚合 `docs/evidence/telegram-delegation.json`；构建/源对应不等于生产容器运行套件或新候选云部署。

主只读 `telegram-roster-main-state.json`：登录200、worker0.8.1-dev、12条迁移/0011、5完成Task、0工作站、0provider/无默认模型。两套成功实验库实际客户端退出后删除，无实验服务/工作站保留；旧失败与原始证据不清除。主配置/拥有者/服务未改，0012—0015未应用。已有云API/无费用上限授权保持，当前仍待本工程本地配置；下一步原squad/具名团队入口和其他保留能力继续推进，整体目标保持进行中。
