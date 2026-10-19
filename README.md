# AI Intervention for Home Assistant

Claude Code in your Home Assistant sidebar. Ask in plain English ("why didn't the porch
light come on last night?", "write me an automation that closes the blinds when the AC
kicks on") and it reads your logs and config, explains, and makes the change when you
say yes.

[![Add repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Femerson-flywheel%2FAI-Intervention)

## What you get

- **Console**: Claude in a console that stays open. Leave the page and come back to the
  same conversation; after a restart it picks up where it left off.
- **Settings**: sign in from the browser with a link and a code. The seat shows whether
  you are signed in and on which plan, tells you when the login runs out, and lets you
  name it and pick Claude's model, thinking level and permission mode.
- **Full reach**: Home Assistant's own APIs and your config files, so it can check, edit
  and reload.
- **Asks first**: it asks before every change unless you choose otherwise.

## Install

1. Press the button above, or Settings › Apps › Install app › ⋮ › Repositories and add
   `https://github.com/emerson-flywheel/AI-Intervention`.
2. Open **AI Intervention** in the list, **Install**, **Start**, and turn on
   **Show in sidebar**.
3. Open it, go to **Settings**, press **Sign in at claude.ai**, and paste the code back.

## You need

- Home Assistant OS or Supervised (anything with Apps), on a 64-bit Intel/AMD or ARM box.
- A Claude Pro or Max plan.

## Be careful

This app can change anything in your Home Assistant. Anyone who can open your Home
Assistant can use it. Keep it on the *Default* permission mode (Settings tab; asks
before every change) until you trust it.

Full docs: [claude-code/DOCS.md](claude-code/DOCS.md) (also the app's Documentation
tab). Changes: [claude-code/CHANGELOG.md](claude-code/CHANGELOG.md).

## Development

`cd claude-code && node --test 'tests/*.test.mjs'` (Node 22+, tmux); the other test
layers are in [claude-code/tests/README.md](claude-code/tests/README.md). Images are
built by GitHub Actions with Home Assistant's builder and published to GHCR when
`version` in `claude-code/config.yaml` is new.

MIT licence. Not affiliated with Anthropic or Home Assistant.
