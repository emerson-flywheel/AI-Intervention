// Settings › Tools: extras Claude may use. Each is a change to Claude Code's own settings
// file (/data/claude/settings.json), made and taken back by this page only, keeping every
// other setting in it:
//   snapshot  a PreToolUse hook (snapshot.sh) that saves a local git history of
//             /homeassistant before each file edit Claude makes, so a change can be undone
//   web       Claude Code's web search and fetch; off adds deny rules for them
// A settings file that is not JSON is left alone and nothing is written.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from './lib.mjs';

let claudeDir = CLAUDE_DIR;
// The tests point it at a sandbox.
export function setClaudeDir(dir) {
  claudeDir = dir;
}
const file = () => join(claudeDir, 'settings.json');

export const SNAPSHOT = '/opt/addon-agent/snapshot.sh';
const SNAPSHOT_HOOK = {
  matcher: 'Edit|MultiEdit|Write|NotebookEdit',
  hooks: [{ type: 'command', command: SNAPSHOT, timeout: 60 }],
};
const WEB = ['WebSearch', 'WebFetch'];

export const TOOLS = [
  {
    id: 'snapshot',
    label: 'Snapshot before edits',
    description: 'Saves a copy of your config (/homeassistant) before each file Claude changes, in a local history, so any change can be undone. Ask Claude to "undo your last change".',
  },
  {
    id: 'web',
    label: 'Web search',
    description: 'Lets Claude look up integration docs and error messages on the web. It still asks before it opens a page.',
  },
];

export class ToolsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ours = (entry) => isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((h) => h?.command === SNAPSHOT);

function read() {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'));
    return isObject(v) ? { value: v } : { unreadable: true };
  } catch (err) {
    return err.code === 'ENOENT' ? { value: {} } : { unreadable: true };
  }
}

function on(settings) {
  const pre = settings.hooks?.PreToolUse;
  const deny = settings.permissions?.deny;
  return {
    snapshot: Array.isArray(pre) && pre.some(ours),
    web: !(Array.isArray(deny) && WEB.some((w) => deny.includes(w))),
  };
}

export function toolsState() {
  const f = read();
  const now = on(f.unreadable ? {} : f.value);
  return TOOLS.map((t) => ({ ...t, on: now[t.id] }));
}

// Save the switches. changed: Claude in the Console must start again to use them.
export function saveTools({ snapshot, web } = {}) {
  if (typeof snapshot !== 'boolean' || typeof web !== 'boolean') throw new ToolsError('bad-tools');
  const f = read();
  if (f.unreadable) throw new ToolsError('settings-unreadable');
  const now = on(f.value);
  if (now.snapshot === snapshot && now.web === web) return { changed: false };
  const next = structuredClone(f.value);
  const hooks = isObject(next.hooks) ? next.hooks : {};
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []).filter((e) => !ours(e));
  if (snapshot) pre.push(structuredClone(SNAPSHOT_HOOK));
  if (pre.length) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  const perms = isObject(next.permissions) ? next.permissions : {};
  const deny = (Array.isArray(perms.deny) ? perms.deny : []).filter((d) => !WEB.includes(d));
  if (!web) deny.push(...WEB);
  if (deny.length) perms.deny = deny;
  else delete perms.deny;
  if (Object.keys(perms).length) next.permissions = perms;
  else delete next.permissions;
  mkdirSync(claudeDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file());
  return { changed: true };
}
