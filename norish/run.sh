#!/bin/bash
# Norish add-on: starts everything in one container and stops it all if any part dies
# (the Supervisor watchdog then restarts the add-on).
#
#   postgres     127.0.0.1:5432   /data/postgres
#   redis        127.0.0.1:6379   /data/redis
#   obscura      127.0.0.1:9222   link-import browser, chrooted into /opt/obscura (may stop alone)
#   norish       127.0.0.1:3001   the app, as its own user (1000), uploads in /data/uploads
#   nginx        :3000            the port HA and the browser use
#                127.0.0.1:3002   the tunnel's door (keeps Norish's frame guard)
#   cloudflared                   Cloudflare Tunnel to :3002, only with tunnel_token (may stop alone)
#   backup loop                   once after start, then nightly at backup_time
set -euo pipefail

OPTIONS="/data/options.json"
ADDON="/opt/norish-addon"
SECRETS="/data/secrets"
PGDATA="/data/postgres"
log() { echo "[norish] $*"; }

opt() { jq -r "$1" "${OPTIONS}"; }
URL="$(opt '.url // "http://homeassistant.local:3000"')"
ORIGINS="$(opt '(.extra_origins // []) + [.public_url // "" | select(. != "")] | join(",")')"
PUBLIC_URL="$(opt '.public_url // ""')"
TUNNEL_TOKEN="$(opt '.tunnel_token // ""')"

# --- Secrets, made once and kept in /data (so in HA backups, never in GitHub) ---
mkdir -p "${SECRETS}"
chmod 700 "${SECRETS}"
secret() {
    # secret NAME: print the stored value, making a random one the first time
    local f="${SECRETS}/$1"
    if [ ! -s "${f}" ]; then
        node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > "${f}"
        chmod 600 "${f}"
        log "Made ${1}." >&2
    fi
    cat "${f}"
}
# MASTER_KEY derives Norish's encryption keys: changing it loses encrypted data.
MASTER_KEY="$(secret master_key)"
DB_PASSWORD="$(secret db_password | tr -dc 'A-Za-z0-9')"
OBSCURA_TOKEN="$(secret obscura_token)"

PIDS=()
stop_all() {
    log "Stopping."
    # Newest first: Norish goes before the Redis it uses.
    local i
    for ((i = ${#PIDS[@]} - 1; i >= 0; i--)); do kill "${PIDS[i]}" 2>/dev/null || true; done
    if [ -n "${OBSCURA_PID:-}" ]; then
        kill "${OBSCURA_PID}" 2>/dev/null || true
        pkill -x obscura 2>/dev/null || true
    fi
    if [ -n "${TUNNEL_PID:-}" ]; then
        kill "${TUNNEL_PID}" 2>/dev/null || true
        pkill -x cloudflared 2>/dev/null || true
    fi
    su-exec postgres pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null 2>&1 || true
}
trap 'stop_all; exit 0' TERM INT

# --- Postgres ---
mkdir -p /run/postgresql
chown postgres:postgres /run/postgresql
if [ ! -s "${PGDATA}/PG_VERSION" ]; then
    log "First start: creating the database."
    mkdir -p "${PGDATA}"
    chown postgres:postgres "${PGDATA}"
    chmod 700 "${PGDATA}"
    printf '%s' "${DB_PASSWORD}" > /run/postgresql/pw
    chown postgres /run/postgresql/pw
    su-exec postgres initdb -D "${PGDATA}" -U postgres --pwfile=/run/postgresql/pw \
        --auth-local=trust --auth-host=scram-sha-256 >/dev/null
    rm -f /run/postgresql/pw
fi
# pg_ctl opens its log as postgres, and /data belongs to root: the log gets its own folder.
mkdir -p /data/pglog
chown postgres:postgres /data/pglog
if ! su-exec postgres pg_ctl -D "${PGDATA}" -w -l /data/pglog/postgres.log \
        -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/run/postgresql" start >/dev/null; then
    log "Postgres did not start. Its log:"
    tail -n 20 /data/pglog/postgres.log >&2 || true
    exit 1
fi
if ! su-exec postgres psql -h /run/postgresql -U postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='norish'" | grep -q 1; then
    su-exec postgres createdb -h /run/postgresql -U postgres norish
    log "Created database norish."
fi
log "Postgres up."

# --- Redis ---
mkdir -p /data/redis
chown redis:redis /data/redis
su-exec redis redis-server --bind 127.0.0.1 --port 6379 --dir /data/redis \
    --appendonly yes --protected-mode yes --loglevel warning &
PIDS+=($!)

# --- Obscura (glibc binaries, so they run inside their own image's root) ---
cp /etc/resolv.conf /etc/hosts /opt/obscura/etc/ 2>/dev/null || true
mknod -m 666 /opt/obscura/dev/null c 1 3 2>/dev/null || true
mknod -m 666 /opt/obscura/dev/urandom c 1 9 2>/dev/null || true
# Link imports only: if it cannot run (no chroot allowed), Norish still works, so it is
# not one of the processes whose exit stops the add-on.
OBSCURA_CDP_TOKEN="${OBSCURA_TOKEN}" chroot /opt/obscura \
    /obscura serve --host 127.0.0.1 --port 9222 --stealth ||
    log "The link-import browser stopped ($?); recipe links will not import until a restart." &
OBSCURA_PID=$!

# --- Norish ---
mkdir -p /data/uploads
chown -R 1000:1000 /data/uploads
(
    cd /app
    export AUTH_URL="${URL}" \
        TRUSTED_ORIGINS="${ORIGINS}" \
        DATABASE_URL="postgres://postgres:${DB_PASSWORD}@127.0.0.1:5432/norish" \
        MASTER_KEY="${MASTER_KEY}" \
        REDIS_URL="redis://127.0.0.1:6379" \
        OBSCURA_ENDPOINT="ws://127.0.0.1:9222" \
        OBSCURA_CDP_TOKEN="${OBSCURA_TOKEN}" \
        UPLOADS_DIR="/data/uploads" \
        HOST="127.0.0.1" \
        PORT="3001"
    exec su-exec 1000:1000 node /app/dist-server/index.mjs
) &
PIDS+=($!)
log "Norish starting for ${URL}."

# --- nginx ---
mkdir -p /run/nginx
nginx -c "${ADDON}/nginx.conf" &
PIDS+=($!)

# --- Cloudflare Tunnel (from anywhere, only when a token is set) ---
# Not one of the processes whose exit stops the add-on: at home Norish works without it.
# The token goes in the environment, so it is not in the process list.
if [ -n "${TUNNEL_TOKEN}" ]; then
    (
        while true; do
            TUNNEL_TOKEN="${TUNNEL_TOKEN}" cloudflared --no-autoupdate tunnel run ||
                log "The Cloudflare tunnel stopped ($?); ${PUBLIC_URL:-the public address} is down. Retrying in 60 s."
            sleep 60
        done
    ) &
    TUNNEL_PID=$!
    log "Cloudflare tunnel starting for ${PUBLIC_URL:-(public_url not set)}."
    [ -n "${PUBLIC_URL}" ] || log "Set public_url to the tunnel's address, or sign-in from there is refused."
else
    log "No tunnel_token: Norish is reachable at home only."
fi

# --- Backup loop ---
"${ADDON}/backup.sh" loop &
PIDS+=($!)

# Any part exiting stops the add-on.
set +e
wait -n "${PIDS[@]}"
log "A process exited ($?); stopping the add-on."
stop_all
exit 1
