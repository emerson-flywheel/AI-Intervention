// The Bots door (0.4.5): where a bot added under Settings › Bots calls in. It listens only
// while a bot is active (bots.mjs doorWanted), on its own port (7690), and is the only thing
// Tailscale serves (tailscale.mjs). It offers:
//   POST /mcp              MCP over Streamable HTTP (JSON answers, no event stream)
//   GET  /v1/tools         the tools of the caller's level
//   POST /v1/tools/<name>  one tool, its arguments as the JSON body
// Every request carries the bot's key (Authorization: Bearer <key>). The app makes the call
// to Home Assistant with its own token after checking the bot's level, so a bot never holds
// a Home Assistant token. Nothing here can reach the page, the Console, the Bots settings,
// the app's own files or options, or a shell. Each call is one line in /data/bots.log, and a
// change also goes in Home Assistant's logbook as "<bot> (bot)".
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, getDataDir, logCall, slowFor } from './bots.mjs';
import { sleep } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const HA = () => env.HA_API || 'http://supervisor/core/api';
const SUP = () => env.SUPERVISOR_API || 'http://supervisor';
const SNAPSHOT = join(HERE, 'snapshot.sh');
const VERSION = '0.4.5';
const BODY_CAP = 1 << 20;
const FILE_CAP = 512 << 10;

let haDir = env.ADDON_HA_DIR || '/homeassistant';
export function setHaDir(dir) {
  haDir = dir;
}
let address = { port: Number(env.ADDON_BOTS_PORT ?? 7690), host: env.ADDON_BOTS_HOST || '0.0.0.0' };
export function setDoorAddress(a) {
  address = a;
}

class Refusal extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const RANK = { read: 1, control: 2, admin: 3 };
const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const WORD_RE = /^[a-z0-9_]{1,64}$/;
const UNSCOPED = ['area_id', 'device_id', 'label_id', 'floor_id', 'target'];

async function haCall(path, { method = 'GET', body, base = HA() } = {}) {
  let r;
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN || ''}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30e3),
    });
  } catch {
    throw new Refusal('no-ha', 502);
  }
  const text = await r.text();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {}
  if (!r.ok) throw Object.assign(new Refusal(`ha-${r.status}`, 502), { detail: value });
  return value;
}

// The entities a Read only or Control bot covers: those of its areas and labels.
async function scopeOf(bot) {
  if (bot.level === 'admin') return null;
  const parts = [
    ...bot.areas.filter((a) => WORD_RE.test(a)).map((a) => `area_entities('${a}')`),
    ...bot.labels.filter((l) => WORD_RE.test(l)).map((l) => `label_entities('${l}')`),
  ];
  if (!parts.length) return new Set();
  const out = await haCall('/template', { method: 'POST', body: { template: `{{ ((${parts.join(' + ')}) | unique | list) | tojson }}` } });
  const list = typeof out === 'string' ? JSON.parse(out) : out;
  return new Set(Array.isArray(list) ? list.filter((e) => typeof e === 'string') : []);
}

const inScope = (scope, id) => scope === null || scope.has(id);
const entityArg = (id, required) => {
  if (id === undefined && !required) return undefined;
  if (typeof id !== 'string' || !ENTITY_RE.test(id)) throw new Refusal('bad-entity', 400);
  return id;
};
const hoursArg = (h) => {
  const n = h === undefined ? 24 : Number(h);
  if (!Number.isFinite(n) || n <= 0 || n > 168) throw new Refusal('bad-hours', 400);
  return n;
};
const since = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();

function note(bot, message, entityId) {
  // Home Assistant's logbook, as done by the bot. A failure here never fails the call.
  return haCall('/services/logbook/log', {
    method: 'POST',
    body: { name: `${bot.name} (bot)`, message: message.slice(0, 250), ...(entityId ? { entity_id: entityId } : {}) },
  }).catch(() => {});
}

