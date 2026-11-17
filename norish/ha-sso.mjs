// Sign in to Norish with Home Assistant, only when opened from HA's sidebar.
//
// Norish has no trusted-header or "no login" setting; it signs people in with a password,
// OIDC, GitHub or Google. This is a minimal OIDC provider that Norish trusts, and it says
// yes only to a browser that just came through Home Assistant ingress:
//
//   1. HA sidebar "Recipes" (ingress panel) -> Supervisor checks the HA sign-in and adds
//      X-Remote-User-Id/-Name (it drops any a browser sends) -> nginx :8099 (Supervisor's
//      address only) -> INGRESS_PORT here. If that HA user is listed in ha_users, a ticket
//      (one use, 60 s) is made and the page frames <url>/ha-sso/start?ticket=...
//   2. /ha-sso/start (on :3000) swaps the ticket for a short cookie (one use, 120 s, path
//      /ha-sso), then starts Norish's own "Sign in with Home Assistant" (OIDC, with PKCE).
//   3. Norish sends the browser to /ha-sso/authorize. With the cookie: a code for the listed
//      Norish email. Without it (Norish opened directly, any device): refused, and Norish's
//      own sign-in page is the way in.
//   4. Norish swaps the code for tokens on 127.0.0.1 (client secret + PKCE) and signs in
//      the Norish account linked to that HA user. Registration stays closed, so an email
//      Norish doesn't know signs no one in.
//
// Linking, once per person: Norish doesn't mark password accounts' emails as verified, so
// better-auth won't attach a new sign-in to one on its own (and it shouldn't). The first
// time, the person signs in to Norish with their password inside the Recipes panel; the next
// time they open Recipes, step 2 sees them signed in as the listed email and links their
// HA sign-in to that account (better-auth's /oauth2/link: their session + this HA proof).
//
// HOME_PORT carries steps 2-4: nginx :3000 passes it only /ha-sso/start and
// /ha-sso/authorize; discovery, token, userinfo and keys are reached by Norish on
// 127.0.0.1 only. INGRESS_PORT is reached only from nginx :8099.
//
// Env: HA_SSO_URL (Norish's url), HA_SSO_USERS (JSON [{ha_user, email}]),
//      HA_SSO_CLIENT_SECRET, HA_SSO_HOME_PORT (3003), HA_SSO_INGRESS_PORT (3004).

import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";

const URL_BASE = (process.env.HA_SSO_URL || "").replace(/\/+$/, "");
const CLIENT_SECRET = process.env.HA_SSO_CLIENT_SECRET || "";
const HOME_PORT = Number(process.env.HA_SSO_HOME_PORT || 3003);
const INGRESS_PORT = Number(process.env.HA_SSO_INGRESS_PORT || 3004);
export const CLIENT_ID = "norish";
const ISSUER = `http://127.0.0.1:${HOME_PORT}`;
const REDIRECT_URI = `${URL_BASE}/api/auth/oauth2/callback/oidc`;

const TICKET_TTL = 60_000;
const COOKIE_TTL = 120_000;
const CODE_TTL = 60_000;
const TOKEN_TTL = 300_000;
const MAX_ENTRIES = 500;

const log = (msg) => console.log(`[ha-sso] ${msg}`);

function parseUsers(raw) {
    let list;
    try {
        list = JSON.parse(raw || "[]");
    } catch {
        log("ha_users is not valid; Home Assistant sign-in is off.");
        return [];
    }
    return (Array.isArray(list) ? list : [])
        .filter((u) => u && typeof u.ha_user === "string" && typeof u.email === "string")
        .map((u) => ({ ha_user: u.ha_user.trim().toLowerCase(), email: u.email.trim().toLowerCase() }))
        .filter((u) => u.ha_user && u.email);
}
const USERS = parseUsers(process.env.HA_SSO_USERS);

// One-use stores with expiry. Capped so nothing can grow them without bound.
class OneUse {
    constructor(ttl) {
        this.ttl = ttl;
        this.map = new Map();
    }
    put(value) {
        const now = Date.now();
        for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k);
        while (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
        const key = randomBytes(32).toString("base64url");
        this.map.set(key, { ...value, exp: now + this.ttl });
        return key;
    }
    take(key) {
        if (typeof key !== "string" || !key) return null;
        const v = this.map.get(key);
        this.map.delete(key);
        return v && v.exp > Date.now() ? v : null;
    }
    peek(key) {
        const v = typeof key === "string" ? this.map.get(key) : undefined;
        return v && v.exp > Date.now() ? v : null;
    }
}
const tickets = new OneUse(TICKET_TTL);
const handles = new OneUse(COOKIE_TTL);
const codes = new OneUse(CODE_TTL);
const accessTokens = new OneUse(TOKEN_TTL);

