// The Settings tab's seat: its name, its provider, and the model and thinking level kept in
// Claude Code's own settings file (the one /model and /effort write). Run inside a sandbox
// /data, so no real login or settings file is touched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AGENT_DIR, sandbox } from './helpers.mjs';

// settings.mjs reads ADDON_DATA when it loads, so each check runs in a child node inside the
// sandbox and prints its answer as JSON.
const MODULE = pathToFileURL(join(AGENT_DIR, 'settings.mjs')).href;
function inBox(sb, code) {
  const script = `import { PROVIDERS, modelLabel, saveSeatSettings, seatSettings } from ${JSON.stringify(MODULE)};
    const answer = (() => { ${code} })();
    process.stdout.write(JSON.stringify(answer));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: sb.env }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout)));
  });
}

const settingsFile = (sb) => join(sb.data, 'claude', 'settings.json');
const readSettings = (sb) => JSON.parse(readFileSync(settingsFile(sb), 'utf8'));

describe('seat settings', () => {
  test('a fresh seat: no name, Anthropic, default model and thinking, the choices offered', async () => {
    const sb = sandbox({ seat: null });
    const s = await inBox(sb, 'return seatSettings()');
    assert.equal(s.name, '');
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.providerLabel, 'Anthropic');
    assert.equal(s.program, 'Claude Code');
    assert.equal(s.model, '');
    assert.equal(s.thinking, '');
    assert.deepEqual(s.models, [
      { id: '', label: 'Default (your plan picks)' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    ]);
    assert.deepEqual(s.thinkingLevels.map((m) => m.id), ['', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(existsSync(settingsFile(sb)), false, 'reading writes nothing');
    sb.cleanup();
  });

  test('OpenAI and Grok are in the provider table but not run by this app', async () => {
    const sb = sandbox({ seat: null });
    const p = await inBox(sb, 'return PROVIDERS');
    assert.deepEqual(Object.keys(p), ['anthropic', 'openai', 'grok']);
    assert.equal(p.anthropic.runs, true);
    assert.equal(p.openai.runs, false);
    assert.equal(p.grok.runs, false);
    assert.equal(p.openai.label, 'OpenAI');
    assert.equal(p.grok.label, 'Grok');
    sb.cleanup();
  });

  test('the Provider list: all three in order, only Anthropic can be picked', async () => {
    const sb = sandbox({ seat: null });
    const s = await inBox(sb, 'return seatSettings()');
    assert.deepEqual(s.providers, [
      { id: 'anthropic', label: 'Anthropic', program: 'Claude Code', runs: true },
      { id: 'openai', label: 'OpenAI', program: null, runs: false },
      { id: 'grok', label: 'Grok', program: null, runs: false },
    ]);
    sb.cleanup();
  });

  test('save takes the provider: Anthropic is kept, one not run (or unknown) is refused', async () => {
    const sb = sandbox({ seat: null });
    const code = async (body) => (await inBox(sb, `try { saveSeatSettings(${body}); return 'saved'; } catch (e) { return e.code; }`));
    assert.equal(await code("{ name: '', provider: 'openai', model: '', thinking: '' }"), 'bad-provider');
    assert.equal(await code("{ name: '', provider: 'grok', model: '', thinking: '' }"), 'bad-provider');
    assert.equal(await code("{ name: '', provider: 'toString', model: '', thinking: '' }"), 'bad-provider');
    assert.equal(await code("{ name: '', provider: 5, model: '', thinking: '' }"), 'bad-provider');
    assert.equal(existsSync(join(sb.data, 'seat.json')), false, 'a refused provider writes nothing');
    assert.equal(await code("{ name: 'Home', provider: 'anthropic', model: '', thinking: '' }"), 'saved');
    assert.deepEqual(JSON.parse(readFileSync(join(sb.data, 'seat.json'), 'utf8')), { name: 'Home', provider: 'anthropic' });
    // A save without a provider (an older page) keeps the seat's provider.
    assert.equal(await code("{ name: 'Home', model: '', thinking: '' }"), 'saved');
    assert.equal((await inBox(sb, 'return seatSettings()')).provider, 'anthropic');
    sb.cleanup();
  });

  test('save writes model and effort where Claude Code reads them, and keeps every other setting', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }));
    const r = await inBox(sb, "return saveSeatSettings({ name: '  Home  ', model: 'claude-opus-5-5', thinking: 'high' })");
    assert.deepEqual(r, { changed: true });
    assert.deepEqual(readSettings(sb), {
      theme: 'dark',
      permissions: { allow: ['Read'] },
      model: 'claude-opus-5-5',
      effortLevel: 'high',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
    });
    const s = await inBox(sb, 'return seatSettings()');
    assert.deepEqual([s.name, s.model, s.thinking], ['Home', 'claude-opus-5-5', 'high']);
    assert.deepEqual(JSON.parse(readFileSync(join(sb.data, 'seat.json'), 'utf8')), { name: 'Home', provider: 'anthropic' });

    const again = await inBox(sb, "return saveSeatSettings({ name: 'Garage', model: 'claude-opus-5-5', thinking: 'high' })");
    assert.deepEqual(again, { changed: false }, 'a new name alone does not restart Claude');
    sb.cleanup();
  });

  test('permission mode: offered, saved where Claude Code reads it, other permissions kept', async () => {
    const sb = sandbox({ seat: null });
    let s = await inBox(sb, 'return seatSettings()');
    assert.equal(s.permissionMode, '');
    assert.deepEqual(s.permissionModes.map((m) => m.id), ['', 'acceptEdits', 'plan']);
    writeFileSync(settingsFile(sb), JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }));
    const r = await inBox(sb, "return saveSeatSettings({ name: '', model: '', thinking: '', permissionMode: 'acceptEdits' })");
    assert.deepEqual(r, { changed: true }, 'a new mode restarts Claude');
    assert.deepEqual(readSettings(sb), { theme: 'dark', permissions: { allow: ['Read'], defaultMode: 'acceptEdits' } });
    s = await inBox(sb, 'return seatSettings()');
    assert.equal(s.permissionMode, 'acceptEdits');
    const same = await inBox(sb, "return saveSeatSettings({ name: 'x', model: '', thinking: '', permissionMode: 'acceptEdits' })");
    assert.deepEqual(same, { changed: false });
    await inBox(sb, "return saveSeatSettings({ name: '', model: '', thinking: '', permissionMode: '' })");
    assert.deepEqual(readSettings(sb), { theme: 'dark', permissions: { allow: ['Read'] } }, 'Default removes only defaultMode');
    sb.cleanup();
  });

  test('permission mode: a mode set elsewhere that is not offered shows as Default and is kept', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    assert.equal((await inBox(sb, 'return seatSettings()')).permissionMode, '');
    await inBox(sb, "return saveSeatSettings({ name: 'n', model: '', thinking: '', permissionMode: '' })");
    assert.deepEqual(readSettings(sb), { permissions: { defaultMode: 'auto' } }, 'an unchanged save writes nothing');
    const code = async (mode) => (await inBox(sb, `try { saveSeatSettings({ name: '', model: '', thinking: '', permissionMode: ${JSON.stringify(mode)} }); return 'saved'; } catch (e) { return e.code; }`));
    assert.equal(await code('bypassPermissions'), 'bad-mode');
    assert.equal(await code('auto'), 'bad-mode');
    sb.cleanup();
  });

  test('back to Default removes the keys it set and nothing else', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({
      theme: 'dark', model: 'sonnet', effortLevel: 'low',
      modelSettings: { sonnet: { effortLevel: 'low', autoCompactWindow: 100000 } },
    }));
    const r = await inBox(sb, "return saveSeatSettings({ name: '', model: '', thinking: '' })");
    assert.deepEqual(r, { changed: true });
    assert.deepEqual(readSettings(sb), { theme: 'dark', modelSettings: { sonnet: { autoCompactWindow: 100000 } } });
    sb.cleanup();
  });

  test('the thinking shown is the model\'s own level first, then the general one', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({ model: 'opus', effortLevel: 'low', modelSettings: { opus: { effortLevel: 'xhigh' } } }));
    assert.equal((await inBox(sb, 'return seatSettings()')).thinking, 'xhigh');
    writeFileSync(settingsFile(sb), JSON.stringify({ model: 'opus', effortLevel: 'low' }));
    assert.equal((await inBox(sb, 'return seatSettings()')).thinking, 'low');
    sb.cleanup();
  });

  test('a model set in the Console that is not in the list is shown and kept, not lost', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({ model: 'claude-opus-4-1-20250805' }));
    const s = await inBox(sb, 'return seatSettings()');
    assert.equal(s.model, 'claude-opus-4-1-20250805');
    assert.deepEqual(s.models.at(-1), { id: 'claude-opus-4-1-20250805', label: 'Opus 4.1' }, 'named with its version');
    const r = await inBox(sb, "return saveSeatSettings({ name: 'x', model: 'claude-opus-4-1-20250805', thinking: '' })");
    assert.deepEqual(r, { changed: false });
    assert.equal(readSettings(sb).model, 'claude-opus-4-1-20250805');
    sb.cleanup();
  });

  test('a model set by short name (opus), by an older version or with /model: named as the newest, kept', async () => {
    const sb = sandbox({ seat: null });
    writeFileSync(settingsFile(sb), JSON.stringify({ model: 'opus' }));
    const s = await inBox(sb, 'return seatSettings()');
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.models.at(-1), { id: 'opus', label: 'Opus (newest)' });
    assert.deepEqual(await inBox(sb, "return saveSeatSettings({ name: '', model: 'opus', thinking: '' })"), { changed: false });
    assert.equal(readSettings(sb).model, 'opus');
    sb.cleanup();
  });

  test('model names: family and version from the id, with the 1M context and dated ids', async () => {
    const sb = sandbox({ seat: null });
    const ids = ['claude-opus-5-5[1m]', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-fable-5',
      'sonnet[1m]', 'some-other-model', 'claude-opus-5-5-5'];
    const names = await inBox(sb, `return ${JSON.stringify(ids)}.map(modelLabel)`);
    assert.deepEqual(names, ['Opus 5.5 (1M context)', 'Sonnet 4', 'Haiku 4.5', 'Fable 5', 'Sonnet (newest, 1M context)',
      'some-other-model', 'claude-opus-5-5-5']);
    sb.cleanup();
  });

  test('refusals: a bad name, model or thinking level, and a settings file that is not JSON', async () => {
    const sb = sandbox({ seat: null });
    const code = async (body) => (await inBox(sb, `try { saveSeatSettings(${body}); return 'saved'; } catch (e) { return e.code; }`));
    assert.equal(await code("{ name: 'a'.repeat(41), model: '', thinking: '' }"), 'bad-name');
    assert.equal(await code("{ name: 'two\\nlines', model: '', thinking: '' }"), 'bad-name');
    assert.equal(await code("{ name: 5, model: '', thinking: '' }"), 'bad-name');
    assert.equal(await code("{ name: '', model: 'gpt-5', thinking: '' }"), 'bad-model');
    assert.equal(await code("{ name: '', model: '__proto__', thinking: '' }"), 'bad-model');
    assert.equal(await code("{ name: '', model: 'opus', thinking: '' }"), 'bad-model', 'a short name is kept, not offered');
    assert.equal(await code("{ name: '', model: '', thinking: 'max' }"), 'bad-thinking');
    assert.equal(existsSync(settingsFile(sb)), false, 'a refusal writes nothing');
    writeFileSync(settingsFile(sb), '{ not json');
    assert.equal(await code("{ name: '', model: 'claude-opus-5-5', thinking: '' }"), 'settings-unreadable');
    assert.equal(readFileSync(settingsFile(sb), 'utf8'), '{ not json', 'an unreadable file is left as it was');
    const s = await inBox(sb, 'return seatSettings()');
    assert.deepEqual([s.model, s.thinking, s.unreadable], ['', '', true]);
    sb.cleanup();
  });
});
