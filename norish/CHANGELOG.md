# Changelog

## 0.3.0 — 2026-11-17

- **Recipes in the sidebar is now this app's own entry** (ingress panel, `mdi:chef-hat`,
  open to non-admin users too). It frames Norish from `url`, as the old Recipes dashboard did.
- **No Norish sign-in when opened from Home Assistant**, for the HA users listed in the new
  `ha_users` option (HA user name or ID, plus their Norish email). A small sign-in service
  in the app (`ha-sso.mjs`) is an OIDC provider that Norish trusts. It says yes only to a
  browser that just came through ingress, where Supervisor has checked the HA sign-in.
  Norish's sign-in page shows a "Home Assistant" button. Opened by Norish's own address,
  that button is refused, and the email and password sign-in works as before.
- The first time, each person signs in to Norish with their password once inside Recipes,
  then opens Recipes again; that links their HA user to their Norish account. Norish's
  password accounts aren't email-verified, so better-auth won't link them on its own.
- No `ha_users` = no "Home Assistant" button; Recipes shows Norish's own sign-in.
- `tests/ha-sso.test.mjs`: the sign-in flow against better-auth 1.6.33 (Norish v0.25.1-beta's).

## 0.2.0 — 2026-10-21

- Norish from anywhere: with `tunnel_token` and `public_url` set, a Cloudflare Tunnel
  (cloudflared 2026.9.3, checksum-checked) runs inside the app and carries Norish only.
  Cloudflare's email code goes in front of it (set up in Cloudflare; see the docs).
- The tunnel comes in on its own door, 127.0.0.1:3002, which tells Norish the browser
  used https (so sign-in stays on the https address) and keeps Norish's
  `X-Frame-Options: DENY`, so no other site can frame it from the internet. Port 3000,
  ingress and the Recipes tab are unchanged.
- The tunnel's token is passed in the environment, not on the command line. If the tunnel
  stops, Norish keeps running and the tunnel is retried every minute.
- `public_url` and `tunnel_token` have no default, so leaving them out never stops the app
  from starting.

## 0.1.4 — 2026-10-21

- Ingress also passes `/api/trpc` (still needs a Norish API key). Norish's `/api/v1` can add
  and read recipes but has no edit call, and editing goes through `/api/trpc`.

## 0.1.3 — 2026-10-21

- Home Assistant ingress now reaches Norish's API (`/api/v1`, which still needs a Norish
  API key), so a tool signed in to HA can add recipes without port 3000. Only the API is
  served there: Norish's pages need the site root, so "Open Web UI" now shows a note
  pointing to the Recipes tab. Use the Recipes tab, or port 3000, to open Norish.

## 0.1.2 — 2026-10-20

- Fix: Postgres would not start on Home Assistant ("can't create /data/postgres.log:
  Permission denied"). pg_ctl opens its log as the postgres user, and `/data` belongs to
  root. The log is now in `/data/pglog/`, owned by postgres, and a failed start prints
  the end of it to the app log.

## 0.1.1 — 2026-10-20

- Fix: the app would not start on a fresh install. The empty default for `backup_repo`
  failed its own pattern, and Home Assistant refused the options. `backup_repo` and
  `backup_token` now have no default (leave them unset for no GitHub backup).

## 0.1.0 — 2026-10-19

- First version. Norish v0.25.1-beta (`norishapp/norish`), with Postgres 17, Redis and
  nginx in the same container, and Norish's Obscura 0.2.4 build for link imports, run in
  a chroot because it is a glibc build.
- Served on port 3000. nginx drops Norish's `X-Frame-Options: DENY` so the Recipes sidebar
  tab (a dashboard with one iframe) can show it.
- Secrets (`MASTER_KEY`, database password, Obscura token, deploy key) are made on first
  start and kept in `/data/secrets`. HA backups include them; GitHub never does.
- Nightly backup: Norish's recipe export, unzipped into a private GitHub repo over SSH
  with a deploy key, with GitHub's host key pinned. A commit is made only when a recipe
  changed.
