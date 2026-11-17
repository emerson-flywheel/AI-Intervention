// End-to-end test of ha-sso.mjs against a stand-in Norish built from the same better-auth
// version and genericOAuth settings Norish v0.25.1-beta uses, behind a stand-in for the
// add-on's nginx routing (:3000 exact paths, :8099 = ingress).
// Usage: node ha-sso.test.mjs <path to ha-sso.mjs> <deps dir with better-auth>
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const [SSO, DEPS] = process.argv.slice(2);
const req = createRequire(`${DEPS}/package.json`);
const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
const { betterAuth } = await imp("better-auth");
const { memoryAdapter } = await imp("better-auth/adapters/memory");
const { genericOAuth } = await imp("better-auth/plugins");
const { toNodeHandler } = await imp("better-auth/node");
const { decodeJwt, createRemoteJWKSet, jwtVerify } = await imp("jose");

const P = { front: 23000, norish: 23001, home: 23003, ing: 23004, ingress: 28099 };
const URL_BASE = `http://127.0.0.1:${P.front}`;
const SECRET = randomBytes(24).toString("hex"); // made per run
const ALEX = "alex@example.test";

// --- ha-sso ---------------------------------------------------------------------------
const logs = [];
const sso = spawn(process.execPath, [SSO], {
    env: {
        HA_SSO_URL: URL_BASE,
        HA_SSO_CLIENT_SECRET: SECRET,
        HA_SSO_HOME_PORT: String(P.home),
        HA_SSO_INGRESS_PORT: String(P.ing),
        HA_SSO_USERS: JSON.stringify([
            { ha_user: "Alex", email: "Alex@Example.test" },
            { ha_user: "ghost", email: "nobody@example.test" },
        ]),
    },
});
sso.stdout.on("data", (d) => logs.push(String(d)));
sso.stderr.on("data", (d) => logs.push(String(d)));

