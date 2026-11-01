# Development rules

## 2026-10-31：原生控件优先与按需截图（开发版）

native 观察/正常后台动作默认只给新控件状态，guest 不生成图；缺失/不完整、数字 text/value 矛盾、原生回退或前台派发自动附图。模型疑惑/需要视觉验收可主动 screen_capture。pointer_* 必须绑定 screenshot_status=ok 的最新观察，无图 ID/旧 ID 在派发前拒绝；键盘可用当前原生观察。17 项不同定向离线检查及类型/语法/格式通过；隔离 GTK 5 组、14 回执（12 成功/2 预期拒绝）通过，0 云请求/0 业务 Task。源码复制进现有 0.6.5 隔离容器，未构建/部署主预览；2 次 bind 路径准备失败报告保留。容器/匿名卷已删，前后 6 容器/104 卷保持。原 Task/DBOS/未知效果/两图/DOM/noVNC 保持，数值 setter 未修。见 docs/evidence/adaptive-desktop-observation.json 和 docs/CONTEXT.md；勿为状态汇报重跑成功样本。

## 2026-10-31：AT-SPI 模型观察精简（开发版）

context.ts 统一精简 JSON/附图的原生控件投影，去重复树/字段/内部身份及动作说明；保留操作引用、状态和值，优先状态证据及按钮，过大节点跳过后继续收纳，完整原始回执不变。9 项定向离线检查和定向类型检查通过；合成 51 控件同预算保留 10→51、字符 10,137→9,068，状态栏保留。未重跑历史付费任务、未部署、无新增依赖/迁移；数值设置接口缺口尚未修复。见 docs/CONTEXT.md，历史真实对照及费用记录保持原结论。

## 2026-10-30：AT-SPI 与纯视觉真实配对对照已完成

六个隔离 Terra Task，每场景每组一次、每Task最多48请求；137次请求均成功回执、0unknown、137条无价格，费用保持未知。原生优先完整3/3、纯视觉完整2/3；表单、文件字节和字体核心状态两组均正确。纯视觉文件Task达到48次预算后停在父目录未完成收尾，评分needs_review后仅清理取消，原48次请求和失败报告保留；没有重跑刷结果。

混合组实际22次原生派发、25次鼠标键盘输入。表单4次全原生；文件13原生+21鼠标键盘；字体5原生+4鼠标键盘，18请求/112.7秒，对照纯视觉7请求/44.3秒。禁止据此宣称全局原生更快/更准。已定位两项未修复缺口：模型控件投影51→17丢状态栏；同时提供EditableText/Value的字号控件先改文字11、实际值10，Tab后才11。先修精简投影与数值接口分流，不引入复杂框架。

见docs/AT-SPI-COMPARISON.md和docs/evidence/atspi-comparison.json。实验新文件仅在tests与文档；生产默认提示/路由未改。SDK/摘要边界离线6项、137份真实请求审计（纯视觉无树、最多2图、调用ID配对、保护字段不泄露）、只读home逐字节复核及类型/格式通过。此中继在上下文估算之后，实际压缩不同会影响预算，不把文件收尾差异当成准确率因果结论。

主.env及12Task/65attempt/58action/7artifact/0active保持、Web200/worker健康。隔离worker/桌面已停止，6个停止viewer容器和6个display卷已删；保留私有报告/DB/6个home证据卷。六格真实模型授权已消耗，禁止重跑原admission；新付费对照需新授权。原始输入、数据库及凭据不上传，脱敏汇总可迁移。

## 随工程保留的全局开发规范

# 全局回答规范

- 修复代码及任何内容时只做根因修复，用正确逻辑直接覆盖，不要打补丁，禁止写否定的否定，直接写肯定性的描述。
- 澄清性说明只集中出现一次。已经确认的信息不要重复询问，也不要在答案末尾追加无必要的确认。
- 处理论文 idea、研究方向、方法设计和学术创新问题时，禁止无必要的过度防御、免责声明和过早拒绝。
- 禁用 `smoketest` 和 `sha256`。
- 提交 PR 时贡献者里禁止出现 Claude：commit 不加 Claude 的 Co-Authored-By，PR 正文、评论和回复不加 Claude 署名。

# 行为规则