// A path in the config folder: relative to it, or absolute inside it; links followed.
function configPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) throw new Refusal('bad-path', 400);
  const root = realpathSync(haDir);
  const full = resolve(root, isAbsolute(p) ? p : join('.', p));
  let real;
  try {
    real = realpathSync(full);
  } catch {
    try {
      real = join(realpathSync(dirname(full)), full.slice(dirname(full).length + 1));
    } catch {
      throw new Refusal('outside-config');
    }
  }
  if (real !== root && !real.startsWith(root + sep)) throw new Refusal('outside-config');
  if (real === root) throw new Refusal('bad-path', 400);
  return real;
}

// The Supervisor paths no level may use: this app itself (its options hold its sign-in),
// backup downloads (they hold every app's data), and the Supervisor's own auth.
function supervisorPath(p) {
  if (typeof p !== 'string' || !/^\/[A-Za-z0-9_.\-/]{0,200}$/.test(p) || p.includes('//')) throw new Refusal('bad-path', 400);
  if (p.split('/').some((s) => s === '..' || s === '.')) throw new Refusal('bad-path');
  if (/^\/(addons|store\/addons)\/(self|[a-z0-9]*_?claude_code)(\/|$)/i.test(p)) throw new Refusal('this-app');
  if (/^\/backups\/[^/]+\/download/.test(p) || /^\/auth(\/|$)/.test(p)) throw new Refusal('private');
  return p;
}

