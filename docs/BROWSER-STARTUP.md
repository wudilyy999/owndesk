# 桌面优先与浏览器按需启动

2026-10-26。工作站镜像升级为 `0.6.3`，guest 协议仍为 6；应用维持 `0.17.0-dev`，无 SQL 或依赖变更。

## 行为

- 工作站启动只准备 X11 桌面与控制器；初始浏览器页面列表为空，不运行 Chromium。
- 首次浏览网页时启动唯一的持久化 Chromium，并使用其初始标签打开目标网址，避免额外保留 `about:blank`。
- 并发打开请求复用同一次浏览器启动，每个请求使用自己的标签。
- 桌面浏览器图标在 idle/human 模式走专用入口；模型的 `/open` 继续受 agent 模式和控制代数约束。交接中不接收新启动请求，启动期间发生交接也会拒绝继续导航。
- 热接管/交还保持已有窗口和页面，不额外启动浏览器。
- 冷启动的空闲工作站同步数据库与 guest 的 boot/epoch；活跃任务继续沿原 acquire/recovery 链核对现场。

冷重启后的浏览器标签、应用窗口和未保存文档恢复不在本次范围。持久化 home/profile 继续保留；原 Shell 冷停止与未知效果复核规则保持。

## 定向验证

`npm run test:browser-startup` 在独立容器中验证冷启动、手动启动、热交还、冷重启、并发动作回执及 DOM/截图；不创建业务任务，不调用模型。默认测试镜像为 0.6.3，可用 `PA_BROWSER_TEST_IMAGE` 指定候选。

首轮五组机制检查已通过，记录在 `data/experiments/pa-browser-startup-6e8b0821/result.json`。之后仅补齐手动启动的桌面观察失效处理；最终镜像的主预览冷启动与实际 Web 接管另行验证，镜像 ID 分别保留，不将两次构建冒充相同制品。

本机主预览已备份 `.env`、数据库、home 和旧容器，并更新至 0.6.3。最终镜像下 boot/epoch 一致、无 Chromium/空白标签；实际网页接管显示 Linux 桌面，结束测试后回到只读观看。任务 12、模型 attempt 65、动作 58、成果 7 均未变化，0 活跃任务、0 新模型请求。

证据：`docs/evidence/browser-startup.json`、`browser-startup-desktop.png`、`browser-startup-takeover.png`。备份目录为私有 `data/backups/browser-startup-1793029996081`，包含敏感配置，保持本地私有。

原 Web 优雅退出关闭监听后进程仍驻留，30 秒后停止该已停止接单的进程；worker 正常退出。初次部署中断记录保留在备份目录 `trial1.json`，没有重跑已通过的桌面任务。

空闲冷启动同步的回归断言补入 `tests/control.ts` 的 transport 分支；本次已有真实主预览核对，未重跑历史完整传输套件。已有流程仍按实际镜像认证，新镜像不继承旧镜像的验证资格。
