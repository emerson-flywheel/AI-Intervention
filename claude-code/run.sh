#!/usr/bin/with-contenv bash
# shellcheck shell=bash
# with-contenv (not bashio) -> keeps SUPERVISOR_TOKEN/env, no bashio dependency
# (the base image's bashio was not exec'able). Options read via jq from /data/options.json.
#
# What runs (all supervised by the loop at the end):
#   herdr server, session "claude"  the console: one workspace whose pane runs Claude
#   ttyd on 127.0.0.1:7682          a herdr client for the page's Console tab
#   node server.mjs on :7681        the page (ingress): Console + Settings tabs, sign-in
#   sshd on :22 (host 2248)         only once the remote console is on (Settings, or remote_key)
set -euo pipefail

OPTIONS="/data/options.json"
AGENT="/opt/addon-agent"
RUN="/run/claude-code"
log() { echo "[claude-code] $*"; }

# --- Persistent auth (survives restarts/updates via the add-on /data volume) ---
export CLAUDE_CONFIG_DIR="/data/claude"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# --- The app's own skill (routines, tools, undoing from the snapshot history), fresh each start ---
mkdir -p "${CLAUDE_CONFIG_DIR}/skills/ai-intervention" /data/routines /data/tools
cp -f "${AGENT}/skills/ai-intervention/SKILL.md" "${CLAUDE_CONFIG_DIR}/skills/ai-intervention/SKILL.md" \
    || log "Skill: the app's routines skill could not be copied."

# --- Read add-on options (no bashio) ---
OAUTH_TOKEN=""
START_FOLDER=""
if [ -f "${OPTIONS}" ]; then
    OAUTH_TOKEN="$(jq -r '.oauth_token // ""' "${OPTIONS}")"
    START_FOLDER="$(jq -r '.start_folder // ""' "${OPTIONS}")"
fi

# --- Auth mode ---
if [ -n "${OAUTH_TOKEN}" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="${OAUTH_TOKEN}"
    log "Auth: using CLAUDE_CODE_OAUTH_TOKEN from add-on options."
elif [ -f "${CLAUDE_CONFIG_DIR}/.credentials.json" ]; then
    log "Auth: using stored credentials in ${CLAUDE_CONFIG_DIR}."
else
    log "Auth: none yet. Open the Settings tab and press Sign in at claude.ai."
fi

# --- HA admin reach (SUPERVISOR_TOKEN injected via homeassistant_api/hassio_api) ---
export HA_API="http://supervisor/core/api"
export SUPERVISOR_API="http://supervisor"
log "HA Core API: ${HA_API} | Supervisor: ${SUPERVISOR_API} (Bearer \$SUPERVISOR_TOKEN)"

# --- Permission posture ---
# Set on the Settings tab, which writes permissions.defaultMode into Claude Code's own
# settings file, so no --permission-mode here. The container runs as root, so Claude Code
# BLOCKS the fully-unattended modes (bypassPermissions); the tab offers only
# default/acceptEdits/plan.
CLAUDE_ARGS=()
log "Permission level: from the Settings tab (${CLAUDE_CONFIG_DIR}/settings.json)."

# The MCP servers switched on in Settings › Tools (tools Claude added). Claude does not start
# when this file is missing, so it is made here when it is not there. The = form keeps
# --mcp-config from taking the arguments after it as more files.
if node "${AGENT}/tools.mjs" mcp-file; then
    CLAUDE_ARGS+=("--mcp-config=${CLAUDE_CONFIG_DIR}/addon-mcp.json")
else
    log "Tools: the MCP file could not be written; Claude starts without Claude's tools."
fi

# Where Claude starts: the start_folder option when it names a folder (its CLAUDE.md, if
# any, loads as project memory), with --add-dir /homeassistant so the live config stays
# editable. Empty, or not a folder: /homeassistant itself.
case "${START_FOLDER}" in
    /homeassistant|/homeassistant/) START_FOLDER="" ;;
esac
if [ -n "${START_FOLDER}" ] && [ -d "${START_FOLDER}" ]; then
    WORKDIR="${START_FOLDER}"
    CLAUDE_ARGS+=("--add-dir" "/homeassistant")
    log "Start folder: ${WORKDIR} + --add-dir /homeassistant (live config)."
