# Agent Zero 完整 Linux AT-SPI 迁移与适配

状态：2026-10-29，固定上游版本的 Linux AT-SPI 功能迁移、现有执行链适配及开发版隔离验收已完成，以下 11 项均有证据。干净工作站与正式 Web/worker 候选镜像已构建并验证。主预览未部署。

## 固定来源与范围

固定对照：a0-connector `3741c8809f1f99b4efee2ed1a24234a98bf896d4`，MIT，Copyright (c) 2026 Agent Zero。来源是 Wayland 后端的 AT-SPI 读写/定位/焦点能力；本项目保留 X11/Xvfb 截图与现有输入/动作账本，完成下表九个规范接口对应功能的迁移。保留许可证和 34 个命名辅助函数的复用记录。

## 必须通过的清单

- [x] 原生窗口枚举、隐藏/屏外过滤、PID/window_id 范围定位与唯一性。
- [x] 有界层级树、节点名称/角色/描述/位置/状态/动作/文本/值，路径与临时索引。
- [x] 索引、路径、语义目标匹配、评分、歧义与缺失反馈。
- [x] 原生 press/focus/set_value，文本/数值接口和显式动作名称。
- [x] background/auto/foreground，明确后台不可用及前台回退；未知效果禁止重发。
- [x] 窗口激活与焦点确认，绑定目标窗口的键盘输入和 submit。
- [x] 上游 @a0 聚焦文本的 context/replace/release、范围核对与保护字段拒绝。
- [x] 当前截图与控件状态统一观察、模型实际请求/上下文裁剪/两图上限；不恢复图片编号。
- [x] 原 Task/DBOS/动作回执、重放、旧观察/接管/取消/重启/未知效果。
- [x] 密码与保护字段、应用控件变化重绑定、多窗口同名歧义、焦点确认。
- [x] 真实 GTK 与应用矩阵、完整 worker 链、干净镜像/依赖/许可证打包。

每项通过依据见下方逐项审计与机器可读清单；历史失败原件保持。主预览 6797/6798、.env 与用户工作站保持，部署须另有明确授权。原未知模型费用/请求不重试。

## 适配原则

复用上游读取、窗口ID、目标匹配/评分、标签解析代码；接入本项目的控制代和一次观察一次输入。D-Bus 对象身份及观察时属性共同核对，禁止仅靠易重绑定的子节点路径派发。原生异常和部分输入必须显式保留；后台操作失败只有在确定未发生输入时才允许前台回退。以原始截图为视觉依据，树内容属于不可信数据。

## 与上游的具体对应

| 上游能力                                | 本项目工具                                                      | 接入方式                                                 |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| list_windows                            | desktop_list_windows                                            | 原生窗口名称、状态、进程号、窗口 ID、过滤与数量限制      |
| get_window_state                        | desktop_get_window_state                                        | 精确窗口或唯一 PID 的有界树与原始截图                    |
| ax_snapshot                             | desktop_ax_snapshot                                             | 指定窗口或整个桌面树；保留应用容器层                     |
| element_action / ax_action              | desktop_element_action / desktop_ax_action                      | index/path/语义匹配；press/focus/set_value；显式动作名称 |
| type                                    | desktop_type                                                    | X11 与 AT-SPI 双重确认当前窗口，保护字段拒绝，支持 Enter |
| tag_context / tag_replace / tag_release | desktop_tag_context / desktop_tag_replace / desktop_tag_release | @a0.profile 行与光标读取、一次性令牌、精确范围替换与释放 |

这是功能迁移，对外保留本项目工具合同。每次原生输入额外要求最新 observationId；窗口及控件还核对 D-Bus 对象身份。上游动作别名/返回 JSON 和 Portal 会话协议没有按字节复制。节点/树上限与上游一致：默认深度5、120节点，显式查询最高深度12、500节点；文本240字符。普通截图的辅助读取使用深度12/500节点，模型上下文再按完整记录裁剪。

## 同为 Linux，差别在哪

上游选定来源是 Wayland connector：Portal 管理桌面授权和输入会话，PipeWire 提供画面，AT-SPI 提供控件信息。这里保留已有 Debian/Xvfb/XFCE 容器桌面，继续用原截图、X11 窗口与输入驱动、noVNC 接管。共享 AT-SPI 原理与大量读取/匹配代码；窗口激活和输入传输按 X11 适配。

本项目额外接到现有 Task→DBOS→action→guest journal→receipt 链：控件索引随观察过期，接管改变控制代，worker 重启复用回执，结果未知进入原复核链。既有安装在0.6.3上时，native tool capability检查会在输入前明确拒绝；不能将源码工具存在理解为旧工作站已经升级。

