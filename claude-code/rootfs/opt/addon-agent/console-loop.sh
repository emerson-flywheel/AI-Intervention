#!/usr/bin/env bash
# shellcheck shell=bash
# The console pane's loop (started by console.mjs as `exec bash -lc <this>`).
# Claude runs with --continue when a conversation exists. When Claude exits:
#  - after a sign-in (the relaunch marker), Claude starts again on the new login;
#  - while a remote client is attached or typing (a guard in guard.d), no shell is
#    offered, only Enter to start Claude again;
#  - otherwise a shell, and Claude starts again when the shell is left.
RUN="${ADDON_RUN:-/run/claude-code}"
# shellcheck source=/dev/null
. "${RUN}/console.env"   # WORKDIR, CLAUDE_ARGS=( ... ), CLAUDE_CONFIG_DIR

# Ctrl+C here must not end the loop: the pane would close with it.
trap ':' INT QUIT TSTP

setstate() {
    printf '%s\n' "$1" > "${RUN}/.state.tmp" && mv -f "${RUN}/.state.tmp" "${RUN}/state"
}

guard_open() {
    local f pid
    for f in "${RUN}"/guard.d/*; do
        [ -e "$f" ] || continue
        pid="${f##*/}"
        if kill -0 "$pid" 2>/dev/null; then return 0; fi
        rm -f "$f"
    done
    return 1
}

# Claude Code names its project dirs after the cwd with separators replaced by '-'.
has_conversation() {
    local slug
    slug="$(printf '%s' "${WORKDIR}" | sed -e 's#^/##' -e 's#[/\\:]#-#g')"
    [ -n "$(find "${CLAUDE_CONFIG_DIR}/projects" -path "*${slug}*" -name '*.jsonl' 2>/dev/null | head -n1)" ]
}

cd "${WORKDIR}" || exit 1
# Clear the `exec bash -lc …` line herdr typed to start this loop.
printf '\033[H\033[2J'
while :; do
    args=("${CLAUDE_ARGS[@]}")
    has_conversation && args+=(--continue)
    setstate claude
    "${CLAUDE_BIN:-claude}" "${args[@]}"
    status=$?
    if [ -e "${RUN}/relaunch" ]; then
        rm -f "${RUN}/relaunch"
        echo "[claude-code] Signed in again: starting Claude on the new login."
        continue
    fi
    echo
    echo "[claude-code] Claude exited (status ${status})."
    # Say "shell" first, then look for a guard: the agent adds its guard first, then
    # reads this state, so one of the two always sees the other.
    setstate shell
    if guard_open; then
        setstate prompt
        echo "[claude-code] A remote client is attached, so no shell is offered."
        echo "[claude-code] Press Enter to start Claude again."
        read -r _ || true
        continue
    fi
    echo "[claude-code] You are in a shell. Type exit to start Claude again."
    echo "[claude-code] If logged out: use the Seat tab, or run claude and /login."
    bash -il || true
done
