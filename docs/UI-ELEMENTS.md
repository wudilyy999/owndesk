# 三层控件编号（开发版，2026-10-27）

> **已撤回（2026-10-27）**：用户决定放弃截图控件编号。产品代码已恢复截图坐标点击与原网页 DOM 操作，默认工作站恢复 0.6.3。下文完整保留历史实现与实测范围，其中路径、命令及开发状态仅描述当时的实验。相关源码与测试已归档到 `data/deferred/ui-annotations-withdrawn-20261027/source/`，原报告与图像保留；当前撤回证据见 `docs/evidence/ui-annotations-withdrawn.json`。

## 交付状态

工作站候选 `owndesk-workstation:0.7.0`、协议 `6`，新增能力标识 `ui-elements-v1`。Web/worker 源码维持 `0.17.0-dev`，业务迁移维持 `0018`，没有新增数据库表或另一套执行器。

用户选择**先保留为开发版本**。本机 6797/6798 及工作站仍使用原有部署；`.env` 没有修改。源码默认镜像已指向候选版本，现有安装必须显式配对升级后使用。旧工作站调用新增工具会收到明确的“需要升级”结果，既不尝试新动作，也不自动替换机器。

## 三条执行路径

| 场景            | 观察与编号                                                 | 动作                                                                                       | 已验证范围                                                                 |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 普通网页        | `browser_observe({pageId, includeImage:true})`，蓝色 `r0…` | `browser_click` / `browser_fill`，通过 DOM 定位                                            | 按钮、输入框、iframe、开放式 Shadow DOM；禁用/遮挡控件不执行               |
| Linux 原生应用  | `desktop_observe()`，绿色 `a1…`                            | `desktop_act`；AT-SPI Action / EditableText 优先，没有语义点击的可选控件使用已复核的框中心 | Thunar 的 Home 按钮、位置输入框，输入 `/tmp` 后由 Enter 导航并核对窗口标题 |
| 自绘/无语义控件 | 同一个 `desktop_observe()`，棕色 `v1…`                     | `desktop_act` 复核当前画面和框，再点击                                                     | Canvas 绘制的 Launch report 按钮，点击后核对真实页面标题和新截图           |

`r`、`a`、`v` 是不同来源的临时引用，不是软件的永久按钮编号。列表包含来源、名称、角色、边界和支持动作。视觉列表明确使用 `candidate`，普通文字也可能成为候选；模型需要结合截图判断用途。

### 一次实际调用

```text
1. desktop_observe()
   → observationId=<本次UUID>
   → a2: source=atspi, name=Home, actions=[click,double_click], bounds=...
   → 带绿色 a2 的截图
2. desktop_act({observationId:<本次UUID>,ref:"a2",action:"click"})
   → executedElement.method=atspi
   → 下一张标记截图、新 observationId、新控件列表
3. 再使用第1步的 observationId
   → rejected，要求重新观察；不再点击
```

网页的 `includeImage` 默认 `false`，保留原来的纯文本 DOM 读取方式。普通页面需要编号图时显式开启；保险箱填入后/敏感表单上维持 `false`，避免原本只读取 DOM 的调用自动增加一张可能含秘密的截图。`t` 编号仍只用于主框架付款证据，不能作为点击目标。新增桌面引用不授予付款或凭据操作权限，原审批/接管要求保留。

## 原实现中的接入点

```text
模型工具 schema / 系统指令
  → worker/runtime（原决策与上下文）
  → worker/actions（原Task/动作/attempt/回执/unknown复核）
  → guest /actions → 动作日志 → dispatch
     ├─ browser_observe/click/fill → dom.mjs → headed Chromium
     └─ desktop_observe/act → desktop.mjs → ui-elements.py → AT-SPI / OCR / xdotool
```

新增工具没有模型执行回调，仍由 worker 的持久动作链执行。`desktop_observe` 归类为只读；`desktop_act` 归类为效果可能不确定的动作。新增工具加入原 desktop-only 白名单，没有给桌面通道开放 Shell/浏览器接口。原坐标、键盘、接管、动作恢复和完成检查继续使用。

### 工作站依赖

- Debian 包：`python3-pyatspi`、`python3-pil`、`at-spi2-core`、`libatk-adaptor`、Tesseract 及英/简中识别数据。
- 启动时建立同一个 D-Bus 会话并开启 AT-SPI；控制器和它创建的 Python 子进程继承会话环境。
- 视觉检测使用本地 CPU：Pillow 边缘连通区域、Tesseract 稀疏文本及框内批量 OCR。不依赖云端视觉服务/GPU，不把第三方插件载入宿主。
- 最初尝试的 OpenCV 镜像依赖过大，构建已停止，未进入当前 Dockerfile；保留原构建日志。当前增加的软件包安装时报告约 39.6 MB 安装空间，不代表最终压缩镜像增量。

## 引用有效期和效果边界