后台派发不会主动执行窗口激活、坐标或键盘。应用自身仍可能因原生动作改变焦点。auto 对 focus/submit 允许明确的前台回退；控件根本没有原生 Action 时，工具返回 none/background_unavailable，由模型依据最新原图选择现有坐标工具。与上游一样，没有为任意无障碍节点发明万能点击。

## 实际例子：视觉与原生控件如何配合

真实 XFCE Appearance 应用的 Fonts 标签页有 `role=page tab`、名称和位置，未暴露 Action。先调用原生 press 会收到明确无效果回执和新的观察；随后按新观察中 Fonts 的位置调用原有 pointer_click。下一次 AT-SPI 读取确认 Fonts 的 selected 状态。截图没有添加编号，也没有永久坐标回放。

真实 Thunar 的地址框位于较深的树层。曾发生查询深度12能读到，focus 后自动观察退回默认深度5而丢失。根因已修正：动作后观察继承上次查询的范围和预算。完整 worker 恢复测试确认：重启后重新枚举新窗口，focus→set_value /tmp→submit，最终窗口标题和地址框均为 /tmp。

## 证据与当前范围

机器可读清单：`docs/evidence/atspi-migration.json`。原件：`data/experiments/atspi-migration-1793251516845/` 及其列出的独立测试目录。

- 原 observe/actions 两次报告保持失败标记；失败前已经完成的属性读取、后台派发、Unicode与数值赋值检查单独引用。修复后的桌面树、键盘与标签分支分别补验，保留所有原回执。
- safety、edges、tag-guards、journal、offscreen、limits 独立检查覆盖失效观察、歧义/缺失/错误范围、密码、D-Bus路径重绑定、精确回执重放、焦点与提交、文本范围变更、截断等。
- journal 在隔离容器中人为延迟真实原生动作的回执；GTK回调已经发生一次后 quiesce 杀掉助手。原动作保留 unknown，重放和容器冷重启均未重复输入。
- 原两条 worker/Task 链分别完成恢复和取消；本地固定模型共11+5次决策，恢复另含1次本地摘要。最终正式 worker 容器与干净工作站另完成一次恢复 Task，11次决策+1次摘要。控件信息进入实际模型请求，最多两张近期有效图；0云请求，真实模型准确率尚未测量。
- 真实软件覆盖 Thunar、XFCE Appearance、XFCE Terminal，加独立 GTK夹具。终端使用被确认的原生窗口输入并提交，独立文件结果恰好一行。
- 上下文定向单元、类型与语法检查通过；实际 SDK 工具定义与原生结果序列化的3项定向检查通过。正式根 Dockerfile 构建的 Web/worker 镜像完成9个工具/许可证实际导入，Web启动后 /login 返回200，随后停止隔离容器。

最终镜像由 Debian 干净构建完成，再刷新到当前 controller 源码。package、scope-parity、actions、tag、long-type、safety、applications 七个最终专项均通过。镜像内 accessibility.py、atspi_core.py、desktop.mjs、native-schema.mjs 和许可证与当前文件逐字节一致。依赖包括 at-spi2-core / gir1.2-atspi-2.0 2.56.2、python3-pyatspi 2.46.1、python3-gi 3.50.0，Node v24.20.0。历史0.6.5-atspi缓存镜像与其失败/成功记录保持原范围。

原浏览器兼容检查在最终0.6.5上通过：冷启动无 Chromium/about:blank、人工启动打开目标、热交接保留页面、冷重启不恢复空白页、并发打开两个目标及 DOM/截图可用，共5组，0模型请求。

### 最终候选与生产容器 Task

| 产物   | 最终本地镜像                          | 构建短ID     |
| ------ | ------------------------------------- | ------------ |
| 工作站 | owndesk-workstation:0.6.5             | 27dfeeb41697 |
| worker | owndesk-worker:0.17.0-atspi-candidate | 154387cefef5 |
| Web    | owndesk-web:0.17.0-atspi-candidate    | b9ab423c2df8 |

最终 Task：`bb4f2b95-960b-4a1d-955c-6531bf5d8732`，隔离数据库 `agent_native_35ecfdb9a07349a2ad44f5a5aa41491e`。正式 worker 容器重启后 DBOS 恢复1个工作流；重新枚举窗口并通过原生 focus→set_value `/tmp`→submit 完成导航，原有成功回执保持不变。12次本地固定响应全部成功，10条动作记录，0新增unknown。实际Docker事件记录候选worker退出码0；两个worker日志均显示容器内node进程1。实验worker、桌面与独立Web均已停止。