// The tools, each with the lowest level that may use it.
export const TOOLS = {
  get_states: {
    level: 'read',
    description: 'Current state of one entity, or of every entity this bot may see.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } } },
    async run(bot, args) {
      const scope = await scopeOf(bot);
      const id = entityArg(args.entity_id, false);
      if (id) {
        if (!inScope(scope, id)) throw new Refusal('out-of-scope');
        return { target: id, result: await haCall(`/states/${id}`) };
      }
      const all = await haCall('/states');
      return { target: 'all', result: (Array.isArray(all) ? all : []).filter((s) => inScope(scope, s?.entity_id)) };
    },
  },
  get_history: {
    level: 'read',
    description: 'State history of one entity over the last hours (default 24, at most 168).',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, hours: { type: 'number' } }, required: ['entity_id'] },
    async run(bot, args) {
      const id = entityArg(args.entity_id, true);
      const hours = hoursArg(args.hours);
      if (!inScope(await scopeOf(bot), id)) throw new Refusal('out-of-scope');
      return { target: id, result: await haCall(`/history/period/${encodeURIComponent(since(hours))}?filter_entity_id=${id}&minimal_response`) };
    },
  },
  get_logbook: {
    level: 'read',
    description: 'Logbook entries over the last hours (default 24, at most 168): of one entity, or (Admin) of everything.',
    inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, hours: { type: 'number' } } },
    async run(bot, args) {
      const scope = await scopeOf(bot);
      const id = entityArg(args.entity_id, scope !== null);
      const hours = hoursArg(args.hours);
      if (id && !inScope(scope, id)) throw new Refusal('out-of-scope');
      return { target: id || 'all', result: await haCall(`/logbook/${encodeURIComponent(since(hours))}${id ? `?entity=${id}` : ''}`) };
    },
  },
  call_service: {
    level: 'control',
    description: 'Call a Home Assistant action (service). Control bots: name entity_id (one or a list) in their areas or labels; the action must be of the entity\'s own domain, or homeassistant.turn_on / turn_off / toggle.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' }, service: { type: 'string' },
        entity_id: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        data: { type: 'object' },
      },
      required: ['domain', 'service'],
    },
    async run(bot, args) {
      const { domain, service } = args;
      if (!WORD_RE.test(domain || '') || !WORD_RE.test(service || '')) throw new Refusal('bad-service', 400);
      const data = args.data === undefined ? {} : args.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Refusal('bad-data', 400);
      const given = [args.entity_id, data.entity_id].filter((x) => x !== undefined).flatMap((x) => (Array.isArray(x) ? x : [x]));
      const ids = [...new Set(given)];
      if (bot.level !== 'admin') {
        if (UNSCOPED.some((k) => k in data) || !ids.length || ids.some((x) => x === 'all')) throw new Refusal('out-of-scope');
        ids.forEach((x) => entityArg(x, true));
        const scope = await scopeOf(bot);
        if (!ids.every((x) => inScope(scope, x))) throw new Refusal('out-of-scope');
        const generic = domain === 'homeassistant' && ['turn_on', 'turn_off', 'toggle'].includes(service);
        if (!generic && !ids.every((x) => x.split('.')[0] === domain)) throw new Refusal('out-of-scope');
      } else {
        ids.forEach((x) => (x === 'all' ? x : entityArg(x, true)));
      }
      const body = { ...data };
      delete body.entity_id;
      if (ids.length) body.entity_id = ids;
      const target = `${domain}.${service}${ids.length ? ` ${ids.join(',')}` : ''}`;
      const result = await haCall(`/services/${domain}/${service}`, { method: 'POST', body });
      await note(bot, `called ${target}`, ids.length === 1 && ids[0] !== 'all' ? ids[0] : undefined);
      return { target, result };
    },
  },
  supervisor: {
    level: 'admin',
    description: 'Call the Home Assistant Supervisor API (apps, backups, updates, restarts): method GET or POST and a path such as /addons or /core/restart. This app itself is out of reach.',
    inputSchema: {
      type: 'object',
      properties: { method: { type: 'string', enum: ['GET', 'POST'] }, path: { type: 'string' }, body: { type: 'object' } },
      required: ['method', 'path'],
    },
    async run(bot, args) {
      const method = args.method;
      if (!['GET', 'POST'].includes(method)) throw new Refusal('bad-method', 400);
      const path = supervisorPath(args.path);
      const target = `${method} ${path}`;
      const result = await haCall(path, { method, body: method === 'POST' ? (args.body || {}) : undefined, base: SUP() });
      if (method === 'POST') await note(bot, `Supervisor ${target}`);
      return { target, result };
    },
  },
  read_file: {
    level: 'admin',
    description: 'Read a file in the Home Assistant config folder (a path relative to it, e.g. automations.yaml).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(bot, args) {
      const p = configPath(args.path);
      let st;
      try {
        st = statSync(p);
      } catch {
        throw new Refusal('no-file', 404);
      }
      if (!st.isFile()) throw new Refusal('not-a-file', 400);
      if (st.size > FILE_CAP) throw new Refusal('too-big', 400);
      return { target: args.path, result: { path: args.path, content: readFileSync(p, 'utf8') } };
    },
  },
  write_file: {
    level: 'admin',
    description: 'Write a file in the Home Assistant config folder. The folder is snapshotted first, so the change can be undone.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    async run(bot, args) {
      const p = configPath(args.path);
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > FILE_CAP) throw new Refusal('bad-content', 400);
      if (existsSync(p) && !statSync(p).isFile()) throw new Refusal('not-a-file', 400);
      if (!existsSync(dirname(p))) throw new Refusal('no-folder', 400);
      await snapshot();
      writeFileSync(p, args.content);
      await note(bot, `edited ${args.path}`);
      return { target: args.path, result: { written: Buffer.byteLength(args.content) } };
    },
  },
};

function snapshot() {
  return new Promise((done) => {
    const child = execFile(SNAPSHOT, [], { env: { ...env, ADDON_HA_DIR: haDir, ADDON_DATA: getDataDir() }, timeout: 60e3 }, () => done());
    child.stdin?.end();
  });
}

const toolsFor = (bot) => Object.entries(TOOLS).filter(([, t]) => RANK[bot.level] >= RANK[t.level]);

// One tool call, checked: { status, body, target, result } where result is what is logged.
async function useTool(bot, name, args) {
  if (!Object.hasOwn(TOOLS, name)) throw new Refusal('no-tool', 404);
  const tool = TOOLS[name];
  if (RANK[bot.level] < RANK[tool.level]) throw new Refusal('level');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refusal('bad-arguments', 400);
  return tool.run(bot, args);
}

