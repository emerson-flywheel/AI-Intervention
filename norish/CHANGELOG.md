# Changelog

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
