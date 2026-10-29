# Linux 原生控件进入桌面观察（开发版）

本文件记录最初只读阶段。2026-10-29 的后续原生读写迁移与当前验收状态见 `docs/AT-SPI-MIGRATION.md`；下文的只读范围、旧版预算和镜像号保留为历史证据。

日期：2026-10-29。范围：只读 AT-SPI2 + 原始截图；继续使用原坐标/键盘工具。

## 当前行为

`screen_capture`、`screen_share`、桌面输入后的新观察，以及 `desktop_open_application` 的观察，共用 `captureDesktop`。它现在返回：

- 原始 JPEG、尺寸、活动窗口与原有 `observationId/epoch/bootId`。
- `accessibility`：来源、活动窗口范围、状态、采样时间、进程号、遍历数及截断情况。
- `elements`：有用的可见原生控件/文本，含 `role/name/states/bounds`，可读取时附带 `text/value`。
- `screenshotCapturedAt`：截图完成时间。控件采样随后进行，两者为顺序采样，不能视为原子快照。

实际 GTK 夹具中的一个例子：模型在看到原图的同时，收到如下辅助信息，随后仍用坐标点击。

```json
{
  "accessibility": {
    "source": "atspi2",
    "status": "ok",
    "scope": "active_window",
    "coordinateSpace": "screenshot_pixels",
    "truncated": false
  },
  "elements": [
    {
      "role": "button",
      "name": "Save report",
      "states": ["enabled", "sensitive", "focusable"],
      "bounds": { "x": 94, "y": 123, "width": 580, "height": 34 }
    }
  ]
}
```

上面的名称来自真实夹具；位置仅为格式示例，执行时必须读取当前观察。成功验收中，按实际控件框中心发送普通 `pointer_click`，随后观察读到 `Report saved`。

## 接入路径

```text
screen_capture / screen_share / desktop_open_application / pointer_* / key_*
  → 原有 guest 动作队列、journal 与控制检查
  → captureDesktop
      → 读取截图前窗口与尺寸
      → owndesk-shot：原始截图
      → accessibility.py：读取同一桌面 D-Bus 上的 AT-SPI
      → 再次读取窗口与尺寸；变化时拒绝旧观察
  → 原有 worker toolMessage/modelOutput：元数据文本 + 原始图像
  → 原有上下文有界投影：保留完整控件记录，注明 omittedElements
  → 模型决定下一次坐标/键盘输入
```

没有新增工具、语义点击 API、编号截图、OCR、永久控件索引或第二套 Agent 循环。网页 DOM 工具保持原样。截图最多保留当前控制代最近两张。

## 范围、上限与失败语义

- 通过 X11 活动窗口 `_NET_WM_PID` 找到应用，再以窗口标题/几何范围选取唯一窗口；多候选或无法确认时返回 unavailable。只观察该窗口，排除同进程其他窗口。
- 遍历最多 600 节点、60 条有用记录、深度 40、约 24 KB 输出；名称最多 160 字符、文本最多 240 字符。保留 disabled、checked、focused 等状态，包含有用静态文本。
- 内部遍历预算 1.5 秒；AT-SPI 单次调用超时 200 ms，整个读取子进程硬上限 3 秒。预算包含启动和窗口定位，繁忙软件可能得到 partial/unavailable。
- `ok` 表示本次范围内的有界读取成功，不能证明整个应用的所有按钮都已暴露。`partial` 表示节点失效或遍历/输出上限造成遗漏；`unavailable` 表示无活动窗口、未暴露窗口、范围不唯一、读进程异常、超时或无效输出。模型提示明确要求结合截图判断。
- 读取失败保留截图和现有坐标操作；原因显式进入观察。原有截图失败、窗口变化、旧控制代、失效 observationId 仍按原逻辑拒绝，不掩盖桌面输入的未知效果。
- 密码角色不读取名称、文本、值或子树；仅返回 redacted、角色、状态和位置。普通文本可能包含用户业务信息，会和截图一样发给所选模型；不能将此称为全屏敏感信息过滤器。
- 所有控件内容都作为不可信观察数据。控件信息不授予付款、发信或其他操作授权，也不创建可跨观察复用的操作句柄。

## 镜像与兼容

`workstation/Dockerfile` 新增 `python3-pyatspi/at-spi2-core/libatk-adaptor`；桌面启动时启用辅助功能，并让 GUI 和控制器共用会话 D-Bus。guest 协议继续为 6，健康能力增加 `atspi-observation-v1`。新字段为可选扩展，worker 沿用已有元数据转发，无 SQL 迁移。

源码新构建默认工作站版本为 `0.6.4`。本机 `.env` 仍固定 `0.6.3`，6797/6798 和主工作站未升级。

本轮实际桌面验收使用 `owndesk-workstation:0.6.4-atspi`：复用已有含 AT-SPI 依赖的镜像层，再覆盖当前 controller/rootfs。该测试镜像的构建文件和记录保留在实验目录。它的缓存底座还含历史实验的未使用依赖，不能等同于已完成干净生产镜像验收。从 Debian 开始的完整构建遇到软件源下载缓慢，已停止并保留日志；正式打包仍需运行 `npm run workstation:build`。

## 已验证范围

证据：`docs/evidence/atspi-observation.json`；原始材料位于 `data/experiments/atspi-observation-1793245588489/`。

- 18 项上下文定向单元通过，新增原生控件完整记录、可用性状态、遗漏计数与两张图片上限检查。
- 真实 Thunar 可读取名称；GTK 可读取名称/文本/值/选中/禁用/位置；密码明文、隐藏文本、同进程后台窗口文本未进入结果。
- 一次真实坐标点击后读到新状态；相同动作重放复用完整回执，旧观察被拒绝，接管后旧代输入被拒绝。
- 真实读进程的超时、异常、无效 JSON 均保留截图；限制遍历数时返回 partial/truncated。
- 用真实桌面数据经过实际 SDK 序列化，在本地 fetch 捕获到控件文本及两张 JPEG；0 云模型请求。这个检查覆盖模型上下文和序列化，没有创建完整 worker Task，也没有证明真实模型的识别或点击准确率提升。
- 类型检查、变更文件格式检查、guest JS/Bash 与 Python 语法检查通过。原失败夹具与网络超时记录保留。

后续独立验收：干净生产镜像、多软件兼容矩阵，以及视觉单独/视觉加 AT-SPI 的真实模型对照。当前用户预览保持原版本。