1. 桌面引用绑定当前 `observationId + epoch + bootId + 窗口几何/身份`，每次输入同步消费一次。没有永久编号缓存。
2. AT-SPI 动作重新遍历活动应用，核对原节点路径、角色/名称、动作、边界，以及目标区域像素。窗口移动、重排或目标变化会拒绝。
3. 视觉动作核对活动窗口画面与目标区域像素。窗口之外的面板时钟不参与活动窗口画面签名；活动窗口内任何变化都要求重新观察。因此动画、闪烁插入光标和视频可能造成保守拒绝。
4. DOM 保存实际节点身份。目标节点更改/替换、滚动、导航、布局变动、禁用或被遮挡时拒绝。与目标无关的文本更新可以继续，防止页面时钟导致所有操作持续失效。iframe 导航、桌面输入、控制权变化也使旧网页观察失效。
5. 输入已产生后，如果新观察失败，回执保留 `executedElement`，单独报告观察失败；不会转坐标重发。语义执行失败也不自动再点一次。
6. 取消/接管复用原进程组停止和 epoch 检查；重启不恢复旧编号。并发请求同一个桌面编号只允许一次执行。
7. 标记绘制在截图副本中。真实 X11/noVNC 桌面保持干净，不在应用 DOM 中插入可见标记层；DOM 的内部引用属性仍用于定位。
8. 模型上下文继续最多保留当前控制代的最近两张图。控件记录使用完整条目、有界裁剪及省略数量，避免数组被截成半条 JSON；不会把压缩前编号当成新授权。

这些是意外误操作防护，不能把可修改的网页或 guest 当成可信安全隔离边界；观察与真实应用动作之间仍存在外部界面变化的时间窗口。

## 验收记录

证据入口：`docs/evidence/ui-elements.json`。所有失败日志、原回执、实验数据库和停止后的实验容器保留。

### 直接工作站验收（分段推进，成功段未重复全量运行）

`tests/ui-elements.ts` 对隔离真实桌面/浏览器调用原 `/actions` 和 `/action-status`，最终进度包含11项：

1. `native`：真实 Thunar 语义点击/填写并实际导航。
2. `native-fences`：移动窗口拒绝、并发消费只执行一次。
3. `dom`：按钮/填写、开放式 Shadow DOM、iframe、禁用过滤与旧引用拒绝。
4. `dom-fences`：桌面输入、控制转交后旧网页引用拒绝。
5. `vision`：DOM 不暴露的 Canvas 按钮由视觉检测并真实点中。
6. `boot-fence`：重启后旧编号拒绝，桌面仍不预先启动空白 Chromium。
7. `dom-invalidation`：替换目标节点、滚动后拒绝。
8. `vision-invalidation`：画面变化后拒绝且目标没有被点击。
9. `dom-mutation-scope`：无关文字变化仍可点击；目标替换/滚动/遮挡拒绝；默认 DOM 观察不含图像。
10. `image-only-overlay`：标记截图与随后真实桌面像素对照，标记不留在实时桌面。
11. `vision-scene-scope`：活动窗口画面签名改动后的变更拒绝检查。

第一阶段有启动命令缺失、测试角色命名、测试网页字符串、观察脚本作用域、截图隐藏光标导致 DOM style 变化、Chromium 的空 AT-SPI 子节点及框内 OCR 等失败，均保留。产品根因在原观察/执行链修复；测试自身问题只改测试。未抹去 unknown 动作回执。

### 生产 worker 链路

`tests/ui-elements-runtime.ts` 在独立数据库/身份/home/真实 guest 中通过原 `submitTask`、worker、模型历史序列化和动作账本运行：

- 成功 Task：`ce1f581a-7fca-4dd9-8b74-d6423ca4022f`。
- 4 次本地固定模型响应，实际执行 `desktop_open_application`、`desktop_observe`、`desktop_act` 各1次，Task 完成。
- 验证桌面通道工具过滤、模型端拿到完整控件记录/图像、最多2张图、AT-SPI 方法回执，以及同一逻辑动作重放直接返回原回执。
- 首次测试夹具把 SDK 文本 part 数组当成普通 metadata，产生独立失败 Task `09a69519-a62b-4dad-a47f-e2bc41457f37`：1成功响应+1 unknown，仍为 `needs_review`。原状态保留，未改成功或清除费用未知记录。
- 合计6次本地固定响应请求（成功实验4次、原失败实验2次），云端模型请求0次。这证明执行机制和集成，不作为真实模型选择编号的成功率指标。

定向单元：3项新检查及16项原 context 检查通过；类型检查、JS/Python语法和改动文件格式检查记录在证据内。没有重复运行无关的全量套件。

## 范围与后续

- 三层编号、动作和原恢复/接管链已接通；复杂无字图标、游戏/视频、自绘曲线控件不保证检出，原坐标/键盘/人工接管可继续使用。
- AT-SPI 测过 Thunar，尚未完成 LibreOffice、Qt/Electron 等软件矩阵；closed Shadow DOM、特殊 iframe CSS 变换和极端覆盖关系未认证。
- 扫描有控件数/节点数/输出/时间上限；视觉候选可能是普通文字。识别覆盖率、误检率、真实模型端准确率/耗时还没有对照评测。
- 原流程编译器仍以可核对的 Thunar 键盘流程为范围；新增编号动作不会自动变成可分享流程，不会复制临时 refs 或继承 ready 认证。
- 本轮没有云端 API 验收、生产 Web/worker 打包发布、公网/跨架构测试，也没有自动升级本机预览。
- 开发运行：`npm run workstation:build` 构建候选；`npm run test:ui-elements` 创建独立实验。需要从失败处继续时，传入保存的实验目录；替换实验镜像显式使用 `--refresh-image`，原停止容器改名保留。已完成样本应复用报告，避免重复全量测试。
