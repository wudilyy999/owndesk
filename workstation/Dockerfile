# syntax=docker/dockerfile:1

# The machine every OwnDesk agent works on: a Linux desktop with a real browser,
# streamed over noVNC, plus the everyday developer tools. OwnDesk builds it once
# on your computer (`npm run setup`, or on first use) and runs one container
# per agent from it.

FROM debian:trixie-slim

ARG NODE_VERSION=24.20.0
# Optional apt mirror for builds behind a proxy (only used while building)
ARG APT_MIRROR=

# Chinese by default; override per machine with `docker run -e LANG=... -e TZ=...`
# (OwnDesk passes WORKSTATION_LOCALE / WORKSTATION_TZ through).
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    TZ=Asia/Shanghai \
    DISPLAY=:1 \
    OWNDESK_SCREEN=1280x800 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# The slim base drops every translation; keep the Chinese ones so GTK/XFCE apps speak Chinese
RUN printf 'path-include /usr/share/locale/zh/*\npath-include /usr/share/locale/zh_CN/*\n' \
      > /etc/dpkg/dpkg.cfg.d/zz-owndesk-locale

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify xdotool scrot x11-utils x11-xserver-utils dbus-x11 \
      xfwm4 xfce4-panel xfce4-settings xfconf xfce4-terminal thunar \
      adwaita-icon-theme gnome-themes-extra feh \
      chromium fonts-noto-core fonts-wqy-microhei fonts-noto-color-emoji fonts-liberation fonts-dejavu-core \
      bash-completion ca-certificates curl wget git jq less nano procps iproute2 \
      sudo tini tzdata unzip zip xz-utils openssh-client \
      python3 python3-pip python3-venv python-is-python3 \
      python3-pyatspi at-spi2-core libatk-adaptor \
 && rm -rf /var/lib/apt/lists/*

# Everyday desktop: Chinese locale and fonts, fcitx5 pinyin, office and the small
# apps a person expects on a computer. Bigger optional apps live in packs that
# `owndesk-apps install <pack>` adds on demand (see rootfs/usr/share/owndesk/apps.d).
RUN if [ -n "$APT_MIRROR" ]; then \
      cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.orig \
   && sed -i "s#http://deb.debian.org#$APT_MIRROR#" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      locales fonts-noto-cjk fonts-crosextra-carlito fonts-crosextra-caladea \
      fcitx5 fcitx5-pinyin fcitx5-frontend-gtk3 \
      xfdesktop4 xfce4-screenshooter xfce4-taskmanager xfce4-notifyd \
      librsvg2-common mousepad ristretto evince galculator xdg-utils desktop-file-utils shared-mime-info \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 libreoffice-l10n-zh-cn \
 && sed -i -e 's/^# *\(zh_CN.UTF-8 UTF-8\)/\1/' -e 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
 && locale-gen \
# Chromium ships only en-US; keep just the Chinese UI pack from chromium-l10n
 && cd /tmp && apt-get download "chromium-l10n=$(dpkg-query -W -f='${Version}' chromium)" \
 && dpkg-deb -x chromium-l10n_*.deb /tmp/l10n \
 && cp /tmp/l10n/usr/lib/chromium/locales/zh-CN.pak /usr/lib/chromium/locales/ \
 && rm -rf /tmp/l10n /tmp/chromium-l10n_*.deb \
 && if [ -n "$APT_MIRROR" ]; then mv /tmp/debian.sources.orig /etc/apt/sources.list.d/debian.sources; fi \
 && rm -rf /var/lib/apt/lists/*

# Reuse the upstream desktop and official Node runtime; remote access uses our authenticated gateway.
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/README.md' --exclude='*/CHANGELOG.md' \
 && node --version

COPY controller/package*.json /opt/owndesk-controller/
RUN cd /opt/owndesk-controller && npm ci --omit=dev
COPY controller/ /opt/owndesk-controller/

# The agent works as an ordinary user with passwordless sudo: it can install
# what a task needs, and none of it touches your computer
RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

COPY rootfs/ /
# Scripts must stay runnable even if a checkout converted line endings.
# Only OwnDesk's own: node and cloudflared live in the same folder.
RUN sed -i 's/\r$//' /usr/local/bin/owndesk-* /usr/local/bin/browser /etc/chromium.d/owndesk \
 && chmod +x /usr/local/bin/owndesk-* /usr/local/bin/browser \
 && chown -R agent:agent /home/agent

# Web app launchers, bookmarks and the Chinese search policy come from web.d
RUN owndesk-gen-web \
 && (gtk-update-icon-cache -f /usr/share/icons/hicolor >/dev/null 2>&1 || true)

USER agent
WORKDIR /home/agent
EXPOSE 6081

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["owndesk-desktop"]
