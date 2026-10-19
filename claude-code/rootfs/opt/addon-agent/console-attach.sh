#!/usr/bin/env bash
# shellcheck shell=bash
# ttyd runs this for each browser connection: a herdr client on the console (the HA
# page's Console tab). Leaving the page detaches; coming back attaches again.
RUN="${ADDON_RUN:-/run/claude-code}"
# `herdr session attach` would start an empty server if none is running: never do that.
if ! herdr --session claude workspace list >/dev/null 2>&1; then
    echo "The console is starting. Reload this page in a moment."
    sleep 5
    exit 1
fi
ws="$(cat "${RUN}/workspace" 2>/dev/null || true)"
[ -n "${ws}" ] && herdr --session claude workspace focus "${ws}" >/dev/null 2>&1
exec herdr session attach claude