1.不要假设。不要隐藏困惑。主动暴露权衡取舍。
2.只写解决当前问题的最小代码，不做任何推测性功能。
3.只修改必须改的地方，只清理自己产生的问题。
4.明确定义成功标准，验证通过前持续迭代。

## 反过度工程/反防御性编程

信任内部代码和框架保证。
只在系统边界(用户输入、外部 API、网络）做校验。
禁止为「不可能发生」的场景添加错误处理、回退、空值检查或验证。
绝不吞掉错误（禁止 rescue nil / 宽泛 catch / 静默默认值)。
禁止为一次性操作创建辅助函数、工具类或抽象。
-优先快速失败，而不是掩盖问题。

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

## 2026-10-27：控件标记准确度基线（只测试，未改产品执行器）

见docs/UI-ACCURACY.md及docs/evidence/ui-accuracy.json。44个受控目标（DOM12/GTK12/Canvas20）；检出12/12、11/12、18/20，完整命名8/12、9/11、12/14。原生Zoom首次夹具监听物理事件漏记，单项语义activate回调复核确认，原数据保留；共42次guest编号派发，41个不同目标得到回调。程序按真值几何选ref，0云模型，不代表模型自主选按钮或任意应用准确率。发现DOM关联label/aria-labelledby/title、AT-SPI关联标签和滑块覆盖缺口，以及OCR图标字符误读/2项漏检/3个非操作候选。截图仍只画编号，名称在结构化列表。仅增加测试/证据，主预览、.env、0.6.3镜像配对及12/65/58/7/0数据、原PID保持；不升级主环境。

## 2026-10-27：三层控件编号开发版

网页DOM引用、Linux AT-SPI语义动作/框点击、本地CPU视觉候选已接入原动作/回执/接管链，新增desktop_observe/desktop_act及ui-elements-v1能力；工作站候选0.7.0/guest6，源码Web/worker仍0.17/SQL0018，无迁移。详见docs/UI-ELEMENTS.md及docs/evidence/ui-elements.json。直接guest分段11项、独立生产worker一项Task（4本地固定响应/3真实动作/原动作重放）、3新增单元及16原context单元通过；0云模型请求。另一个夹具失败Task保持needs_review及1unknown，失败实验全部保留。标记只绘制截图副本，默认DOM读取不自动截图，当前控制代最多2张图。CPU OCR/边框识别不保证复杂无文字图标；仅Thunar、网页iframe/open-shadow与Canvas验收，真实模型质量/其他软件矩阵未认证。用户明确选择先留开发版：主6797/6798、.env、0.6.3工作站和原12Task/65attempt/58动作/7成果保持，禁止自动升级/重启主预览。新源码默认镜像0.7.0不表示主环境已配对升级。

2026-10-26：桌面优先/浏览器按需启动已部署主预览，工作站0.6.3/guest6，Web与worker仍0.17。见 docs/BROWSER-STARTUP.md 与 docs/evidence/browser-startup.json。冷启动无 Chromium/空白标签，热交接保留页面；空闲冷启动同步boot/epoch。主12任务/65attempt/58动作/7成果保持，0新增模型请求。旧镜像、配置、数据库与home备份保留；不重跑历史完整套件。

2026-10-26：Agent Zero 插件工具桥已接入，见 docs/AGENT-ZERO-COMPATIBILITY.md 和 docs/evidence/agent-zero-plugins.json。复用 settings 保存固定源码包和安装注册表，configSnapshot.agentZeroPlugins 固定版本/普通配置/工具说明；无新 SQL/guest 协议。第三方代码仅 guest 执行，通过原 Shell 动作/回执/复核链，禁止在 Web/worker 宿主导入插件。工具合同为明确子集，UI/hooks/API/Skill 自动发现未接入。原 rg/todo_list 一项生产运行链 Task、5 次本地固定响应、0 云模型已通过，成功样本不重复跑；首次索引数据和 SQL updated_at 失败均发生在创建 Task 前，保留各实验目录。主预览此前已获用户授权升级至 0.17/SQL0018；旧记录的 0.15.1 是历史状态。

