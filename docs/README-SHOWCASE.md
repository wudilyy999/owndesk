# README showcase notes / README 展示说明

Updated / 更新：2026-11-08

## References / 参考项目

The README structure was informed by these repositories. Star counts are a GitHub API snapshot from 2026-11-08; they describe the reference projects, not OwnDesk.

以下为本次实际阅读的竞品 README。Star 数量取自 2026-11-08 的 GitHub API，仅用于说明参考项目规模。

| Project / 项目                                                         | Stars at review / 阅读时 Star | Pattern adopted / 借鉴方式                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Browser Use](https://github.com/browser-use/browser-use#readme)       |                       120,287 | A short product promise, an early visual example, and concrete task prompts. 一句话定位、前置演示、具体任务。                          |
| [OpenHands](https://github.com/OpenHands/OpenHands#readme)             |                        92,920 | Product screenshot above the feature list; clear setup paths and linked technical details. 首屏产品截图、清晰安装路径、技术细节下沉。  |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop#readme) |                        39,570 | English/Chinese entry points and a gallery tied to use cases. 中英文切换、围绕场景组织画廊。                                           |
| [Agent Zero](https://github.com/agent0ai/agent-zero#readme)            |                        19,793 | Connect desktop capabilities to everyday work; make the first useful prompt easy to find. 将桌面能力写成日常用途，提供第一条任务示例。 |

OwnDesk’s copy emphasizes its own implemented flow: visible computer work, human handoff, downloadable results, and reviewed manuals. Competitor screenshots, artwork, performance claims, and badges were not reused.

OwnDesk 的文案围绕已有的桌面操作、接管交还、成果下载和手册审阅展开。配图全部来自 OwnDesk，性能数字仅链接本项目已有报告。

## Screenshot provenance / 截图来源

- **Source / 源码**: OwnDesk revision `4fe5239fe27d7ef91038629348f0b470fd11e288`.
- **Capture / 采集**: a separately running Next.js application, an isolated PostgreSQL database, and Playwright Chromium `156.0.8078.4`; captured on 2026-11-08.
- **Content / 内容**: a dedicated demo owner, sample conversations, sample memory notes, a saved sample manual, and a downloadable sample Markdown file. The completed task and manual are seeded examples for UI illustration, not a model-run result or evidence that the manual was generated automatically. 示例任务、完成状态、记忆和手册均为专门准备的展示数据。
- **Application / 应用**: original Chinese UI and styles. Preview-only settings disable the development indicator and use a separate build directory. No UI labels or result states were altered in the browser for capture.
- **Scope / 范围**: web interface screenshots; a Docker desktop or real model was not started for this capture. Real desktop/model evidence remains in `docs/evidence/`. 本次截图未运行模型或 Docker 桌面，真实执行证据见已有报告。
- **Files / 文件**: WebP images with no browser chrome, credentials, private conversations, or third-party artwork.

| Asset / 图片                            | CSS viewport / 视口   | Page / 页面              | What it shows / 展示内容                                                                    |
| --------------------------------------- | --------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| [workspace.webp](images/workspace.webp) | 1440 × 1080           | `/`                      | Conversation navigation, sample delivery, follow-up composer / 会话导航、示例交付、追问入口 |
| [companion.webp](images/companion.webp) | 1120 × 800            | `/companion`             | Companion chat / 陪伴聊天                                                                   |
| [memory.webp](images/memory.webp)       | 1120 × 800            | `/companion`, memory tab | Editable saved notes / 可编辑记忆                                                           |
| [manuals.webp](images/manuals.webp)     | 1120 × 800, full page | `/manuals`               | A saved sample manual and expanded steps / 示例手册与展开的操作步骤                         |
| [mobile.webp](images/mobile.webp)       | 390 × 844             | `/companion`             | Mobile chat layout / 手机聊天界面                                                           |

Captured at device scale factor 1.5 and encoded as WebP at quality 90. The sample artifact was downloaded through the authenticated application endpoint and its contents checked. The mobile page had no horizontal overflow; no browser page errors were observed. These are interface checks, separate from agent execution validation.

所有截图采用 1.5 倍设备像素比、WebP 质量 90。已通过登录后的真实下载接口检查示例文件内容；390 像素页面无横向溢出，采集过程中无浏览器页面异常。这些检查仅针对界面和下载。

To refresh the gallery, use a separate source checkout and empty database, create a demo owner and clearly illustrative content, start the web app, and capture the same pages and viewport sizes. Review every image before replacing it, then update the source revision and capture date here.

更新截图时，使用独立源码目录和空数据库，建立演示账号与示例内容，启动网页并按表中尺寸采集。逐张检查后替换图片，同时更新本页的源码版本和采集日期。