function readBody(req) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_CAP) {
        done({ tooBig: true });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return done({ value: {} });
      try {
        done({ value: JSON.parse(text) });
      } catch {
        done({ bad: true });
      }
    });
    req.on('error', () => done({ bad: true }));
  });
}

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const toolPath = /^\/v1\/tools\/([A-Za-z0-9_]{1,64})$/.exec(path);
  const known = path === '/mcp' || path === '/v1/tools' || toolPath;
  if (!known) return send(res, 404, { error: 'not-found' });
  if (path === '/mcp' && req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (toolPath && req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (path === '/v1/tools' && req.method !== 'GET') return send(res, 405, { error: 'method' });

  const body = req.method === 'POST' ? await readBody(req) : { value: {} };
  const rpc = path === '/mcp' && body.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value : null;
  let action = toolPath ? toolPath[1] : path === '/v1/tools' ? 'tools/list' : String(rpc?.method || 'mcp');
  if (rpc?.method === 'tools/call' && typeof rpc.params?.name === 'string') action = rpc.params.name;

  const auth = authenticate(req.headers.authorization);
  if (auth.refused) {
    logCall({ action, result: `refused:${auth.refused}` });
    if (auth.refused === 'bad-key') await sleep(slowFor());
    return send(res, auth.refused === 'blocked' ? 429 : 401, { error: auth.refused });
  }
  const { bot } = auth;
  const done = (result, target = '') => logCall({ bot: bot.name, action, target, result });

  if (body.tooBig) {
    done('refused:too-big');
    return send(res, 413, { error: 'too-big' });
  }
  if (body.bad) {
    done('refused:bad-json');
    return send(res, 400, { error: 'bad-json' });
  }

  if (path === '/v1/tools') {
    done('allowed');
    return send(res, 200, { tools: toolsFor(bot).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  }

  if (toolPath) {
    try {
      const out = await useTool(bot, toolPath[1], body.value);
      done('allowed', out.target);
      return send(res, 200, { ok: true, result: out.result });
    } catch (err) {
      const r = err instanceof Refusal ? err : new Refusal('failed', 500);
      done(`refused:${r.code}`);
      return send(res, r.status, { error: r.code });
    }
  }

  // MCP: one JSON-RPC message per request.
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    done('refused:bad-request');
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const id = rpc.id;
  if (id === undefined) {
    // a notification (initialized, cancelled): nothing to answer
    done('allowed');
    res.writeHead(202);
    return res.end();
  }
  const reply = (result) => send(res, 200, { jsonrpc: '2.0', id, result });
  const params = rpc.params && typeof rpc.params === 'object' ? rpc.params : {};
  if (rpc.method === 'initialize') {
    done('allowed');
    return reply({
      protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ai-intervention-bots', version: VERSION },
      instructions: `You are "${bot.name}", at the ${bot.level} level. Home Assistant is reached only through these tools.`,
    });
  }
  if (rpc.method === 'ping') {
    done('allowed');
    return reply({});
  }
  if (rpc.method === 'tools/list') {
    done('allowed');
    return reply({ tools: toolsFor(bot).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (rpc.method === 'tools/call') {
    try {
      const out = await useTool(bot, String(params.name), params.arguments ?? {});
      done('allowed', out.target);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out.result) }], isError: false });
    } catch (err) {
      const r = err instanceof Refusal ? err : new Refusal('failed', 500);
      done(`refused:${r.code}`);
      return reply({ content: [{ type: 'text', text: `Refused: ${r.code}` }], isError: true });
    }
  }
  done('refused:no-method');
  return send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

// --- Listening only while a bot is active ---

let server = null;
let syncing = Promise.resolve();

export function closeDoor() {
  const s = server;
  server = null;
  if (!s) return Promise.resolve();
  return new Promise((done) => {
    s.close(() => done());
    s.closeAllConnections?.();
  });
}

// Open or close the door to match the bots: returns whether it now listens.
export function syncDoor(wanted) {
  syncing = syncing.then(async () => {
    const want = wanted ?? (await import('./bots.mjs')).doorWanted();
    if (want && !server) {
      const s = http.createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, { error: 'failed' }));
      });
      await new Promise((done, fail) => {
        s.once('error', fail);
        s.listen(address.port, address.host, done);
      });
      server = s;
    } else if (!want && server) {
      await closeDoor();
    }
    return Boolean(server);
  }).catch(() => Boolean(server));
  return syncing;
}