最新上下文与记忆v2（2026-10-26）：各SDK工具返回统一有界投影，覆盖JSON/错误/拒绝/混合文本/媒体及provider-executed结果；当前控制代最多保留最近2张有效图。默认总窗口65536，预留8192输出，输入估算达80%且有有效旧段时自动摘要；规则、当前目标/合同及用户补充保留原文。摘要边界和费用复用原决定/attempt表，负数决定对应压缩；新进程复用摘要，unknown仍需原确认，明确上游超限在获准继续后强制先压缩。持久记忆沿用原事务，程序重建变更覆盖层。15项context＋原5项workflow单元、类型/格式和10项隔离账本检查通过；8次本机固定响应、0云模型、0真实桌面。主0.15.1/SQL0015/guest5、PID/env/原Task保持，新源码未打包部署；云端摘要质量、精确token元数据与缓存收益待验。详见工程docs/CONTEXT.md及context-compaction{,-ledger}.json。下方v1及旧验收记录保留其历史范围。

## 2026-10-26：Sol网关根因已定位（只读诊断，未追加模型请求）

本地8917的sub2api原日志已核对到两次失败请求：安全检查均allow；上游404明确报告相同rs_推理记录不存在、store=false时未保存，网关将其包装成502/Upstream request failed。该rs_编号与原成功响应中保存的reasoning itemId精确一致。实际安装SDK默认序列化发送item_reference；离线使用原响应和模拟fetch复现，显式providerOptions.openai.store=false时改为发送完整encrypted reasoning，工具调用/结果仍正确配对，零网络/模型请求。见workflow-sol-gateway-diagnosis.json及workflow-sol-serialization.json。

修复方向为本工程OpenAI Responses无状态历史适配；本轮仅诊断，没有修改runtime/provider、网关配置、运行服务或Task/费用记录，也未实施真实续验。原两次unknown费用和当前needs_review保持，不通过另建Task或继续盲重试绕过复核。该原因只确认Sol这两次续轮失败，Gemini超时仍保持独立结论。下方“网关原因未知”为诊断前历史状态。

## Latest handoff — real Sol switch and single authorized retry (2026-10-26)

User requested openai/gpt-6.1-sol. Read STATUS and workflow-sol-{closeout,attempt,before-authorized-retry,main-state}.json. First real compilation 192d6ff2-fe9b-46a0-8547-e1ee35be77b9 produced34 schema-valid steps with an incidental outside-app human checkpoint; verification09eae96a-6f08-4216-bd9a-281050339f55 was actually cancelled after0desktop actions. It is still verifying, never ready. Preserve workflow-{compilation-sol-first,sol-first-attempt}.json. Clarified compiler instructions distinguish explicit private/human evidence from omitted pointer targets; guards remain unchanged. Second Sol Task f9cb0de4-5ed7-471c-91c7-bc9e978614fa returned31steps but typed /home/agent/ instead of exact allowed /home/agent, so plan was rejected. Its correction attempt and the ONE later explicitly owner-authorized retry both returned Upstream request failed. Current needs_review/draft/null plan,2unknown attempts plus1successful rejected response. Consent consumed; no further API request authorized. Exact typing rule was added to the prompt, not yet live-verified. No provider workaround without evidence.

Sol totals:3Tasks/4attempts/2unknown-unpriced/0desktop actions; known catalog estimate47178microUSD, total unknown. Original Gemini cancelled via original chain; its2unknown attempts and checked source Task/container remained unchanged. tests/workflow-sol.ts supports --resume saved directory and --owner-approved-single-retry DIRECTORY, but retry consent key already consumed. Do not rerun either paid entry point or create a replacement to bypass review. Saved latest directory:data/experiments/agent_compile_89b32692f49640c5b7887bb19091d06f/sol-1792978851395. Three GUI samples+ready reuse remain unpassed; no workflow-sol.json success artifact.5targeted workflow units/typecheck passed. Source/app/SQL/guest unchanged; main0.15.1/16migrations/0active/PIDs/env/settings preserved, experiment jobs/desktops stopped. Updated canonical setup63Tasks/133attempts/108unknown-cost/7unknown-outcome; original10frozen samples separate(total73), original60Task report preserved. FullC4/cloud/上游项目 goal remains incomplete. Earlier handoff entries retain their dated scope.

## 新主线：CUA 流程编译（设计稿1.25，2026-10-26）

