#!/bin/sh
# Settings › Tools › Snapshot before edits: Claude Code runs this before each file edit
# (a PreToolUse hook). It saves the config folder in a local git history in
# /data/ha-history, so any change can be undone. It never blocks the edit: every path
# ends in exit 0. The database, logs and other bulky or churning files are left out.
HA="${ADDON_HA_DIR:-/homeassistant}"
DATA="${ADDON_DATA:-/data}"
HIST="${DATA}/ha-history"
cat >/dev/null 2>&1
[ -d "${HA}" ] || exit 0
if [ ! -d "${HIST}" ]; then
    git init -q --bare "${HIST}" >/dev/null 2>&1 || exit 0
    git --git-dir="${HIST}" config core.bare false
    mkdir -p "${HIST}/info"
    cat > "${HIST}/info/exclude" <<'EOF'
home-assistant_v2.db*
*.log
*.log.*
*.db
*.db-shm
*.db-wal
.storage/trace.saved_traces
tts/
deps/
backups/
.cloud/
__pycache__/
node_modules/
.git/
EOF
fi
# At most 50 s (the hook's timeout is 60): add everything, and commit only when it changed.
timeout 50 sh -c '
    hist="$0"
    ha="$1"
    git() { command git --git-dir="${hist}" --work-tree="${ha}" -c user.name="AI Intervention" -c user.email="snapshot@ai-intervention.local" "$@"; }
    git add -A || exit 0
    git diff --cached --quiet && exit 0
    git commit -q -m "Before an edit by Claude"
' "${HIST}" "${HA}" >/dev/null 2>&1
exit 0