// A signing key per start; Norish fetches the public half each sign-in.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = randomBytes(8).toString("hex");
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

function idToken(claims) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${b64({ alg: "RS256", typ: "JWT", kid: KID })}.${b64(claims)}`;
    return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function sameSecret(a, b) {
    const x = createHash("sha256").update(String(a)).digest();
    const y = createHash("sha256").update(String(b)).digest();
    return timingSafeEqual(x, y) && a.length > 0;
}

const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...headers,
    });
    res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
const page = (res, status, title, inner, headers = {}) =>
    send(
        res,
        status,
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
            `<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}p{margin:2em;line-height:1.5}</style></head><body>${inner}</body></html>`,
        { "Content-Type": "text/html; charset=utf-8", ...headers },
    );

function cookie(req, name) {
    for (const part of (req.headers.cookie || "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return "";
}

function readBody(req, limit = 16_384) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error("too large"));
                req.destroy();
            } else chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// --- Ingress (from nginx :8099, which only Supervisor can reach) ---------------------
function ingress(req, res) {
    if (req.method !== "GET") return send(res, 405, "");
    const id = String(req.headers["x-remote-user-id"] || "").trim();
    const name = String(req.headers["x-remote-user-name"] || "").trim();
    const display = String(req.headers["x-remote-user-display-name"] || "").trim();
    const match = id && USERS.find((u) => u.ha_user === id.toLowerCase() || (name && u.ha_user === name.toLowerCase()));
    if (!match) {
        log(`Opened from Home Assistant by ${name || id || "an unknown user"}, who is not in ha_users: Norish's own sign-in is shown.`);
        return page(res, 200, "Norish", `<iframe src="${esc(URL_BASE)}/" allow="clipboard-write; fullscreen"></iframe>`);
    }
    const ticket = tickets.put({ email: match.email, sub: id, name: display || name || match.email });
    return page(
        res,
        200,
        "Norish",
        `<iframe src="${esc(URL_BASE)}/ha-sso/start?ticket=${ticket}" allow="clipboard-write; fullscreen"></iframe>`,
    );
}

// --- Home (from nginx :3000 for /ha-sso/start and /ha-sso/authorize; the rest is 127.0.0.1 for Norish) ---
const OFF_PAGE = (why) =>
    `<p><b>${esc(why)}</b><br>Signing in with Home Assistant works only from <b>Recipes</b> in Home Assistant&rsquo;s sidebar. ` +
    `Here, sign in with your Norish email and password: <a href="/login">Norish sign-in</a>.</p>`;

const FIRST_PAGE =
    `<p><b>One time only: sign in to Norish with your email and password.</b><br>` +
    `Your Home Assistant user isn&rsquo;t linked to your Norish account yet. ` +
    `<a href="/login?callbackUrl=%2F">Sign in to Norish</a>, then open <b>Recipes</b> from the sidebar again. ` +
    `That links them, and from then on Recipes signs you in by itself.</p>`;

function start(req, res, url) {
    const error = url.searchParams.get("error");
    if (error === "account_not_linked") return page(res, 200, "Norish", FIRST_PAGE);
    if (error) return page(res, 200, "Norish", OFF_PAGE(`Signing in with Home Assistant failed (${error}).`));
    const t = tickets.take(url.searchParams.get("ticket"));
    if (!t) return page(res, 403, "Norish", OFF_PAGE("This sign-in link has expired or was already used."));
    const handle = handles.put(t);
    // Signed in as this person: link their HA sign-in if it isn't yet, else straight in.
    // Signed in as someone else: sign out first. Not signed in: sign in with Home Assistant.
    const script = `(async () => {
  const want = ${JSON.stringify(t.email)};
  const opts = { credentials: "include", headers: { "content-type": "application/json" } };
  const go = async (path, body) => {
    const r = await fetch(path, { ...opts, method: "POST", body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    location.replace(j && j.url ? j.url : "/login");
  };
  let s = null;
  try { s = await (await fetch("/api/auth/get-session", { credentials: "include" })).json(); } catch (e) {}
  if (s && s.user && String(s.user.email || "").toLowerCase() === want) {
    let linked = false;
    try {
      const a = await (await fetch("/api/auth/list-accounts", { credentials: "include" })).json();
      linked = Array.isArray(a) && a.some((x) => x.providerId === "oidc");
    } catch (e) {}
    if (linked) { location.replace("/"); return; }
    return go("/api/auth/oauth2/link", { providerId: "oidc", callbackURL: "/", errorCallbackURL: "/ha-sso/start" });
  }
  if (s && s.user) { try { await fetch("/api/auth/sign-out", { ...opts, method: "POST", body: "{}" }); } catch (e) {} }
  return go("/api/auth/sign-in/oauth2", { providerId: "oidc", callbackURL: "/", errorCallbackURL: "/ha-sso/start" });
})();`;
    return page(res, 200, "Norish", `<p>Signing in&hellip;</p><script>${script}</script>`, {
        "Set-Cookie": `ha_sso=${handle}; Path=/ha-sso; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL / 1000}`,
    });
}