Latest correction: original C1 single-retry consent WAS received and used on the SAME Task; attempt2 also timed out after180s. Exactly2unknown/unpriced attempts, original attempt1 unchanged, no plan and no further API request. Read workflow-compilation-authorized-retry.json; earlier awaits-consent entries are historical. Production Chinese input was correct: read-only retained home proved GNU tar C-locale escaping caused the check failure. worker/artifacts.ts now pins tar LC_ALL=C.UTF-8; no guest/input dependency change. Terminal blocked completion now waits for workflow_review rather than looping. workflow-final-review.json proves27 real actions, stable review, Continue without input and actual cancel; first fixture-count failure retained in trials. New production images byte-match both fixes. Four actual production workflow Tasks passed; a post-completion UI timing fixture failed and remains preserved. Only ONE additional active UI Task resumed viewing/security/export/mobile checks against the same installation: composite workflow-production.json is5completed/135actions/0model/0human, original4 unchanged, gates4+1. tests/deployment.ts now observes before completion; tests/workflow-production-ui.ts is the targeted retained-data tail. Do not rerun the four successes. Canonical setup now60Tasks/129attempts/106unknown-cost/5unknown-outcome, original10 checked samples separate(total70); old46Task report unchanged, fullC4Accepted=false. Dedicated VM/jobs stopped; main health/PIDs/env and16migrations unchanged at0.15.1/SQL0015/guest5. Read production{,-ui,-main-state,-secret-scan} and costs-production-closeout. Do not migrate/restart main implicitly or claim real-model quality/full cloud/上游项目 superiority.

C5 is implemented at0.17/SQL0018/workstation0.6.2. Read docs/WORKFLOW-PACKAGES.md and workflow-sharing{,-provenance,-trials,-main-state}.json. Portable export regenerates public names/parameter aliases/labels/examples, strips local identities/evidence/old controls/approvals, and requires parameterized directory names. Import strictly validates the finite package, stores a draft with null local source references and no validated environment, performs no Task/desktop/model work, and never inherits ready/sample success. Same owner/import key is idempotent; changed content409; committed-but-lost response and reload re-review were tested. Independent EMPTY installation/new owner/keys/home performed3GUI verification samples+1ready run(4Tasks/108actions/0model). Same host/architecture/image only. Provenance3 checks are rollback-only synthetic states, not GUI repair trials. Initial missing-browser setup created no Tasks and remains preserved; use existing UI_BROWSER_PATH. Original C2 source and main/env unchanged; all experiment jobs/desktops stopped. Original C1 still1unknown and awaits existing consent question. C4 full matched costs/real-model quality/deployment/上游项目 comparison remain open; do not mark overall goal complete. Earlier C4/SQL0017 entries retain their historical scope.

C4 measurement tooling is implemented without new SQL/guest/dependencies. Read docs/WORKFLOW-BENCHMARK.md and workflow-benchmark{,-protocol,-closeout}.json. CLI freezes10 inputs/3 independent desktops/config/ready plan/environment; fresh manifests also pin provider endpoint. Earlier unpinned manifest is deterministic-only, never use it to admit cloud model arms. workstationChannel=desktop filters model tools and checks runTool/executeAction; records actual image per boot. Ten NEW GUI Tasks passed(270actions/0model), no GUI rerun after the local fixture-parser failure: resume uses same Tasks/receipts. Corrected ordinary-model channel fixture has16 local fixed responses; initial fixture unknown attempt stays accounted. Canonical setup46Tasks/128attempts/105unknown-cost/4unknown-outcome;97 C0calls included, first delivered exploration charged once per strategy. These are collected costs, not savings. Baseline/repair remain0/10, active human/environment costs and unchecked ablation unmeasured, fullC4Accepted=false. Protocol3 checks include2queued-cancelled Tasks(no GUI/API). Main0.15.1/SQL0015 unchanged; original C1 unknown still awaits the already-sent retry-consent question. C5 was subsequently delivered in the latest entry above; true-model/full comparison and deployment gates remain open.

