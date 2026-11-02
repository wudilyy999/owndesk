# 工作站（Stage A：中文环境与预置软件）

机器人的“独立电脑”是 `owndesk-workstation` 镜像（Debian trixie + XFCE + noVNC）。Stage A 让这台电脑开箱即用、说中文，并像一台有生活气息的真电脑。

版本：`owndesk-workstation:0.7.0`（`npm run workstation:build`）。0.6.6 约 1.56 GB，0.7.0 约 2.20 GB（实测，+约 0.64 GB，主要是 LibreOffice 与中日韩字体）。

## 内置内容

| 方面     | 内容                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 语言时区 | `zh_CN.UTF-8`、`Asia/Shanghai`；GTK/XFCE/LibreOffice/Chromium 界面均为中文（Debian slim 默认丢弃翻译，镜像按需保留 `zh`/`zh_CN`） |
| 字体     | Noto CJK、Carlito/Caladea（Office 文档字形兼容）                                                                                  |
| 输入法   | fcitx5 拼音，`Ctrl+Space` 切换，默认先是英文键盘，不拦截 Agent 键入                                                               |
| 办公     | LibreOffice 文字/表格/演示（含中文界面）、Evince（PDF）、Mousepad、Ristretto、截图、任务管理器、计算器                            |
| 桌面     | xfdesktop 壁纸与桌面图标、`~/Life`（我的日记）、常用软件与网页应用的图标                                                          |
| 浏览器   | 只用 Chromium：书签栏预置“常用”、默认搜索百度、界面简体中文、哔哩哔哩/网易云音乐网页应用                                          |

`~/Pictures/wallpaper.png`（或 `.jpg`）存在时替换壁纸。

## 按需安装：`owndesk-apps`

```text
owndesk-apps list              # 列出软件包与安装状态
owndesk-apps info <pack>       # 说明与包名
owndesk-apps install <pack>    # 联网安装，并在桌面放图标
owndesk-apps installed
```

软件包清单是 `workstation/rootfs/usr/share/owndesk/apps.d/<pack>.conf`（`TITLE`、`DESCRIPTION`、`PACKAGES`、`LAUNCHERS`、`BUILTIN`），每个文件是一个“脚本”，参考 Kasm workspaces-images 的按应用安装脚本。名称限 `[a-z0-9-]`。现有：`office`（已内置）、`media`、`creative`、`games`、`game-supertuxkart`。安装使用 `sudo apt-get`，需要工作站能联网；已安装再运行是安全的。

## 网页应用与书签：`web.d`

`workstation/rootfs/usr/share/owndesk/web.d/*.conf` 在构建时由 `owndesk-gen-web` 生成：

- 每个站点生成 `owndesk-web-<id>.desktop`，通过 `owndesk-webapp <url>`（`chromium --app`，独立 profile `owndesk-webapps`，不占用控制器的浏览器 profile 与调试端口）。
- Chromium 托管策略：`ManagedBookmarks`、`DefaultSearchProvider*`、`HomepageLocation`、`BookmarkBarEnabled`。`search.conf` 可换搜索引擎。

## 家目录默认值

家目录是 Docker 卷，镜像更新不会改它。默认值（fcitx5 配置、桌面图标、LibreOffice 首次提示）在每次开机由 `owndesk-session` 只在缺失时写入；用户或角色删掉的图标不会回来。已有工作站容器在重建后才使用新镜像。

## 语言与时区

镜像默认中文。要改，设置 `.env`：

```text
WORKSTATION_LOCALE=en_US.UTF-8   # 内置 zh_CN.UTF-8 与 en_US.UTF-8
WORKSTATION_TZ=America/New_York
```

`lib/workstation.ts` 创建容器时传入 `LANG`、`LANGUAGE` 与 `TZ`。

## 对 Agent 桌面控制的影响

- 界面为中文，AT-SPI 控件名也是中文（如“文件(F)”）；原生语义目标请按截图或观察到的名称。
- AT-SPI 窗口路径含应用序号。xfdesktop 每次启动会唤醒 Thunar 的 D-Bus 服务并在约 10 秒后退出，这会让其他应用序号变动，所以桌面启动时保留一个常驻 `Thunar --daemon`。

## 验收

```text
npm test                                   # 含 tests/workstation-stage-a.test.ts（清单、生成器、环境参数）
npm run test:workstation:stage-a           # 真实容器：语言、字体、拼音输入、LibreOffice、Chromium、安装 games、Agent 控制、英文覆盖
npm run test:atspi:native                  # 同一镜像上的原生 AT-SPI（用 `tsx tests/atspi-native.ts <阶段>`）
```

网络无法直连 `deb.debian.org` 时，`STAGE_A_APT_MIRROR=http://host:port` 会在测试容器里改 apt 源；构建镜像可用 `docker build --build-arg APT_MIRROR=...`。

`tests/atspi-observation.ts` 与 `npm run test:atspi` 是 0.6.x 早期的观察测试，期望已与当前控制器不符（原因字符串、partial 状态），在 0.6.6 上同样失败，已被 `test:atspi:native` 取代。