// --- stand-in Norish -------------------------------------------------------------------
const db = { user: [], session: [], account: [], verification: [] };
const discoveryUrl = `http://127.0.0.1:${P.home}/.well-known/openid-configuration`;
const auth = betterAuth({
    database: memoryAdapter(db),
    secret: randomBytes(24).toString("hex"),
    baseURL: URL_BASE,
    trustedOrigins: [URL_BASE],
    emailAndPassword: { enabled: true },
    account: { accountLinking: { enabled: true, trustedProviders: ["oidc", "google", "github"] } },
    databaseHooks: {
        user: {
            create: {
                before: async () => {
                    if (db.user.length > 0) throw new Error("Registration is disabled"); // Norish: closed after the first user
                },
            },
        },
    },
    plugins: [
        genericOAuth({
            config: [
                {
                    providerId: "oidc",
                    discoveryUrl,
                    clientId: "norish",
                    clientSecret: SECRET,
                    scopes: ["openid", "profile", "email"],
                    pkce: true,
                    // Norish's getUserInfo: decode the id token, merge userinfo.
                    getUserInfo: async (tokens) => {
                        const idc = tokens.idToken ? decodeJwt(tokens.idToken) : {};
                        const d = await (await fetch(discoveryUrl)).json();
                        const ui = await (
                            await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.accessToken}` } })
                        ).json();
                        const p = { ...ui, ...idc };
                        return { id: p.sub, email: p.email, name: p.name, emailVerified: p.email_verified ?? false };
                    },
                },
            ],
        }),
    ],
});
const norish = createServer(toNodeHandler(auth)).listen(P.norish, "127.0.0.1");

// --- stand-in nginx --------------------------------------------------------------------
function proxy(res, port, path, req, extraHeaders = {}) {
    const up = httpRequest(
        { host: "127.0.0.1", port, path, method: req.method, headers: { ...req.headers, ...extraHeaders } },
        (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        },
    );
    req.pipe(up);
}
const front = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/ha-sso/start" || u.pathname === "/ha-sso/authorize") return proxy(res, P.home, u.pathname + u.search, req);
    if (u.pathname.startsWith("/api/auth/")) return proxy(res, P.norish, req.url, req);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>norish page</title>");
}).listen(P.front, "127.0.0.1");
// Ingress: Supervisor sets X-Remote-User-* from the HA session (and drops a browser's own).
const ingress = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/") return res.writeHead(404).end();
    proxy(res, P.ing, "/", req);
}).listen(P.ingress, "127.0.0.1");

await new Promise((r) => setTimeout(r, 800));

// --- a browser: cookie jar, manual redirects, runs the start page's script ------------
class Browser {
    jar = new Map();
    cookieHeader() {
        return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    async fetch(url, opts = {}) {
        url = new URL(url, URL_BASE).toString();
        const r = await fetch(url, {
            ...opts,
            redirect: "manual",
            headers: { origin: URL_BASE, ...(opts.headers || {}), cookie: this.cookieHeader() },
        });
        for (const c of r.headers.getSetCookie()) {
            const [kv, ...attrs] = c.split(";");
            const i = kv.indexOf("=");
            const k = kv.slice(0, i).trim(),
                v = kv.slice(i + 1).trim();
            if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === "") this.jar.delete(k);
            else this.jar.set(k, v);
        }
        return r;
    }
    async follow(url, max = 10) {
        let r = await this.fetch(url);
        while ([301, 302, 303, 307].includes(r.status) && max--) {
            url = new URL(r.headers.get("location"), url).toString();
            r = await this.fetch(url);
        }
        return { r, url };
    }
    async runPage(html) {
        const m = /<script>([\s\S]*)<\/script>/.exec(html);
        let target = null;
        const self = this;
        const ctx = {
            fetch: async (u, o = {}) => self.fetch(u, o),
            location: { replace: (u) => (target = u) },
            JSON,
            String,
        };
        await vm.runInNewContext(m[1], ctx);
        for (let i = 0; i < 50 && !target; i++) await new Promise((r) => setTimeout(r, 20));
        return target;
    }
    async session() {
        const r = await this.fetch("/api/auth/get-session");
        return r.json();
    }
}

async function haSidebar(browser, haUser) {
    const r = await fetch(`http://127.0.0.1:${P.ingress}/`, {
        headers: { "x-remote-user-id": haUser.id, "x-remote-user-name": haUser.name, "x-remote-user-display-name": haUser.display },
    });
    const html = await r.text();
    return /<iframe src="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
}

async function signInViaStart(browser, src) {
    const r = await browser.fetch(src);
    const html = await r.text();
    if (r.status !== 200) return { status: r.status, html };
    const next = await browser.runPage(html);
    if (!next || next === "/" || next === "/login") return { next };
    const { r: end, url } = await browser.follow(next);
    return { next, end, url };
}

const results = [];
async function gate(name, fn) {
    try {
        await fn();
        results.push(`PASS ${name}`);
    } catch (e) {
        results.push(`FAIL ${name}: ${e.message}`);
    }
}

// Alex's Norish account (password), made first like the real one.
const alexPw = randomBytes(12).toString("hex");
const kidPw = randomBytes(12).toString("hex");
const setup = await auth.api.signUpEmail({ body: { email: ALEX, password: alexPw, name: "Alex" } });
const alexId = setup.user.id;
const HA_ALEX = { id: "0123abcd", name: "alex", display: "Alex E" };

await gate("G1a first open from HA: not linked yet -> one-time page, no session, no new user", async () => {
    const b = new Browser();
    const out = await signInViaStart(b, await haSidebar(b, HA_ALEX));
    assert.ok(out.url, JSON.stringify(out));
    const u = new URL(out.url);
    assert.equal(u.pathname + "?" + u.searchParams.toString(), "/ha-sso/start?error=account_not_linked");
    assert.match(await out.end.text(), /One time only/);
    assert.equal((await b.session())?.user, undefined);
    assert.equal(db.user.length, 1);
    assert.equal(db.account.filter((x) => x.providerId === "oidc").length, 0);
});

await gate("G1b password once in the panel, reopen Recipes -> HA sign-in linked to that same account", async () => {
    const b = new Browser();
    const pw = await b.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ALEX, password: alexPw }),
    });
    assert.equal(pw.status, 200);
    const out = await signInViaStart(b, await haSidebar(b, HA_ALEX));
    assert.ok(out.end, JSON.stringify(out));
    assert.equal(new URL(out.url).pathname, "/", `landed on ${out.url}`);
    const linked = db.account.filter((x) => x.providerId === "oidc");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].userId, alexId);
    assert.equal(linked[0].accountId, HA_ALEX.id);
    assert.equal(db.user.find((u) => u.id === alexId).name, "Alex", "name changed by linking");
    // reopen: already signed in and linked -> straight to /
    const again = await signInViaStart(b, await haSidebar(b, HA_ALEX));
    assert.equal(again.next, "/");
});

await gate("G1c after linking: HA sidebar on a fresh browser -> signed in as Alex, no password", async () => {
    const b = new Browser();
    const out = await signInViaStart(b, await haSidebar(b, HA_ALEX));
    assert.ok(out.end, JSON.stringify(out));
    assert.equal(new URL(out.url).pathname, "/", `landed on ${out.url}`);
    const s = await b.session();
    assert.equal(s?.user?.id, alexId);
    assert.equal(db.user.length, 1, "a new user was made");
});

await gate("G1d signed in as someone else in the panel -> switched to the HA user's account", async () => {
    // stand-in: a second Norish user made by the admin (registration closed for the public)
    db.user.push({ id: "u2", email: "kid@example.test", name: "Kid", emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    const ctx = await auth.$context;
    await ctx.password.hash(kidPw).then((h) =>
        ctx.internalAdapter.createAccount({ userId: "u2", providerId: "credential", accountId: "u2", password: h }),
    );
    const b = new Browser();
    await b.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "kid@example.test", password: kidPw }),
    });
    assert.equal((await b.session())?.user?.id, "u2");
    const out = await signInViaStart(b, await haSidebar(b, HA_ALEX));
    assert.ok(out.end, JSON.stringify(out));
    assert.equal((await b.session())?.user?.id, alexId);
});