C3 is implemented on the same0.17/SQL0017/workstation0.6.2. Read STATUS and workflow-repair{,-controls,-ui,-certification}.json. allowRepair is explicit/default-off; only an undispatched guarded failure requests one <=6-step candidate through original decide/ledger. Prefixes recover navigation/dialog state, preserve the last intended effect and immutable completion contract. Variant/cursor stay in checkpoint.repair; new inputs use original actions, unknown effects remain blocked. Saved response survives worker recovery only after fresh current-epoch window matching; manual handback/reboot rejects it. Full checked repaired completion saves a new draft, never changes/certifies the ready source; explicit independent verify still needs3 samples. Core7 real Tasks(2complete/5cancelled), controls3 real cancelled Tasks, UI1queued/cancelled Task and synthetic certification4 checks are separate evidence. Responses are local fixtures; no cloud retry. Initial failed recovery/certification fixtures remain preserved. C4/C5, real-model extraction/repair quality, production deployment and matched 上游项目 superiority remain open. Earlier C2 statements below retain their historical scope.

Current source is 0.17.0-dev/SQL0018/workstation0.6.2/guest6; main remains the explicitly approved 0.15.1-dev/guest5. C0 has per-frame observation IDs, native window metadata, explicit coordinate formats, current-epoch latest-image shaping and host directory-tree checking. Read STATUS and desktop-observation.json for exact evidence and retained failed model runs. C1 now has sanitized compilation snapshots, finite plan validation, private version persistence and owner UI. Controlled-provider acceptance is recorded separately from the first real request timeout/unknown cost. C2 now uses the original runtime/actions with finite plans, frozen new-Task parameters, real checks, action/time bounds and exact verified-image certification. Three distinct real GUI samples and ready reuse have passed; candidate generation was controlled-provider, and the cloud compilation still awaits retry consent. Read core/control/certification/UI reports for actual scope. C3—C5 remain open; unverified candidates run only as explicit verification tasks. Never upgrade/restart main implicitly or treat protocol5 images as protocol6. Test old/current image IDs separately; full 上游项目 superiority is unproved.

用户已确认将成功任务沉淀为参数化、可检查、可修订流程。先读 docs/design/CUA流程编译与自动化复用.md 和 docs/design/主会话指导-流程编译.md，按 C0—C5/F15—F17/T19—T22 接入单 Agent 与 P6/F11；多 Agent 继续暂缓。

复用原 runtime/model/actions/Task/DBOS/控制/成果链。跨 Task 复用方法，新 Task 重新执行记账；未知效果先复核。宿主固定解释有限计划，任意生成代码只在 guest 执行。C0 核对坐标/观察和原生任务，C1/C2 跑通后再修订与分享。

侧边会话原始交付仅为设计；主会话现有C1实现状态以STATUS和workflow-compilation证据为准。SQL0016/0017仅在隔离副本应用，主库仍0015。应用/SQL/guest按实际改动分别记录，历史验收保留各自范围。

Read README.md and docs/STATUS.md, then the relevant flow and acceptance ID in docs/design.
The authoritative architecture is in docs/design/详细设计.md; decisions and measured changes
belong in docs/decisions.md. Preserve user changes and upstream license attribution.

Active priority (2026-10-25): deliver one usable CUA agent first. Read docs/BASE-DELIVERY.md.
Defer teams, parallel collaboration and further delegation expansion until B1—B6 acceptance.
Unfinished 0.16 squad work is archived in data/deferred, outside delivery code. Existing 0.15
opt-in delegation stays unchanged/default-empty. Packaging candidate is 0.15.1-dev/SQL0015/guest5;
main was explicitly upgraded by owner authorization to0.15.1-dev/SQL0015/guest5. Never implicitly migrate or restart it.
Two real gateway tasks completed (GPT8 calls/Gemini9), same single agent/workstation; default GPT.
Read docs/QUICKSTART.md and real-models.json. Local preview is running; prior0.8.1/offline/blocking
entries below are historical. Credential was explicitly owner-supplied; use authenticated settings
API/form, encrypted DB storage, no plaintext files/logs. Cloud isolation/VPS/comparison remain open.

