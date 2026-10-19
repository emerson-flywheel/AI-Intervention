#!/usr/bin/env bash
# shellcheck shell=bash
# herdr's default shell for every pane (console.toml [terminal] default_shell).
# Only the console's own pane, made by console.mjs with ADDON_CONSOLE=1, gets bash (to
# run console-loop.sh). Any other pane, including the workspace herdr makes by itself
# when the last one closes while a client is attached, gets no shell: a client must
# never reach one that way. The console loop offers the Console's shell itself.
if [ "${ADDON_CONSOLE:-}" = 1 ]; then
    exec bash "$@"
fi
trap '' INT QUIT TSTP
stty -echo -icanon 2>/dev/null
echo "This add-on has one console, and no shell here."
echo "The console comes back by itself within seconds; reload the page then."
while :; do sleep 3600; done
