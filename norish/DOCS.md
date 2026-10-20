# Norish

Your own copy of [Norish](https://github.com/norish-recipes/norish), the recipe app:
recipes, link imports, meal plans, grocery lists and households. It runs with its
database inside this add-on, opens from the **Recipes** tab in the sidebar, and can back
your recipes up to GitHub every night.

## First start

1. Set **url** to the address you will open Norish at, with the same host name you use
   for Home Assistant, e.g. `http://homeassistant.local:3000` if you open HA at
   `http://homeassistant.local:8123`. If you open HA by IP, use the IP here too.
2. Start the add-on, then press **Open Web UI**.
3. Sign up. The first account is the admin, and sign-up closes after it. Add family
   members from Norish → Settings → Admin.

Change the Recipes tab's address in `config/dashboards/recipes.yaml` to match **url**.
The host names must match: Norish's sign-in cookie is refused inside the Recipes tab when
Home Assistant and Norish are opened under different host names.

## GitHub backup

1. On GitHub, create an empty **private** repository, e.g. `norish-recipes-backup`.
2. Set **backup_repo** (under "Show unused optional configuration options") to its SSH address, e.g. `git@github.com:you/norish-recipes-backup.git`.
3. In Norish → Settings → API token, create a token and paste it into **backup_token**.
4. Restart the add-on. The log shows a line starting `ssh-ed25519`: that is the deploy
   key (its public half, safe to copy). Add it on GitHub under the repository's
   **Settings → Deploy keys**, with **Allow write access** ticked.
5. Restart again. The log says `Backed up N recipes`, and GitHub shows the commit.

After that, a backup runs every night at **backup_time** and on every start, and makes a
commit only when a recipe changed. Each recipe is a folder with `recipe.json` and its
photos, so GitHub's history shows what changed in each recipe, day by day.

The backup holds recipes only. Logins, meal plans and grocery lists are in Home
Assistant's own backups of this add-on, together with the add-on's keys.

**Restore a recipe from GitHub:** zip the contents of `recipes/` (with `manifest.json` at
the top of the zip), rename it to `backup.norishrecipes`, and import it in Norish →
Settings → Import. A recipe with the same name or link is overwritten by the imported one.

## Options

| Option | What it does |
| --- | --- |
| `url` | The address Norish is opened at (Norish's sign-in needs it exact). |
| `extra_origins` | Other addresses Norish is also opened at, e.g. `http://192.168.1.10:3000`. |
| `backup_repo` | The private GitHub repo for the nightly backup. Not set turns the backup off. |
| `backup_token` | A Norish API token from an admin account. |
| `backup_time` | When the nightly backup runs (HH:MM, Home Assistant's time zone). |

## What is inside

Norish's published image (pinned as `BUILD_FROM` in the `Dockerfile`), plus Postgres 17, Redis and nginx.
The link-import browser (Norish's Obscura build) runs inside the add-on too. If it
cannot start, Norish still runs and only link imports fail. Everything is kept in the
add-on's data folder, which Home Assistant backups include. The add-on stops for the few
seconds a backup takes, so the database copy is consistent.

## Switching to your own fork later

Point `BUILD_FROM` in the `Dockerfile` at your fork's image (e.g. `ghcr.io/you/norish:tag`),
bump `version` in `config.yaml`, and rebuild. The data folder is kept, and Norish
upgrades its database on start.