- Reuse 上游项目 UI, provider compatibility, desktop, schemas and message formats where practical.
- One npm project, separate Web and worker. Only worker can access Docker.
- Task creation and DBOS enqueue use one PostgreSQL transaction. Business source keys deduplicate requests.
- Separate model decisions from tool actions. Persist only serializable, non-secret data.
- Unknown external effects require reconciliation; arbitrary Shell is never automatically retried.
- Cancellation must stop real operations; desktop viewing is server-enforced read-only in a separate immutable sidecar.
- Shell can modify its guest system layer. Cold containment discards that layer; preserve home/profile and explain the tradeoff.
- A VNC handshake alone is insufficient: UI checks must confirm actual framebuffer content.
- One workspace controller at a time; human handback invalidates previous observations and tickets.
- Verify artifacts outside model-controlled code. Never report model confidence as program verification.
- Persist model intent/result separately; uncertain billed requests require consent before another request.
- Memory mutation and its event receipt commit together; replay must not resurrect a subsequently deleted note.
- Memory snapshots reach the selected model provider; never use notes as a secret vault.
- Accept one active task per conversation under the thread row lock. Snapshot prior goals, outcomes and human responses; old approvals/desktop observations never authorize new actions.
- Telegram runs only in the leased worker. Freeze inbox intent before submitting; advance its cursor only after processing. Bind callbacks to the paired identity, generation, notice and request version.
- Persist outbound send intent. Interrupted or unreceipted sends are unknown and require duplicate-risk consent; only an explicit 429 rejection is automatically retried.
- Journal each actual model attempt with immutable request-time pricing. Historical replay creates no charge; owner reconciliation stays separate and audited.
- Monthly admission and pricing/budget updates share the short transaction lock. A configured cap serializes paid requests; unknown cost is never silently zero. Local requests remain free.
- Routines freeze run input and advance their cursor together, then reuse submitTask with the original source key. One DBOS dispatcher, no Web timers or second Agent executor.
- Calendar schedules use explicit plan time zones; hourly schedules keep their absolute-time anchor. Accepted runs survive plan edits/archival and queue on the same workstation.
- Root-cause fixes, explicit errors, boundary validation, no speculative frameworks or silent fallbacks.
- Run targeted checks for changed behavior; full acceptance at release boundaries.
- Do not delegate or create other chats without explicit user authorization.
- Follow the parent AGENTS.md restrictions on tools, algorithms and attribution.

Report implemented behavior, provenance, exact checks and remaining gaps separately.
Keep docs/STATUS.md accurate; scaffolding and test fixtures do not constitute a usable agent.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

- Report comparison reads host-owned artifacts with fixed-point arithmetic and frozen user rules. Model summaries never authorize notification suppression.
- Complete/send=false suppresses only that completion notice; human requests, failure and cancellation retain their original paths.
- Resolved completion approval is bound to the same completion action and artifacts. Reclaim current control only to finalize/release; never refresh stale GUI authorization.
- Vault provisioning uses only the dedicated owner form: ciphertext, reference response and DBOS wakeup commit together. Generic replies cannot approve a vault_secret request.
- Vault envelopes bind installation, item and kind; existing service envelopes remain compatible. UI/model get masked metadata, never stored fields.
- S1—S4 have controlled-service evidence at application 0.8.0-dev / migration 0011 / workstation 0.2.0. The main services/config are upgraded. S5, real models/services, deployment and overall comparison remain unverified. Ordinary action input and guest params are journaled: never pass plaintext vault values through browser_fill.text.
- Preserve test:runtime:vaultfill's actual cases and thirteen-task count gate; an entry point or generic-suite pass does not verify filling. Follow docs/design/凭据与授权设计.md section 13. Do not refresh stale credential grants; unknown fill reviews allow continue/cancel only. Cached host/guest receipts do not require another decrypt/release; marked unreceipted attempts never automatically resend.
- Bring forward private Linux deployment, guest-network negative checks and full restore rehearsal on a verified baseline. Richer UI/memory work does not block this rehearsal; release and public exposure retain their security and capability gates.

