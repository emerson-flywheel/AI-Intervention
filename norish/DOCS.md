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

**Recipes** in the sidebar is this app's own entry (turn on **Show in sidebar** on the
Info tab). It frames Norish from **url**, so **url** must use the same host name you open
Home Assistant at: Norish's sign-in cookie is refused inside the frame when the two
differ. It works at home only; opened through an https address from outside, the
browser blocks the http frame.

## No sign-in from Home Assistant

List who may skip Norish's sign-in when they open **Recipes** from Home Assistant's
sidebar, under **ha_users**:

```yaml
ha_users:
  - ha_user: alex          # their Home Assistant user name (or user ID)
    email: alex@example.com # the email of their Norish account
```

Save and restart. Then each person, once:

1. Opens **Recipes** from the sidebar. The first time it says to sign in once.
2. Signs in to Norish with their email and password, right there.
3. Opens **Recipes** again. That links their Home Assistant user to their Norish
   account, and from then on Recipes opens Norish already signed in.

How it holds: Home Assistant's Supervisor only lets a signed-in HA user through to this
app's sidebar page, and it tells the app which user that is. The app then gives that
browser a one-use pass for about a minute, and Norish's "Home Assistant" sign-in accepts
nothing else. Opened by Norish's own address, from any device, there is no pass: Norish
asks for its sign-in, and its "Home Assistant" button says to use the sidebar. An HA user
who isn't listed sees Norish's own sign-in. On the Cloudflare address the button shows
too, but it has no pass there either, so it is refused the same way.

Remove someone from **ha_users** and restart: they sign in to Norish with their password
again. Empty **ha_users** turns this off.

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

## From anywhere (Cloudflare)

Norish can also be opened from anywhere at your own https address, e.g.
`https://recipes.example.com`, through a Cloudflare Tunnel that runs inside this app.
No port is opened on your router, and the tunnel carries Norish only, never Home
Assistant. Cloudflare asks for a one-time code sent to your email before Norish's own
sign-in page even shows, so strangers never reach Norish at all.

You need a free Cloudflare account and a domain on it (an existing one, or one bought
from Cloudflare for about $10 a year). Set Cloudflare up first, in this order, so the
address is never online without the email code in front of it:

1. **Email code:** Cloudflare → Zero Trust → Access → Applications → Add an application →
   Self-hosted. Name it Norish, set the domain to `recipes.example.com`, and add a policy
   that allows the emails of the people who may open it. One-time PIN is the sign-in
   method by default.
2. **Tunnel:** Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it
   `norish`. Copy the token (the long text after `--token` in the install command shown;
   do not run that command). Add a public hostname: `recipes` on your domain, service
   type **HTTP**, URL **`127.0.0.1:3002`**.
3. **Here:** set **public_url** to `https://recipes.example.com` and paste the token into
   **tunnel_token**. Save and restart. The log says `Cloudflare tunnel starting for …`
   and then `Registered tunnel connection`.

At home, keep using **url** and Recipes in the sidebar as before. If the tunnel stops, Norish
keeps running at home and the add-on retries the tunnel every minute.

What each sign-in protects: Cloudflare's email code decides who can reach Norish at
all. Norish's own sign-in decides whose recipes they see. Norish's share links and
its phone app also meet the email code first, so they only work for the emails you
allowed.

## Options

| Option | What it does |
| --- | --- |
| `url` | The address Norish is opened at (Norish's sign-in needs it exact). |
| `extra_origins` | Other addresses Norish is also opened at, e.g. `http://192.168.1.10:3000`. |
| `backup_repo` | The private GitHub repo for the nightly backup. Not set turns the backup off. |
| `backup_token` | A Norish API token from an admin account. |
| `backup_time` | When the nightly backup runs (HH:MM, Home Assistant's time zone). |
| `public_url` | The Cloudflare address Norish is opened at from anywhere. Not set = home only. |
| `tunnel_token` | The Cloudflare Tunnel token. Not set = no tunnel. |
| `ha_users` | HA users signed in to Norish without its sign-in when they open Recipes from the sidebar (HA user name or ID, and their Norish email). |

## What is inside

Norish's published image (pinned as `BUILD_FROM` in the `Dockerfile`), plus Postgres 17, Redis, nginx
and Cloudflare's tunnel client (`cloudflared`, which only runs with a token).
The link-import browser (Norish's Obscura build) runs inside the add-on too. If it
cannot start, Norish still runs and only link imports fail. Everything is kept in the
add-on's data folder, which Home Assistant backups include. The add-on stops for the few
seconds a backup takes, so the database copy is consistent.

## Switching to your own fork later

Point `BUILD_FROM` in the `Dockerfile` at your fork's image (e.g. `ghcr.io/you/norish:tag`),
bump `version` in `config.yaml`, and rebuild. The data folder is kept, and Norish
upgrades its database on start.
