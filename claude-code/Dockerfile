ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23
FROM ${BUILD_FROM}

# The builder (BuildKit) passes TARGETARCH (amd64|arm64); a Supervisor build on the box
# passes BUILD_ARCH (amd64|aarch64). Either picks the binaries below.
ARG TARGETARCH
ARG BUILD_ARCH
ARG TTYD_VERSION=1.7.7
# sha256 of each ttyd release binary (from the 1.7.7 release's SHA256SUMS, and checked by
# downloading both). A mismatch fails the build.
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG HERDR_VERSION=0.9.3
# sha256 of each herdr release asset (both read from the v0.9.3 release and checked by
# downloading them). A mismatch fails the build.
ARG HERDR_SHA256_X86_64=18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7
ARG HERDR_SHA256_AARCH64=4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0

ENV LANG=C.UTF-8 \
    CLAUDE_CONFIG_DIR=/data/claude \
    HERDR_CONFIG_PATH=/etc/herdr/console.toml

# Runtime deps:
#  - nodejs/npm: installs Claude Code; the published CLI is a NATIVE binary delivered
#    via platform optionalDependencies, so npm pulls linux-x64-musl on this Alpine base.
#    Node also runs the app's page and the remote agent (no npm dependencies).
#  - libstdc++/libgcc: the native binary links them.
#  - git: Claude Code uses it. jq/curl/bash/ncurses: tooling + ttyd.
#  - tmux: only for the Seat sign-in pane (`tmux -L seat-login`); the console is herdr.
#  - openssh-server: the remote key (port 2248), off unless remote_key is set.
RUN apk add --no-cache \
        nodejs \
        npm \
        git \
        curl \
        ca-certificates \
        libstdc++ \
        libgcc \
        bash \
        ncurses \
        tmux \
        jq \
        openssh-server

# ttyd static binary = the web terminal behind the add-on's page (127.0.0.1:7682)
RUN set -eu; \
    case "${TARGETARCH:-${BUILD_ARCH:-amd64}}" in \
        aarch64|arm64) TTYD_ARCH="aarch64"; TTYD_SHA256="${TTYD_SHA256_AARCH64}" ;; \
        *)       TTYD_ARCH="x86_64";  TTYD_SHA256="${TTYD_SHA256_X86_64}" ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}" \
        -o /usr/bin/ttyd; \
    echo "${TTYD_SHA256}  /usr/bin/ttyd" | sha256sum -c -; \
    chmod +x /usr/bin/ttyd; \
    ttyd --version

# herdr (static binary, so it runs on Alpine): the console's session host
RUN set -eu; \
    case "${TARGETARCH:-${BUILD_ARCH:-amd64}}" in \
        aarch64|arm64) HERDR_ARCH="aarch64"; HERDR_SHA256="${HERDR_SHA256_AARCH64}" ;; \
        *)       HERDR_ARCH="x86_64";  HERDR_SHA256="${HERDR_SHA256_X86_64}" ;; \
    esac; \
    curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${HERDR_ARCH}" \
        -o /usr/bin/herdr; \
    echo "${HERDR_SHA256}  /usr/bin/herdr" | sha256sum -c -; \
    chmod +x /usr/bin/herdr; \
    herdr --version

# Claude Code (npm selects the matching musl/glibc native binary for this arch).
# Unpinned on purpose: each rebuild takes the current Claude Code, as 0.1.x did, so the
# add-on keeps up with Claude's own fixes and sign-in changes. (A sign-in link that asks
# for something new fails the Seat's link check closed rather than going through.)
RUN npm install -g @anthropic-ai/claude-code && claude --version

COPY rootfs/ /
COPY run.sh /run.sh
# Strip any stray CR (defensive), make executable, and refuse a herdr config herdr rejects
RUN sed -i 's/\r$//' /run.sh /opt/addon-agent/*.sh \
    && chmod a+x /run.sh /opt/addon-agent/*.sh \
    && HERDR_CONFIG_PATH=/etc/herdr/console.toml herdr config check | grep -qx 'config: ok' \
    && HERDR_CONFIG_PATH=/etc/herdr/attach.toml herdr config check | grep -qx 'config: ok'

CMD [ "/run.sh" ]

LABEL \
    org.opencontainers.image.title="Home Assistant App: Claude Code" \
    org.opencontainers.image.description="Claude Code in the Home Assistant sidebar: a console that stays open, and sign-in from the browser." \
    org.opencontainers.image.source="https://github.com/emerson-flywheel/AI-Intervention" \
    org.opencontainers.image.licenses="MIT"
