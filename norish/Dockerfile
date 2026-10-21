# Norish's published image, pinned. To run your own fork later, point this at the fork's
# image (e.g. ghcr.io/<you>/norish:<tag>) and bump the app version; /data is kept.
ARG BUILD_FROM=norishapp/norish:v0.25.1-beta
# Norish's own build of Obscura, the headless browser behind link imports.
ARG OBSCURA_IMAGE=norishapp/obscura:0.2.4-norish.1
# Cloudflare's tunnel client, for reaching Norish from anywhere (only runs with tunnel_token).
ARG CLOUDFLARED_VERSION=2026.9.3
ARG CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2

FROM ${OBSCURA_IMAGE} AS obscura

FROM ${BUILD_FROM}
ARG CLOUDFLARED_VERSION
ARG CLOUDFLARED_SHA256
LABEL org.opencontainers.image.title="Norish" \
      org.opencontainers.image.source="https://github.com/emerson-flywheel/AI-Intervention"

ENV LANG=C.UTF-8

# Norish's image is Alpine with the app in /app. Added for this add-on:
#  - postgresql17/redis: the database and the real-time/queue store Norish needs.
#  - nginx: the front door on :3000 (drops X-Frame-Options so the HA panel can frame it).
#  - git/openssh-client-default/unzip: the nightly backup to GitHub.
#  - jq/bash/tzdata: options, run.sh, and backup_time in HA's time zone.
RUN apk add --no-cache \
        postgresql17 \
        postgresql17-client \
        redis \
        nginx \
        git \
        openssh-client-default \
        unzip \
        jq \
        bash \
        tzdata \
        curl

# Obscura's binaries are glibc builds and this image is musl, so the whole Obscura image
# (distroless: glibc + the two binaries) is kept as a root to chroot into.
COPY --from=obscura / /opt/obscura/

# A static Go build, checked against the checksum in Cloudflare's release notes.
RUN curl -fsSLo /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod +x /usr/local/bin/cloudflared

COPY run.sh backup.sh nginx.conf github_known_hosts /opt/norish-addon/
RUN chmod +x /opt/norish-addon/run.sh /opt/norish-addon/backup.sh

# The image's own entrypoint drops to the app user; run.sh does that per process instead.
ENTRYPOINT []
CMD ["/opt/norish-addon/run.sh"]