- Application 0.8.1-dev transports desktop bytes via Docker exec stdio: no guest/viewer published ports; viewer network=none. Preserve the readonly sidecar, ticket/epoch revocation and binary/backpressure/EOF semantics. Legacy networking is rejected before start; drain/recreate with home/profile retained. See desktop-transport.json and migration notes. This does not certify guest egress isolation or full P7 deployment.
- Real-model acceptance is authorized for the user's existing cloud API, without a spending cap. The current project has no configured provider/default model. Wait for local settings, never seek another project's credentials or repeat the service/budget questions; unknown billed attempts and unknown external effects still require explicit reconciliation.
- Source 0.9.0-dev adds private Linux Compose/HTTPS and a scoped iptables guest profile; main remains 0.8.1-dev/0011. The deployment attempt is partial/failed, not release evidence. Read deployment-private-attempt.json and deploy/README.md. The local VM's public DNS is intercepted into 198.18/15 fake-IP space, correctly blocked; do not weaken reserved-range rules or replace ordinary-DNS acceptance with a DoH-only diagnostic. Do not rerun the same full attempt without a changed prerequisite. Preserve all raw failures.
- Follow the design package and reuse pinned 上游项目 on uncertainty. F12, scoped network lifecycle and short-run capacity/idle wakeup have passed; continue the unresolved direct-DNS gate, long-running capacity and retained product features/matched comparison. Fixtures and packaging do not complete the product objective.
- F12 now has controlled evidence across two separate Linux ARM VMs (restore.json): format-2 DB/artifacts/six homes/pinned images plus separate keys, auth/ticket/epoch fencing, paused routines and revoked Telegram generation, preserved unknown waits and a fresh cookie-using task. Read deploy/BACKUP.md; public DNS/VPS/ACME and cross-architecture remain unverified. Source and target VMs are stopped with evidence retained; main stays 0.8.1-dev.
- Interrupted Shell results (signal or timedOut) require review at both guest-terminal and cached-host receipt boundaries. A source rehearsal reproduced the old SIGTERM-as-success bug and unwanted second model request; fixed candidate images reduced the external-submit and pending-model calls to one each without automatic regeneration. Do not relax that gate. Ordinary nonzero exits retain their semantics. Scope old-image upgrades by actual image ID and drain old executions.
- network-lifecycle.json has ten live positive/negative endpoint pairs, controlled public allowance and three tamper/drain/reinitialize cases on the retained restored Linux VM; worker startup also rejects missing outbound rules. No task/action/model counts changed. This verifies scoped Linux checks, not ordinary public DNS, actual cloud isolation, continuous root-tamper defense or capacity. The initial test fixture-network overlap failure is retained. Keep the VM stopped when unused.
- capacity-baseline.json and idle-workstations.json cover 8/9 actual controlled tasks. WORKSTATION_IDLE_MINUTES defaults to 15 (0 disables); the leased worker only stops idle/unreserved/no-desired-mode workstations without any nonterminal task, under the existing lifecycle lock. Stop viewer/guest, verify stopped, fence epoch/boot, preserve containers/home; future tasks use original ensure/acquire. Never enable the guest's independent idle timer. Seven eligibility fixtures are synthetic SQL states, not real human end-to-end evidence. Tested idle worker 54af95cddc0d; main remains 0.8.1-dev. Read deploy/RESOURCES.md; no minimum-spec/long-run/cloud conclusion.

- Historical S5-A source is 0.10.0-dev/SQL0011, workstation0.3.0/protocol3. Identity reuses the exact-action sensitive fill with ten fields; missing values reject before release/consumption. Cards/UPI are still rejected. Pair actual health and container labels; old images need explicit drained recreation. Main stays0.8.1-dev/guest2; retained F12/network/capacity snapshots stay pinned. Identity ten-task and original thirteen-task login/code checks passed (controlled provider/site); do not claim all S5 or the product complete.

- Keep runtime-vaultfill-0.8.0.json as the guest2 baseline. Historical guest3 reports are runtime-identity.json and runtime-vaultfill-0.10.0.json. Do not turn the identity sub-slice into complete S5/payment acceptance; UI/worker integrations are isolated host processes plus guest, production images are built but not a new cloud deployment.

- Historical S5-B source is0.11.0-dev/SQL0011, workstation0.4.0/guest4. request_payment_approval captures actual main-frame t text sources, freezes merchant/amount/site/control/method versions and uses a dedicated owner choice endpoint. card/UPI vault_fill requires that single-use choice plus exact-field approval; host rechecks before decrypt and guest before each input. Consumption derives from the existing secret_released_at journal under Task/payment locks. Actual takeover/decision/DBOS send commit together. Fifteen controlled preparation tasks passed; source/guest3 baselines and main0.8.1 remain unchanged. S5-C submission/result verification and overall release remain open; run the affected original13, not unrelated complete suites.

- Sensitive release deadlines use clock_timestamp() after payment DOM I/O and before decryption. Keep payment-deadline's one real task and preserved old-behavior failure;15 payment and13 login/code baselines preceded this narrow fix. Payment selection/fill approval never implies submission. DOM source/controller share the mutable guest; do not promise tamper resistance. See payment-preparation.json/D59-D61. Main and retained0.9 snapshots stay unchanged.

