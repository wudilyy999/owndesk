# Code provenance and licenses

This project selectively derives code from Xiryn v0.6.0, commit
`7b08375f3664e550ad89af83fd69923033b6b9c2` (MIT).
Copyright (c) 2026 Sourav Bera. The full upstream notice is retained in LICENSE.
File-level source and adaptation records are in provenance.json.

noVNC is MPL-2.0. Its browser package and workstation distribution retain their
upstream notices. Chromium, Debian, XFCE, fonts and other workstation packages have
their own licenses; a distributable image needs a package/license inventory before release.
The inherited pricing catalog is a dated reference, not a live price guarantee.

The working name "OwnDesk" is independent of Xiryn. Upstream release checks,
feedback links and update/install programs are not enabled in this project.

## Companion channels (QQ / WeChat)

Protocol knowledge only, no code copied: tencent-connect/botpy (MIT), Tencent/openclaw-weixin (MIT),
the official QQ bot and WeChat Official Account documentation. See `docs/channels.md`.

## Workstation Stage A (Chinese environment, preinstalled apps)

Design and structure borrowed from MIT-licensed projects; the files here are original or adapted, no copyleft code was copied.

| Project                                                       | What was borrowed                                                                  | License |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| kasmtech/workspaces-images (Copyright 2022 Kasm Technologies) | One install script per application, installed on demand (`owndesk-apps`, `apps.d`) | MIT     |
| anthropics/claude-quickstarts `computer-use-demo`             | Desktop layout for an agent-driven XFCE machine                                    | MIT     |
| trycua/cua `libs/xfce`                                        | XFCE desktop, app launchers and wallpaper approach                                 | MIT     |

New workstation packages (Debian, each under its own license; copyright files are kept in `/usr/share/doc/<package>/copyright`):
LibreOffice (MPL-2.0), fcitx5 and fcitx5-chinese-addons (LGPL-2.1+ / GPL), Noto CJK fonts (SIL OFL 1.1),
Carlito/Caladea (SIL OFL 1.1), xfdesktop4, xfce4-screenshooter, xfce4-taskmanager, Mousepad, Ristretto,
Evince, Galculator, librsvg. Optional packs (`media`, `creative`, `games`) install VLC, Rhythmbox, FFmpeg,
GIMP, Inkscape, GNOME games and SuperTuxKart from Debian on request. Bilibili and NetEase Cloud Music are
opened as ordinary web pages; no site code or assets are bundled.

## Private Linux packaging candidate (0.9.0-dev)

| Image/component                      | Role                                                          | Primary license source for release audit                                       |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `node:24.20.0-bookworm-slim`         | Web/worker build and runtime                                  | Node.js LICENSE and its bundled dependency notices                             |
| Docker CLI from `docker:29.7.2-dind` | Trusted worker only; daemon image also used by isolated tests | docker/cli LICENSE and base-image package notices                              |
| `caddy:2.11.7-alpine`                | HTTPS, SSE and WSS entry                                      | caddyserver/caddy LICENSE and base-image package notices                       |
| `postgres:16.15-alpine`              | Control/business/auth/DBOS database                           | PostgreSQL License and base-image package notices                              |
| Debian `iptables` / `iproute2`       | Trusted worker's scoped network initializer/checker           | Installed `/usr/share/doc/<package>/copyright` and individual package licenses |

Primary texts to include in the release audit:

```text
https://raw.githubusercontent.com/nodejs/node/v24.20.0/LICENSE
https://raw.githubusercontent.com/docker/cli/v29.7.2/LICENSE
https://raw.githubusercontent.com/caddyserver/caddy/v2.11.7/LICENSE
https://www.postgresql.org/about/licence/
```

This is a component/source inventory, not a complete redistribution audit or an SBOM.
The application images retain LICENSE and provenance.json. Base-image OS packages,
all npm transitives, fonts and the workstation still need a complete release inventory
with their required texts/notices before publishing images. Rebuild the images after
updating this file so they contain the current inventory.

## Agent Zero plugin contract adapter (2026-10-26)

The guest-only adapter in `scripts/agent-zero-bridge.py` implements a subset of
the public `Tool`/`Response` contract documented by Agent Zero, reference commit
`ff2a5b9c9c4e490ba38dd7c313e779510bb2071a` (MIT, copyright Agent Zero, s.r.o.).
The complete framework is not bundled. Installed community packages retain their
original source and LICENSE in the version-pinned package stored in PostgreSQL.
Reference plugin repositories and compatibility scope are recorded in
`docs/AGENT-ZERO-COMPATIBILITY.md`.

## Archived numbered UI experiment (withdrawn 2026-10-27)

The withdrawn 0.7.0 experiment included Debian's AT-SPI/pyatspi, Pillow, Tesseract OCR and
English/Simplified-Chinese OCR data. Package copyright/license texts remain in
`/usr/share/doc/<package>/copyright` inside the image. `ui-elements.py` and
`dom.mjs` are local implementations; no learned detector/model weights or
OpenCV runtime were bundled. These modules are now archived in
`data/deferred/ui-annotations-withdrawn-20261027/source/`; the default 0.6.3
source excludes these annotation dependencies. Historical images and evidence
remain available. The full image redistribution audit above remains required.

## Agent Zero Linux AT-SPI migration (2026-10-29, development)

`workstation/controller/atspi_core.py` selectively adapts 34 named reader, window-ID,
semantic matching/scoring and inline-tag parser functions from
`agent0ai/a0-connector`, commit `3741c8809f1f99b4efee2ed1a24234a98bf896d4`,
`packages/a0-computer-use-wayland/src/a0_computer_use_wayland/computer_use_helper.py`.
MIT, Copyright (c) 2026 Agent Zero. Full notice is retained in
`licenses/a0-connector-LICENSE` and beside the guest adapter as
`workstation/controller/a0-connector-LICENSE`, which is copied into the image.
The existing action/control/receipt bridge replaces upstream Portal transport;
GI interface dispatch, protected fields, object-identity binding, explicit errors
and partial-effect handling are locally adapted. Whole upstream framework,
Wayland Portal/PipeWire runtime and UI are not vendored.

## Companion Stage B2a: pictures and similar-note cards (2026-11-03, development)

- `sharp` 0.35.x (Apache-2.0) is a new runtime dependency for server-side picture
  resizing and metadata stripping. It links the libvips prebuilt binaries
  (`@img/sharp-libvips-*`, LGPL-3.0-or-later; dynamically linked, unmodified).
  Their licenses ship inside the npm packages.
- The similar-note check (`lib/companion/similar.ts`) and the confirm-card flow are written
  from scratch. The idea of looking up near-duplicates before writing a memory comes from
  mem0 (`mem0ai/mem0`, Apache-2.0) and Letta / MemGPT (`letta-ai/letta`, Apache-2.0).
  No code from either project is included; unlike them, nothing is merged without the
  person's confirmation.