await gate("G2 direct address, other device -> HA sign-in refused, no session (red case)", async () => {
    const b = new Browser();
    const r = await b.fetch("/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "oidc", callbackURL: "/" }),
    });
    const { url } = await r.json();
    assert.match(url, /\/ha-sso\/authorize\?/);
    const a = await b.fetch(url);
    assert.equal(a.status, 403);
    assert.match(await a.text(), /only from <b>Recipes<\/b>/);
    assert.equal((await b.session())?.user, undefined);
});

await gate("G3 direct address -> Norish's password sign-in still works", async () => {
    const b = new Browser();
    const r = await b.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ALEX, password: alexPw }),
    });
    assert.equal(r.status, 200);
    assert.equal((await b.session())?.user?.id, alexId);
});

await gate("G4 a ticket works once; a copied link on another device is refused", async () => {
    const b1 = new Browser();
    const src = await haSidebar(b1, HA_ALEX);
    await signInViaStart(b1, src);
    const b2 = new Browser();
    const r = await b2.fetch(src);
    assert.equal(r.status, 403);
    assert.equal((await b2.session())?.user, undefined);
});

await gate("G5 HA user not in ha_users -> plain Norish (its sign-in), no ticket", async () => {
    const src = await haSidebar(new Browser(), { id: "ffff", name: "guest", display: "Guest" });
    assert.equal(src, `${URL_BASE}/`);
});

await gate("G6 listed HA user whose email has no Norish account -> no account made", async () => {
    const b = new Browser();
    const out = await signInViaStart(b, await haSidebar(b, { id: "9999", name: "ghost", display: "Ghost" }));
    assert.equal((await b.session())?.user, undefined);
    assert.equal(db.user.filter((u) => u.email === "nobody@example.test").length, 0);
    assert.ok(out.url && new URL(out.url).pathname === "/ha-sso/start", `ended at ${out.url}`);
});

await gate("G7 token endpoint: wrong secret, wrong PKCE verifier, replayed code all refused", async () => {
    // Get a real code by hand.
    const b = new Browser();
    const src = await haSidebar(b, HA_ALEX);
    await b.fetch(src); // sets ha_sso cookie
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // S256 of the RFC 7636 example verifier
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const az = await b.fetch(
        `/ha-sso/authorize?response_type=code&client_id=norish&redirect_uri=${encodeURIComponent(URL_BASE + "/api/auth/oauth2/callback/oidc")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    assert.equal(az.status, 302);
    const code = new URL(az.headers.get("location")).searchParams.get("code");
    const tok = (body) =>
        fetch(`http://127.0.0.1:${P.home}/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(body),
        });
    const base = { grant_type: "authorization_code", code, redirect_uri: URL_BASE + "/api/auth/oauth2/callback/oidc", client_id: "norish" };
    assert.equal((await tok({ ...base, client_secret: "wrong", code_verifier: verifier })).status, 401);
    assert.equal((await tok({ ...base, client_secret: SECRET, code_verifier: "x".repeat(43) })).status, 400);
    // the bad verifier used the code up; a fresh code with the right verifier works, then replays fail
    const src2 = await haSidebar(b, HA_ALEX);
    await b.fetch(src2);
    const az2 = await b.fetch(`/ha-sso/authorize?response_type=code&client_id=norish&redirect_uri=${encodeURIComponent(URL_BASE + "/api/auth/oauth2/callback/oidc")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`);
    const code2 = new URL(az2.headers.get("location")).searchParams.get("code");
    const ok = await tok({ ...base, code: code2, client_secret: SECRET, code_verifier: verifier });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    const jwks = createRemoteJWKSet(new URL(`http://127.0.0.1:${P.home}/jwks`));
    const v = await jwtVerify(j.id_token, jwks, { issuer: `http://127.0.0.1:${P.home}`, audience: "norish" });
    assert.equal(v.payload.email, ALEX);
    assert.equal((await tok({ ...base, code: code2, client_secret: SECRET, code_verifier: verifier })).status, 400);
});

await gate("G8 authorize never redirects to a foreign redirect_uri", async () => {
    const b = new Browser();
    await b.fetch(await haSidebar(b, HA_ALEX));
    const r = await b.fetch(
        `/ha-sso/authorize?response_type=code&client_id=norish&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&state=s&code_challenge=abc&code_challenge_method=S256`,
    );
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("location"), null);
});

await gate("G9 no secret in ha-sso's log", async () => {
    const all = logs.join("");
    assert.ok(!all.includes(SECRET));
    assert.ok(all.includes("Home Assistant sign-in passed for alex@example.test"), "planted check: log has the sign-in line");
});

console.log(results.join("\n"));
console.log("--- ha-sso log ---\n" + logs.join("").trim());
sso.kill();
norish.close();
front.close();
ingress.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
