# Tests for the Claude Code add-on

Node 22, no npm dependencies, and tmux. Run from `claude-code/`.

| Layer | Command | Needs |
|---|---|---|
| Unit + flows (link and code checks, agent verbs and refusals, sign-in with the fake `claude` in a real tmux, page server and proxy, key line) | `node --test 'tests/*.test.mjs'` | tmux |
| The same, plus the real herdr (console bootstrap, the loop, the guard, the pane gate, attach) | `HERDR_REAL=/path/to/herdr-0.9.3 node --test 'tests/*.test.mjs'` | herdr 0.9.3 binary |
| The Seat sign-in in a real browser, inside an ingress-style iframe | `PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs SCREENSHOT_DIR=/tmp/shots node --test tests/browser/signin.browser.mjs` | Playwright + Chromium; `PW_CHANNEL=chromium` for the full browser |
| Attach-client fuzz: the prefix + every key, then clicks over the whole screen (~5 min) | `python3 tests/attach-fuzz.py /path/to/herdr rootfs/etc/herdr/attach.toml` → `RESULT HELD` | herdr, tmux |

Without `HERDR_REAL` or Playwright those tests are skipped, and the skip says why.
`attach-fuzz.py` with `rootfs/etc/herdr/console.toml` is its control: keys open a
workspace there (the pane gate still gives it no shell).

The fakes in `fakes/` stand in for herdr (`herdr`, state in a JSON file), for claude
(`claude`, a real-shaped sign-in link and a token written only for the right code) and
for an agent that only swallows keys (`claude-fuzz`). herdr keeps its socket under
`$HOME`, so keep `TMPDIR` short (a socket path is at most 108 bytes).
