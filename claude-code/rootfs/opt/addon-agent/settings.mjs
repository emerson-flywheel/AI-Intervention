// The seat on the Settings tab: the name the user gives it (kept in /data/seat.json), its
// provider, and that provider's model and thinking level. Anthropic (Claude Code) is the only
// provider this app runs. The table below is where another would go: OpenAI and Grok are
// listed (greyed out in the Provider list) but not run, since each needs its own program and
// sign-in in the image first.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, DATA } from './lib.mjs';
import { jarvisFile, withSnapshot } from './tools.mjs';

export class SettingsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const NAME_CAP = 40;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// A model name Claude Code itself may have saved (from /model in the Console): shown and
// kept as it is, never offered unless it is already there.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

// Claude Code's own settings file in the app's login folder: the same file /model and
// /effort in the Console write, so this page and the Console always agree. The model is
// "model"; the thinking level is "effortLevel", and Claude Code keeps it per model too
// (modelSettings.<model>.effortLevel), where it takes precedence for that model.
const claude = {
  file: () => join(CLAUDE_DIR, 'settings.json'),
  read(s) {
    const model = typeof s.model === 'string' && MODEL_ID_RE.test(s.model) ? s.model : '';
    const own = model && !RESERVED.has(model) ? s.modelSettings?.[model]?.effortLevel : undefined;
    const level = own ?? s.effortLevel;
    return { model, thinking: this.thinking.some((t) => t.id && t.id === level) ? level : '' };
  },
  // Default thinking clears the saved level for the new model and the one it replaces.
  write(s, { model, thinking }) {
    const out = { ...s };
    const per = isObject(out.modelSettings) ? { ...out.modelSettings } : {};
    const before = this.read(s).model;
    if (model) out.model = model;
    else delete out.model;
    if (thinking) out.effortLevel = thinking;
    else delete out.effortLevel;
    const touch = thinking ? [model] : [model, before];
    for (const m of new Set(touch.filter((x) => x && !RESERVED.has(x)))) {
      const mine = isObject(per[m]) ? { ...per[m] } : {};
      if (thinking) mine.effortLevel = thinking;
      else delete mine.effortLevel;
      if (Object.keys(mine).length) per[m] = mine;
      else delete per[m];
    }
    if (Object.keys(per).length) out.modelSettings = per;
    else delete out.modelSettings;
    return out;
  },
  // Full model ids, so the version shown is the one that runs whatever Claude Code the image
  // has. A short name (opus) saved by 0.3.4 or by /model still shows, as the newest.
  models: [
    { id: '', label: 'Default (your plan picks)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
  // "max" is left out: Claude Code keeps it for one session only and never saves it.
  thinking: [
    { id: '', label: 'Default' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
  ],
  // Permission levels, each saved as the permissions.defaultMode it stands for. The app runs
  // as root, so Claude Code refuses its unattended mode (bypassPermissions); Jarvis mode gets
  // there with allow rules for every tool instead, and its marker file (jarvis.json) lists
  // the rules it added, so leaving takes back only those. A mode set elsewhere that no level
  // stands for shows as Co-pilot and is kept.
  levels: [
    { id: 'wheels', label: 'Training wheels', mode: 'plan', description: 'Read only. Claude looks around and suggests, and changes nothing.' },
    { id: 'copilot', label: 'Co-pilot', mode: '', description: 'Claude asks before each change and each command.' },
    { id: 'autopilot', label: 'Autopilot', mode: 'acceptEdits', description: 'Claude edits files without asking, and still asks before running commands.' },
    { id: 'jarvis', label: 'Jarvis mode', mode: 'acceptEdits', description: 'Full admin. Claude edits files and runs commands without asking. Snapshot before edits stays on, so any change can be undone.' },
  ],
  jarvisAllow: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
  readLevel(s) {
    if (existsSync(jarvisFile())) return 'jarvis';
    const m = isObject(s.permissions) ? s.permissions.defaultMode : undefined;
    return this.levels.find((l) => l.id !== 'jarvis' && l.mode && l.mode === m)?.id ?? 'copilot';
  },
  // The settings for a new level, and what to do with Jarvis's marker: { added } to write
  // it, null to remove it, undefined to leave it.
  writeLevel(s, level, before) {
    const out = { ...s };
    const perms = isObject(out.permissions) ? { ...out.permissions } : {};
    let allow = Array.isArray(perms.allow) ? [...perms.allow] : [];
    let marker;
    if (before === 'jarvis' && level !== 'jarvis') {
      const added = readJson(jarvisFile()).value?.added;
      if (Array.isArray(added)) allow = allow.filter((r) => !added.includes(r));
      marker = null;
    }
    if (level === 'jarvis' && before !== 'jarvis') {
      const added = this.jarvisAllow.filter((r) => !allow.includes(r));
      allow.push(...added);
      marker = { added };
    }
    if (allow.length) perms.allow = allow;
    else delete perms.allow;
    const mode = this.levels.find((l) => l.id === level).mode;
    if (mode) perms.defaultMode = mode;
    else delete perms.defaultMode;
    if (Object.keys(perms).length) out.permissions = perms;
    else delete out.permissions;
    return { settings: marker ? withSnapshot(out) : out, marker };
  },
};

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', program: 'Claude Code', runs: true, settings: claude },
  openai: { label: 'OpenAI', program: null, runs: false, settings: null },
  grok: { label: 'Grok', program: null, runs: false, settings: null },
};

// A model id as a person reads it: claude-opus-5-5 is "Opus 5.5", claude-haiku-4-5-20251001
// is "Haiku 4.5", a [1m] ending adds "(1M context)", and a short name is the newest of its
// family. Anything else is shown as it is.
const FAMILIES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
const FULL_ID_RE = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;
const SHORT_ID_RE = /^(opus|sonnet|haiku|fable)(\[1m\])?$/;
export function modelLabel(id) {
  const full = FULL_ID_RE.exec(id);
  if (full) return `${FAMILIES[full[1]]} ${full[2]}${full[3] ? `.${full[3]}` : ''}${full[4] ? ' (1M context)' : ''}`;
  const short = SHORT_ID_RE.exec(id);
  if (short) return `${FAMILIES[short[1]]} (newest${short[2] ? ', 1M context' : ''})`;
  return id;
}

const profileFile = () => join(DATA, 'seat.json');

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return err.code === 'ENOENT' ? { value: {} } : { value: {}, unreadable: true };
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function profile() {
  const p = readJson(profileFile()).value;
  const name = typeof p?.name === 'string' && checkName(p.name) !== null ? checkName(p.name) : '';
  const provider = PROVIDERS[p?.provider]?.runs ? p.provider : 'anthropic';
  return { name, provider };
}

function checkName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  return n.length <= NAME_CAP && !CONTROL_RE.test(n) ? n : null;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// What the Settings tab shows. Reading never writes.
export function seatSettings() {
  const { name, provider } = profile();
  const p = PROVIDERS[provider];
  const file = readJson(p.settings.file());
  const unreadable = Boolean(file.unreadable) || !isObject(file.value);
  const now = p.settings.read(unreadable ? {} : file.value);
  const models = p.settings.models.map((m) => ({ ...m }));
  if (now.model && !models.some((m) => m.id === now.model)) models.push({ id: now.model, label: modelLabel(now.model) });
  return {
    name,
    provider,
    providerLabel: p.label,
    program: p.program,
    // The Provider list: every provider in the table; only those that run can be picked.
    providers: Object.entries(PROVIDERS).map(([id, x]) => ({ id, label: x.label, program: x.program, runs: x.runs })),
    model: now.model,
    thinking: now.thinking,
    models,
    thinkingLevels: p.settings.thinking.map((t) => ({ ...t })),
    permissionLevel: p.settings.readLevel(unreadable ? {} : file.value),
    permissionLevels: p.settings.levels.map(({ id, label, description }) => ({ id, label, description })),
    unreadable,
  };
}

// Save the name, provider, model, thinking level and permission level. changed: the model,
// thinking level or permission level is new, so Claude in the Console must start again to use
// it. A settings file that is not JSON is left alone (it may hold the user's other settings)
// and nothing is written. A provider this app does not run is refused; a save without one
// keeps the seat's, and a save without a permission level keeps the current one. Moving to
// Jarvis mode needs confirmJarvis (the page asks once).
export function saveSeatSettings({ name, provider: asked, model, thinking, permissionLevel, confirmJarvis } = {}) {
  const cleanName = checkName(name);
  if (cleanName === null) throw new SettingsError('bad-name');
  if (asked !== undefined && !(Object.hasOwn(PROVIDERS, asked) && PROVIDERS[asked].runs)) {
    throw new SettingsError('bad-provider');
  }
  const provider = asked ?? profile().provider;
  const p = PROVIDERS[provider];
  const file = readJson(p.settings.file());
  const now = p.settings.read(file.unreadable || !isObject(file.value) ? {} : file.value);
  const offered = p.settings.models.some((m) => m.id === model) || (model === now.model && model !== '');
  if (typeof model !== 'string' || !offered || RESERVED.has(model)) throw new SettingsError('bad-model');
  if (typeof thinking !== 'string' || !p.settings.thinking.some((t) => t.id === thinking)) {
    throw new SettingsError('bad-thinking');
  }
  const nowLevel = p.settings.readLevel(file.unreadable || !isObject(file.value) ? {} : file.value);
  const level = permissionLevel ?? nowLevel;
  if (typeof level !== 'string' || !p.settings.levels.some((l) => l.id === level)) throw new SettingsError('bad-level');
  if (level === 'jarvis' && nowLevel !== 'jarvis' && confirmJarvis !== true) throw new SettingsError('jarvis-confirm');
  const changed = model !== now.model || thinking !== now.thinking || level !== nowLevel;
  if (changed) {
    if (file.unreadable || !isObject(file.value)) throw new SettingsError('settings-unreadable');
    mkdirSync(CLAUDE_DIR, { recursive: true });
    let next = p.settings.write(file.value, { model, thinking });
    let marker;
    if (level !== nowLevel) ({ settings: next, marker } = p.settings.writeLevel(next, level, nowLevel));
    writeJson(p.settings.file(), next);
    if (marker) writeJson(jarvisFile(), marker);
    else if (marker === null) rmSync(jarvisFile(), { force: true });
  }
  mkdirSync(DATA, { recursive: true });
  writeJson(profileFile(), { name: cleanName, provider });
  return { changed };
}