elif [ -d /homeassistant ]; then
    WORKDIR="/homeassistant"
    [ -n "${START_FOLDER}" ] && log "start_folder ${START_FOLDER} is not a folder here."
    log "Start folder: ${WORKDIR}."
else
    WORKDIR="/data"
    log "Start folder: ${WORKDIR} (no /homeassistant)."
fi

# --- The console loop's settings (console-loop.sh reads them) ---
# Auto-resume: the loop adds --continue on every start when a conversation exists for
# the workspace (transcripts persist in /data/claude), so a restart picks up where it
# left off and a fresh state still starts cleanly.
mkdir -p "${RUN}/guard.d"
rm -f "${RUN}"/guard.d/* "${RUN}/relaunch" "${RUN}/state" "${RUN}/pane" "${RUN}/workspace" \
    "${RUN}/ttyd-restart" "${RUN}/ttyd.pid" "${RUN}/remote" "${RUN}/loop-pid" "${RUN}/offduty" \
    "${RUN}/remote-apply" "${RUN}/hostkey-reset"
{
    printf 'WORKDIR=%q\n' "${WORKDIR}"
    printf 'CLAUDE_CONFIG_DIR=%q\n' "${CLAUDE_CONFIG_DIR}"
    printf 'CLAUDE_ARGS=('
    for a in ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}; do printf ' %q' "$a"; done
    printf ' )\n'
} > "${RUN}/console.env"

# --- The Console's look (Settings tab): herdr's configs for it, written under /run ---
if node "${AGENT}/look.mjs" configs; then
    export HERDR_CONFIG_PATH="${RUN}/herdr/console.toml"
else
    log "Console look: herdr's configs could not be written; using the shipped ones."
    rm -rf "${RUN}/herdr"
    export HERDR_CONFIG_PATH="/etc/herdr/console.toml"
fi

# --- herdr: the console ---
export HOME="${HOME:-/root}"
unset XDG_CONFIG_HOME
HERDR_PID=""
start_herdr() {
    herdr --session claude server >/dev/null 2>&1 &
    HERDR_PID=$!
    for _ in $(seq 1 40); do
        herdr --session claude workspace list >/dev/null 2>&1 && break
        sleep 0.25
    done
    node "${AGENT}/console.mjs" bootstrap "${WORKDIR}" || log "Console: herdr did not take the console workspace."
}

# --- ttyd: the page's Console tab (a herdr client) ---
# The look's font size and colours are ttyd client options, read at each start; the page
# watches ttyd.pid to reload the Console when ttyd starts again for a new look.
# scrollback=0: herdr keeps the scrollback, so the terminal leaves no room for a
# scrollbar of its own (an empty strip down the right). disableResizeOverlay: no size box
# flashes when the page fits the terminal or a phone's keyboard opens.
TTYD_PID=""
start_ttyd() {
    local look=()
    mapfile -t look < <(node "${AGENT}/look.mjs" ttyd-args 2>/dev/null || true)
    ttyd --interface 127.0.0.1 --port 7682 --base-path /console --writable \
        --client-option titleFixed="AI Intervention" --client-option scrollback=0 \
        --client-option disableResizeOverlay=true ${look[@]+"${look[@]}"} \
        "${AGENT}/console-attach.sh" &
    TTYD_PID=$!
    printf '%s\n' "${TTYD_PID}" > "${RUN}/ttyd.pid"
}

# --- the page (ingress port 7681) ---
PAGE_PID=""
start_page() {
    node "${AGENT}/server.mjs" &
    PAGE_PID=$!
}

# --- sshd: the remote key (remote_key, or Settings › Remote console) ---
# keyline.mjs reads the options, else the page's /data/remote.json. The page asks for the
# setting to be applied again (remote-apply) or for a new host key (hostkey-reset); the
# loop below does both, with no restart.
SSHD_PID=""
SSHD_WANTED=0
prepare_sshd() {
    local rc=0
    SSHD_WANTED=0
    node "${AGENT}/keyline.mjs" || rc=$?
    case "${rc}" in
        0) ;;
        1) log "Remote console: off (no remote_key, and not turned on in Settings), so its port stays closed."; return 0 ;;
        3) log "Remote console: the key's addresses must name where it may log in from (no names, no /0). Refused; the port stays closed."; return 0 ;;
        *) log "Remote console: the key is not one plain ssh-ed25519 public key line. Refused; the port stays closed."; return 0 ;;
    esac
    mkdir -p /data/ssh
    chmod 700 /data/ssh
    if [ ! -f /data/ssh/ssh_host_ed25519_key ]; then
        ssh-keygen -q -t ed25519 -N '' -C 'claude-code add-on' -f /data/ssh/ssh_host_ed25519_key
        log "Remote console: made the host key once (kept in /data/ssh)."
    fi
    # OpenSSH refuses even key logins for a locked account ("!"); "*" still allows no password.
    sed -i 's/^root:![^:]*:/root:*:/' /etc/shadow
    log "Remote console: host key $(ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
    SSHD_WANTED=1
}
start_sshd() {
    /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.addon &
    SSHD_PID=$!
}
# Off, removed or a new host key: sshd and every login it holds (an attached remote client
# too) end, so nothing keeps working on the old setting.
stop_sshd() {
    if alive "${SSHD_PID}"; then
        kill "${SSHD_PID}" 2>/dev/null || true
        wait "${SSHD_PID}" 2>/dev/null || true
    fi
    SSHD_PID=""
    pkill -x sshd 2>/dev/null || true
}

stop_all() {
    log "Stopping."
    herdr --session claude server stop >/dev/null 2>&1 || true
    for pid in "${TTYD_PID}" "${PAGE_PID}" "${SSHD_PID}" "${HERDR_PID}"; do
        if [ -n "${pid}" ]; then kill "${pid}" 2>/dev/null || true; fi
    done
    exit 0
}
trap stop_all TERM INT

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

log "Starting: herdr console, page on :7681 (ingress), ttyd on 127.0.0.1:7682."
start_herdr
start_ttyd
start_page
prepare_sshd
[ "${SSHD_WANTED}" = 1 ] && start_sshd

# Supervise: restart whatever stopped. A herdr server that lost the console workspace
# (or came back from a restored session) gets it made again; strays are closed.
while :; do
    sleep 5 &
    wait $! || true
    if ! alive "${HERDR_PID}"; then
        log "herdr server stopped; starting it again."
        start_herdr
    elif ! node "${AGENT}/console.mjs" check; then
        log "Console workspace missing; making it again."
        node "${AGENT}/console.mjs" bootstrap "${WORKDIR}" || true
    fi
    # A new look from the Settings tab: ttyd again, so its client reads the new herdr config
    # and ttyd's colours and font size. Claude, in the herdr server, keeps running.
    if [ -f "${RUN}/ttyd-restart" ]; then
        rm -f "${RUN}/ttyd-restart"
        log "Console look changed; starting the Console's client again."
        if alive "${TTYD_PID}"; then
            kill "${TTYD_PID}" 2>/dev/null || true
            wait "${TTYD_PID}" 2>/dev/null || true
        fi
        start_ttyd
    fi
    alive "${TTYD_PID}" || { log "ttyd stopped; starting it again."; start_ttyd; }
    alive "${PAGE_PID}" || { log "Page server stopped; starting it again."; start_page; }
    # Settings › Remote console › Reset host key: a new identity for sshd. Computers that
    # pinned the old one refuse until they take the new fingerprint.
    if [ -f "${RUN}/hostkey-reset" ]; then
        rm -f "${RUN}/hostkey-reset" /data/ssh/ssh_host_ed25519_key /data/ssh/ssh_host_ed25519_key.pub
        log "Remote console: a new host key was asked for on the Settings tab."
        stop_sshd
        touch "${RUN}/remote-apply"
    fi
    # Settings › Remote console turned on, off or changed: the key line again, then sshd
    # started or stopped to match. A new key or address alone needs no sshd restart.
    if [ -f "${RUN}/remote-apply" ]; then
        rm -f "${RUN}/remote-apply"
        prepare_sshd
        if [ "${SSHD_WANTED}" = 1 ]; then
            alive "${SSHD_PID}" || { log "Remote console: on; port open."; start_sshd; }
        elif alive "${SSHD_PID}" || pgrep -x sshd >/dev/null 2>&1; then
            log "Remote console: turned off on the Settings tab; port closed."
            stop_sshd
        fi
    fi
    if [ "${SSHD_WANTED}" = 1 ] && ! alive "${SSHD_PID}"; then
        log "sshd stopped; starting it again."
        start_sshd
    fi
done