关闭时只读核对全部7个隔离数据库：7个Task、65个模型attempt、54条动作记录；早期失败保留4个unknown。此统计含固定响应夹具失败，不能当作7个成功任务。最终Task数据库与已保存原始回执一致；历史付费unknown未触碰。见 `final-db-audit.json`。

### 11项要求逐项审计

以下文件路径相对项目；完整路径及检查文字保存在 `docs/evidence/atspi-migration.json.requirementAudit`。

| 要求                               | 通过依据                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| 1. 窗口枚举与PID/window范围        | 最终package/scope-parity；edges、window-resolution的直接路径/PID与105应用边界 |
| 2. 层级树与属性/动作/path/index    | 最终package/scope-parity/actions；原desktop-tree与limits                      |
| 3. 三种目标定位与歧义              | 最终scope-parity/actions/safety；edges和offscreen                             |
| 4. press/focus/set_value           | 最终actions及正式worker容器Task                                               |
| 5. background/auto/foreground      | 最终actions；无Action应用明确无效果后使用当前视觉回退                         |
| 6. 窗口确认后键盘输入/提交         | 最终long-type/applications及正式worker容器Task                                |
| 7. 聚焦文本context/replace/release | 最终tag；tag-guards与tag-parity                                               |
| 8. 原图、原生观察与模型上下文      | 最终package、SDK三项检查及正式worker实际请求；最多两张当前图                  |
| 9. 原Task/DBOS/回执/控制链         | 正式worker容器恢复Task、原取消Task、journal故障注入、最终safety               |
| 10. 保护字段与许可证               | 最终safety/package、tag-guards，许可证逐字节核对                              |
| 11. 真实软件/SDK/干净镜像          | 七个最终专项、浏览器五组、正式worker容器Task、正式Web启动200                  |

验收边界：已完成固定上游版本的规范AT-SPI功能及现有X11执行链适配。上游Portal/PipeWire传输、工具别名/逐字节JSON兼容不在迁移范围。AT-SPI可提供的内容取决于应用；自绘控件或缺少Action的节点继续结合截图。真实模型对照、多GUI工具包覆盖、跨宿主云部署属于后续质量/部署评估。

## 主预览和迁移

源码默认候选0.6.5，协议仍6，健康能力为 atspi-native-v1（保留 atspi-observation-v1），无SQL迁移。主 .env继续固定0.6.3，6797/6798没有重启。正式配对升级须保留数据库/home/配置与密钥并另获用户授权；当前保持开发版本。

## 逐项对照后的补充修正

后续对照上游方法体补齐了以下路径，原先的基础检查没有替代这些补验：

- 整桌面快照的索引、路径、唯一语义目标可以推导所属原生窗口，减少一次额外查询；不完整快照仍要求缩小语义搜索范围。
- 文本助手补齐 app_name/window_title/tag_text，保持单个当前令牌，新上下文使旧令牌过期；释放操作幂等返回 released，窗口标题或只读属性变化时拒绝替换。
- 显式 include_hidden 的观察范围传入后续语义搜索。真实隐藏输入框完成了一次原生后台赋值；默认观察仍排除该字段。
- 键盘输入按文本长度分配执行时间，读取树的预算单独约束。900多个字符及中文末尾在真实GTK输入框中精确验证，保留输入前后的焦点确认与取消能力。
- 模型传入空白语义条件、空动作/状态条件、空替换，或 press+submit 组合时，在边界拒绝，避免空查询误命中和错误的提交回执。实际SDK工具定义序列化通过本地fetch捕获，0云请求。
- 按上游解析给定 window_id 并直接读取该路径/PID；操作前无需枚举所有应用。列表移除隐含100应用上限，节点/窗口枚举达到预算时明确标记截断；补齐应用名、可见性和count。真实原生动作与105个合成应用的边界检查均留有证据。
- 原生Action名称读取失败与缺失PID在输入前明确拒绝；控件确实没有Action时继续返回无效果，供模型选择现有坐标工具。故障注入的原生动作读取拒绝回执保留，首次纯测试导入错误另行补尾段，原失败不改为成功。

正式根Dockerfile候选、干净工作站当前源码及配对Task均已通过上述最终验收。原session80750及后续刷新构建已结束，无待运行构建。tests/atspi-native-runtime.ts中的可选ATSPI_WORKER_IMAGE/ATSPI_MODEL_HOST已在最终生产容器Task中实际使用；成功原件直接复用，不重复执行。主预览最后只读检查仍为12Task/65attempt/58动作/7成果/0活跃，原PID与.env时间/大小保持。
