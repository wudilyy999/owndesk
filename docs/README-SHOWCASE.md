# README showcase notes / README 展示说明

Updated / 更新：2026-11-19

## References / 参考项目

The screenshots and README structure were refreshed after PR #27; the README structure was informed by these repositories. Star counts are GitHub API snapshots and describe the reference projects.

以下为实际阅读过的同类项目 README。Star 数量取自 GitHub API，仅用于说明参考项目规模。

| Project / 项目                                                         | 2026-11-08 | 2026-11-18 | Pattern adopted / 借鉴方式                                                                                                             |
| ---------------------------------------------------------------------- | ---------: | ---------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent#readme)    |            |    264,346 | Install first, then getting started, a command reference, docs, and contributing. 先安装，再上手路径、命令速查、文档和贡献。           |
| [Browser Use](https://github.com/browser-use/browser-use#readme)       |    120,287 |    121,384 | A short product promise, an early visual example, and concrete task prompts. 一句话定位、前置演示、具体任务。                          |
| [OpenHands](https://github.com/OpenHands/OpenHands#readme)             |     92,920 |     93,723 | Product screenshot above the feature list; clear setup paths and linked technical details. 首屏产品截图、清晰安装路径、技术细节下沉。  |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop#readme) |     39,570 |     39,603 | English/Chinese entry points and a gallery tied to use cases. 中英文切换、围绕场景组织画廊。                                           |
| [Khoj](https://github.com/khoj-ai/khoj#readme)                         |            |     38,166 | Overview, features with screenshots, self-hosting, and an FAQ. 概览、带截图的能力说明、自托管和常见问题。                              |
| [Agent Zero](https://github.com/agent0ai/agent-zero#readme)            |     19,793 |     19,911 | Connect desktop capabilities to everyday work; make the first useful prompt easy to find. 将桌面能力写成日常用途，提供第一条任务示例。 |

OwnDesk’s copy emphasizes its own implemented flow: visible computer work, human handoff, downloadable results, long-running goals, and self-improvement with rollback. Competitor screenshots, artwork, performance claims, and badges were not reused.

OwnDesk 的文案围绕已有的桌面操作、接管交还、成果下载、长期目标和可回退的自我改进展开。配图全部来自 OwnDesk，性能数字仅链接本项目已有报告。

## Screenshot provenance / 截图来源

- **Source / 源码**: OwnDesk revision `d093ea82dcc3a07f8a278430b349674490af14f3` (PR #27).
- **Capture / 采集**: a separately running Next.js application, an isolated PostgreSQL database, and Playwright Chromium `156.0.8078.4`; captured on 2026-11-18.
- **Content / 内容**: a dedicated demo owner, a synthetic completed task, a saved artifact, sample memory notes, and a saved sample manual. The task, status, artifact, and manual are seeded examples for UI illustration, not a model-run result or evidence that the manual was generated automatically. 示例任务、完成状态、成果、记忆和手册均为专门准备的展示数据。
- **Application / 应用**: original Chinese UI and styles. Preview-only settings disable the development indicator and use a separate build directory. No UI labels or result states were altered in the browser for capture.
- **Scope / 范围**: web interface screenshots; a Docker desktop or real model was not started for this capture. Real desktop/model evidence remains in `docs/evidence/`. 本次截图未运行模型或 Docker 桌面，真实执行证据见已有报告。
- **Files / 文件**: WebP images with no browser chrome, credentials, private conversations, or third-party artwork.

| Asset / 图片                                          | CSS viewport / 视口   | Page / 页面              | What it shows / 展示内容                                                                                                |
| ----------------------------------------------------- | --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [workspace.webp](images/workspace.webp)               | 1280 × 785            | `/`                      | Workspace navigation, completed task, execution record, downloadable CSV / 工作区导航、已完成任务、执行记录、可下载 CSV |
| [workspace-mobile.webp](images/workspace-mobile.webp) | 390 × 844             | `/`                      | Compact task workspace / 小屏任务工作区                                                                                 |
| [companion.webp](images/companion.webp)               | 1120 × 680            | `/companion`             | Companion chat / 陪伴聊天                                                                                               |
| [memory.webp](images/memory.webp)                     | 1120 × 680            | `/companion`, memory tab | Editable saved notes / 可编辑记忆                                                                                       |
| [manuals.webp](images/manuals.webp)                   | 1120 × 680, full page | `/manuals`               | A saved sample manual and expanded steps / 示例手册与展开的操作步骤                                                     |
| [mobile.webp](images/mobile.webp)                     | 390 × 844             | `/companion`             | Mobile chat layout / 手机聊天界面                                                                                       |

Captured at device scale factor 1.5 and encoded as WebP at quality 90. The sample artifact was downloaded through the authenticated application endpoint and its contents checked. The workspace, companion, and settings pages had no horizontal overflow; no browser page errors were observed. These are interface checks, separate from agent execution validation.

所有截图采用 1.5 倍设备像素比、WebP 质量 90。已通过登录后的真实下载接口检查示例文件内容；工作区、陪伴页和设置页在 390 像素下无横向溢出，采集过程中无浏览器页面异常。这些检查仅针对界面和下载。

To refresh the gallery, use a separate source checkout and empty database, create a demo owner and clearly illustrative content, start the web app, and capture the same pages and viewport sizes. Review every image before replacing it, then update the source revision and capture date here.

更新截图时，使用独立源码目录和空数据库，建立演示账号与示例内容，启动网页并按表中尺寸采集。逐张检查后替换图片，同时更新本页的源码版本和采集日期。

## Self-improvement screenshots / 自我改进截图

These two images come from local test instances. The pages were captured at a 1120 × 800 viewport for the improvement report and a 1120 × 610 viewport for the versions page, then saved as WebP. The instances used synthetic data; no credentials or private conversations are visible.

这两张图来自本机测试实例。自我改进页使用 1120 × 800 视口，版本页使用 1120 × 610 视口，保存为 WebP。测试实例使用合成数据，画面里没有凭据和私人对话。

| Asset / 图片                                              | Captured / 日期 | Page / 页面     | Crop / 裁剪 | What it shows / 展示内容                                                                                                      |
| --------------------------------------------------------- | --------------- | --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [improvement-report.webp](images/improvement-report.webp) | 2026-11-19      | `/improvements` | full page   | A candidate that passed every check, with adopt, revise, and discard actions / 全部检查通过的候选，以及采用、再改改、放弃按钮 |
| [versions.webp](images/versions.webp)                     | 2026-11-19      | `/versions`     | full page   | Current and kept versions, with an automatic rollback in the switch history / 当前版本、保留版本和包含自动回退的切换记录      |
