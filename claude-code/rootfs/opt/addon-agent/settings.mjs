// The seat on the Settings tab: the name the user gives it (kept in /data/seat.json), its
// provider, and that provider's model and thinking level. Anthropic (Claude Code) is the only
// provider this app runs. The table below is where another would go: OpenAI and Grok are
// listed (greyed out in the Provider list) but not run, since each needs its own program and
// sign-in in the image first.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, DATA } from './lib.mjs';

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
  models: [
    { id: '', label: 'Default (your plan picks)' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ],
  // "max" is left out: Claude Code keeps it for one session only and never saves it.
  thinking: [
    { id: '', label: 'Default' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
  ],
  // permissions.defaultMode. The app runs as root, so Claude Code refuses its unattended
  // modes; a mode set elsewhere that is not offered here shows as Default and is kept.
  modes: [
    { id: '', label: 'Default (asks first)' },
    { id: 'acceptEdits', label: 'Accept edits' },
    { id: 'plan', label: 'Plan (read only)' },
  ],
  readMode(s) {
    const m = isObject(s.permissions) ? s.permissions.defaultMode : undefined;
    return this.modes.some((x) => x.id && x.id === m) ? m : '';
  },
  writeMode(s, mode) {
    const out = { ...s };
    const perms = isObject(out.permissions) ? { ...out.permissions } : {};
    if (mode) perms.defaultMode = mode;
    else delete perms.defaultMode;
    if (Object.keys(perms).length) out.permissions = perms;
    else delete out.permissions;
    return out;
  },
};

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', program: 'Claude Code', runs: true, settings: claude },
  openai: { label: 'OpenAI', program: null, runs: false, settings: null },
  grok: { label: 'Grok', program: null, runs: false, settings: null },
};

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
  if (now.model && !models.some((m) => m.id === now.model)) models.push({ id: now.model, label: now.model });
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
    permissionMode: p.settings.readMode(unreadable ? {} : file.value),
    permissionModes: p.settings.modes.map((m) => ({ ...m })),
    unreadable,
  };
}

// Save the name, provider, model, thinking level and permission mode. changed: the model,
// thinking level or permission mode is new, so Claude in the Console must start again to use
// it. A settings file that is not JSON is left alone (it may hold the user's other settings)
// and nothing is written. A provider this app does not run is refused; a save without one
// keeps the seat's, and a save without a permission mode keeps the current one.
export function saveSeatSettings({ name, provider: asked, model, thinking, permissionMode } = {}) {
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
  const nowMode = p.settings.readMode(file.unreadable || !isObject(file.value) ? {} : file.value);
  const mode = permissionMode ?? nowMode;
  if (typeof mode !== 'string' || !p.settings.modes.some((m) => m.id === mode)) throw new SettingsError('bad-mode');
  const changed = model !== now.model || thinking !== now.thinking || mode !== nowMode;
  if (changed) {
    if (file.unreadable || !isObject(file.value)) throw new SettingsError('settings-unreadable');
    mkdirSync(CLAUDE_DIR, { recursive: true });
    let next = p.settings.write(file.value, { model, thinking });
    if (mode !== nowMode) next = p.settings.writeMode(next, mode);
    writeJson(p.settings.file(), next);
  }
  mkdirSync(DATA, { recursive: true });
  writeJson(profileFile(), { name: cleanName, provider });
  return { changed };
}