S5-C source0.12.0-dev/SQL0012/workstation0.5.0/guest5 passed controlled mechanism gates: full original9 tasks (8 completed/1 cancelled) plus separate11 edge tasks. Preserve original9/edges11 count gates, both early failed attempts, the focused recovery1 report and payment-submission-1.18.json. Marker-before-send recovery is verified with a host-only test proxy, process-group death and gate removal before restart; unknown submits still allow continue/cancel only and never resend. UPI, no complete fill, three invalid results, cross-site/unsupported/iframe, guest recheck after host marker and host receipt before framework checkpoint all passed. The proxy never journals stdin and applies only to the edges worker PATH; no production hooks, runtime/controller code, lockfile or images changed. See credential16.3/16.4, D65 and payment-submission.json. Existing guest5 preparation15/login13 regressions stay valid; do not rerun unrelated full suites. Main0.8.1/SQL0011/guest2 remains unchanged. Real models/services, new-candidate cloud deployment, retained features and matched 上游项目 comparison remain open; S5/product goal stays active. Existing cloud API/unlimited-spend authorization remains, keys only through local settings.

F07 source0.13.0-dev/SQL0013/guest5 now supports sequential delegate(agentId,brief,files). Original eleven actual tasks passed (nine completed/two cancelled), including real busy targets and original-thread follow-up. Keep the eleven-task gate. Use existing snapshot/collectArtifacts/releaseWorkspace/target DBOS partition; prepared event before release, segment+current task+enqueue+handoff receipt in one transaction. Segment snapshots freeze model/config/memory (never API values); host files transfer to new Transfers paths with byte checks. Old segment mutations/requests are fenced; known receipts remain reusable. All segments share task step/cost budget and original conversation anchor. Delegation is restricted to owner-approved per-task delegateAgentIds (default empty); models cannot expand the roster. Squad UI, Shell handoff/large files/long chains, real models and cloud/comparison remain open. Read F07 implementation/T16/migration0.13/STATUS. Main0.8.1/SQL0011/guest2 unchanged; do not apply new migrations or restart it implicitly. Runtime fixtures must pin protocol5 instead of inheriting old main WORKSTATION_IMAGE. Historical reports retain actual versions; new reports derive current source/migration metadata. Existing cloud API/unlimited-spend authorization stands, keys only local settings.

Source0.14.0-dev/SQL0014 adds an explicit per-routine delegateAgentIds roster (empty by default). Freeze nonempty ids with the existing routine run input; preserve omitted task fields for empty rosters and old request keys. Plan edits/toggles never mutate accepted runs. Reuse assertDelegationRoster at plan save/Task admission and the same F07 worker/queue/segment; no second executor. Three actual controlled tasks passed (two no-file handoffs and one denied delegation), including actual DBOS timed trigger and phone form. Preserve the three-task gate, the initial fixture-history failure and historical0.13 eleven-task report; do not relabel earlier suites as0.14 regressions. Guest stays0.5.0/protocol5; provenance44/40/1. Telegram roster entry/squad UI/real models/new-candidate deployment remain open. Main0.8.1/SQL0011/guest2 unchanged;0012-0014 not applied. Keep existing cloud API/unlimited-spend authorization; configure only locally.

Source0.15.0-dev/SQL0015 adds Telegram owner-approved delegation rosters to the existing connection. API grants bind generation+source agent; inbox first transaction freezes nonempty ids, empty input remains omitted. /use or Web agent selection, rotate/unpair/token/bot-identity changes clear permissions; /new preserves the same source. Already frozen inbox commands retain their roster after edits; revoke their generation or cancel an accepted Task explicitly. Same-context drafts survive polling; server rejects stale source/generation. New3 actual tasks and original8 groups/5 tasks passed (combined7 completed/1 cancelled;3 original Recovery Lab tasks); keep both count gates and historical reports. Tests pin guest5 and identify ask_user by name despite initialization screenshots. Main0.8.1/SQL0011/guest2 unchanged,0012-0015 not applied. Original squad selection/@member, retained features, real services/new deployment/comparison remain open. See model execution21/migration0.15/STATUS. Existing-cloud API/unlimited-spend authorization stays; credentials only in local settings.
