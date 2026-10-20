#!/bin/bash
# Nightly backup of every recipe to a private GitHub repo.
#
#   backup.sh loop   run once Norish is up, then every day at backup_time (never exits)
#   backup.sh once   one backup now; exit code says whether it worked
#
# What is backed up: Norish's own recipe export (a .norishrecipes zip: recipe.json + photos
# per recipe), unzipped into recipes/ so GitHub shows each recipe's changes as text. Logins,
# meal plans and grocery lists are not in it; HA's backups of this add-on hold those.
# The API token and the deploy key's private half stay in /data and never reach the log.
set -uo pipefail

OPTIONS="/data/options.json"
ADDON="/opt/norish-addon"
KEY="/data/secrets/deploy_key"
REPO_DIR="/data/backup-repo"
WORK="/run/norish-backup"
MAX_FILE_BYTES=$((50 * 1024 * 1024))  # GitHub refuses files over 100 MB; keep well under
log() { echo "[norish-backup] $*"; }

opt() { jq -r "$1" "${OPTIONS}"; }
REPO="$(opt '.backup_repo // ""')"
TIME="$(opt '.backup_time // "03:30"')"

export GIT_SSH_COMMAND="ssh -i ${KEY} -o IdentitiesOnly=yes -o BatchMode=yes \
-o UserKnownHostsFile=${ADDON}/github_known_hosts -o StrictHostKeyChecking=yes"
export GIT_AUTHOR_NAME="Norish add-on" GIT_AUTHOR_EMAIL="norish-addon@homeassistant.local"
export GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL}"

ensure_key() {
    if [ ! -s "${KEY}" ]; then
        ssh-keygen -q -t ed25519 -N "" -C "norish-addon backup" -f "${KEY}"
        log "Made a deploy key."
    fi
    log "Deploy key for ${REPO} (add it on GitHub: repo → Settings → Deploy keys → Allow write access):"
    log "$(cat "${KEY}.pub")"
}

backup_once() {
    local token
    token="$(opt '.backup_token // ""')"
    if [ -z "${token}" ]; then
        log "Skipped: backup_token is empty. Make one in Norish → Settings → API token."
        return 1
    fi
    rm -rf "${WORK}"
    mkdir -p "${WORK}"
    chmod 700 "${WORK}"
    # The token goes to curl in a file, not on its command line.
    printf 'x-api-key: %s\n' "${token}" > "${WORK}/header"

    local code
    code="$(curl -sS -o "${WORK}/export.zip" -w '%{http_code}' -H "@${WORK}/header" \
        "http://127.0.0.1:3001/export/recipes?scope=instance")"
    rm -f "${WORK}/header"
    if [ "${code}" != "200" ]; then
        log "Failed: the recipe export answered HTTP ${code}. Check backup_token belongs to an admin."
        return 1
    fi
    if ! unzip -tq "${WORK}/export.zip" >/dev/null 2>&1; then
        log "Failed: the recipe export is not a readable zip."
        return 1
    fi

    if [ ! -d "${REPO_DIR}/.git" ]; then
        rm -rf "${REPO_DIR}"
        if ! git clone -q "${REPO}" "${REPO_DIR}" 2>"${WORK}/git.err"; then
            log "Failed: could not clone ${REPO}: $(tail -1 "${WORK}/git.err")"
            return 1
        fi
    fi
    git -C "${REPO_DIR}" remote set-url origin "${REPO}"
    if ! git -C "${REPO_DIR}" pull -q --ff-only origin main 2>"${WORK}/git.err" &&
            git -C "${REPO_DIR}" ls-remote --exit-code origin main >/dev/null 2>&1; then
        log "Failed: could not update from ${REPO}: $(tail -1 "${WORK}/git.err")"
        return 1
    fi

    rm -rf "${REPO_DIR}/recipes"
    mkdir -p "${REPO_DIR}/recipes"
    unzip -q "${WORK}/export.zip" -d "${REPO_DIR}/recipes"
    local skipped=0
    while IFS= read -r -d '' big; do
        log "Left out (over 50 MB): ${big#"${REPO_DIR}/"}"
        rm -f "${big}"
        skipped=$((skipped + 1))
    done < <(find "${REPO_DIR}/recipes" -type f -size +"${MAX_FILE_BYTES}"c -print0)
    if [ ! -f "${REPO_DIR}/README.md" ]; then
        cat > "${REPO_DIR}/README.md" <<'README'
# Norish recipe backup

Written nightly by the Norish Home Assistant add-on. `recipes/` is Norish's own recipe
export, unzipped: one folder per recipe with its `recipe.json` and photos. To restore,
zip the contents of `recipes/` (so `manifest.json` is at the top), rename it to
`backup.norishrecipes`, and import it in Norish → Settings → Import.
README
    fi

    local count
    count="$(jq -r '.recipeCount // "?"' "${REPO_DIR}/recipes/manifest.json" 2>/dev/null || echo "?")"
    # exportedAt changes every run; leave it out of what counts as a change.
    git -C "${REPO_DIR}" add -A
    if git -C "${REPO_DIR}" diff --cached --quiet -- . ':(exclude)recipes/manifest.json'; then
        git -C "${REPO_DIR}" reset -q --hard
        log "No recipe changes since the last backup (${count} recipes)."
        return 0
    fi
    git -C "${REPO_DIR}" commit -q -m "Backup $(date '+%Y-%m-%d %H:%M'): ${count} recipes" || return 1
    if ! git -C "${REPO_DIR}" push -q origin HEAD:main 2>"${WORK}/git.err"; then
        log "Failed: push to ${REPO} refused: $(tail -1 "${WORK}/git.err")"
        log "Is the deploy key added with write access?"
        return 1
    fi
    local note=""
    [ "${skipped}" -gt 0 ] && note=" (${skipped} large files left out)"
    log "Backed up ${count} recipes to ${REPO}${note}."
}

wait_for_norish() {
    until curl -fsS -o /dev/null "http://127.0.0.1:3001/api/v1/health" 2>/dev/null; do
        sleep 10
    done
}

seconds_until() {
    # seconds from now until the next HH:MM (today if still ahead, else tomorrow)
    local now next
    now="$(date +%s)"
    next="$(date -d "$1" +%s)"
    [ "${next}" -le "${now}" ] && next=$((next + 86400))
    echo $((next - now))
}

case "${1:-once}" in
    once)
        [ -n "${REPO}" ] || { log "backup_repo is empty."; exit 1; }
        ensure_key >/dev/null
        backup_once
        ;;
    loop)
        if [ -z "${REPO}" ]; then
            log "GitHub backup is off (backup_repo is empty)."
            exec sleep infinity
        fi
        ensure_key
        wait_for_norish
        backup_once || true
        while true; do
            sleep "$(seconds_until "${TIME}")"
            backup_once || true
        done
        ;;
esac