function authorize(req, res, url) {
    const q = url.searchParams;
    // Checked before any redirect, so this can never send a browser anywhere but Norish.
    if (q.get("client_id") !== CLIENT_ID || q.get("redirect_uri") !== REDIRECT_URI) {
        return page(res, 400, "Norish", "<p>Bad sign-in request.</p>");
    }
    const clear = { "Set-Cookie": "ha_sso=; Path=/ha-sso; HttpOnly; SameSite=Lax; Max-Age=0" };
    const back = new URL(REDIRECT_URI);
    const state = q.get("state");
    if (state) back.searchParams.set("state", state);
    back.searchParams.set("iss", ISSUER);
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        back.searchParams.set("error", "invalid_request");
        return send(res, 302, "", { Location: back.toString(), ...clear });
    }
    const who = handles.take(cookie(req, "ha_sso"));
    if (!who) {
        log("Home Assistant sign-in refused: not opened from the Home Assistant sidebar.");
        return page(res, 403, "Norish", OFF_PAGE("Not opened from Home Assistant."), clear);
    }
    const code = codes.put({ ...who, challenge: q.get("code_challenge"), nonce: q.get("nonce") || undefined });
    back.searchParams.set("code", code);
    log(`Home Assistant sign-in passed for ${who.email}.`);
    return send(res, 302, "", { Location: back.toString(), ...clear });
}

async function token(req, res) {
    if (req.method !== "POST") return send(res, 405, "");
    let form;
    try {
        form = new URLSearchParams(await readBody(req));
    } catch {
        return json(res, 400, { error: "invalid_request" });
    }
    let id = form.get("client_id") || "";
    let secret = form.get("client_secret") || "";
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
    if (basic) {
        const [u, p = ""] = Buffer.from(basic[1], "base64").toString().split(":");
        id = decodeURIComponent(u);
        secret = decodeURIComponent(p);
    }
    if (id !== CLIENT_ID || !sameSecret(secret, CLIENT_SECRET)) return json(res, 401, { error: "invalid_client" });
    if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
    const c = codes.take(form.get("code"));
    if (!c || form.get("redirect_uri") !== REDIRECT_URI) return json(res, 400, { error: "invalid_grant" });
    const verifier = form.get("code_verifier") || "";
    if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) {
        return json(res, 400, { error: "invalid_grant" });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: c.sub, email: c.email, email_verified: true, name: c.name };
    const access = accessTokens.put(claims);
    return json(res, 200, {
        access_token: access,
        token_type: "Bearer",
        expires_in: TOKEN_TTL / 1000,
        scope: "openid profile email",
        id_token: idToken({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: c.nonce, ...claims }),
    });
}

function userinfo(req, res) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    const t = m && accessTokens.peek(m[1]);
    if (!t) return json(res, 401, { error: "invalid_token" });
    const { exp, ...claims } = t;
    return json(res, 200, claims);
}

const DISCOVERY = {
    issuer: ISSUER,
    authorization_endpoint: `${URL_BASE}/ha-sso/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["openid", "profile", "email"],
    claims_supported: ["sub", "email", "email_verified", "name"],
};

async function home(req, res) {
    const url = new URL(req.url, "http://x");
    try {
        switch (url.pathname) {
            case "/ha-sso/start":
                return start(req, res, url);
            case "/ha-sso/authorize":
                return authorize(req, res, url);
            case "/.well-known/openid-configuration":
                return json(res, 200, DISCOVERY);
            case "/token":
                return await token(req, res);
            case "/userinfo":
                return userinfo(req, res);
            case "/jwks":
                return json(res, 200, { keys: [JWK] });
            default:
                return send(res, 404, "");
        }
    } catch (e) {
        log(`Error: ${e && e.message}`);
        if (!res.headersSent) send(res, 500, "");
    }
}

if (!URL_BASE || !CLIENT_SECRET) {
    log("Missing url or client secret; not starting.");
    process.exit(1);
}
createServer(home).listen(HOME_PORT, "127.0.0.1");
createServer(ingress).listen(INGRESS_PORT, "127.0.0.1");
log(`Home Assistant sign-in ready for ${USERS.length} user(s).`);
