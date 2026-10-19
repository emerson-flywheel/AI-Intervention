// The Console's look on the Settings tab: herdr's theme and the browser terminal's colours
// and font size, kept in /data/look.json and turned into herdr configs under /run and ttyd
// options. Run inside a sandbox /data and /run.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AGENT_DIR, HERE, runNode, sandbox } from './helpers.mjs';

const MODULE = pathToFileURL(join(AGENT_DIR, 'look.mjs')).href;
const ETC = join(HERE, '..', 'rootfs', 'etc', 'herdr');
function inBox(sb, code) {
  const script = `import * as look from ${JSON.stringify(MODULE)};
    const answer = (() => { ${code} })();
    process.stdout.write(JSON.stringify(answer));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: sb.env }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout)));
  });
}
const attempt = (sb, body) =>
  inBox(sb, `try { return look.saveLook(${body}); } catch (e) { return e.code || e.message; }`);

// herdr 0.9.3's own list (`herdr config check` on an unknown name), less "terminal", which
// the default look uses.
const HERDR_THEMES = [
  'catppuccin', 'catppuccin-latte', 'tokyo-night', 'tokyo-night-day', 'dracula', 'nord', 'gruvbox',
  'gruvbox-light', 'one-dark', 'one-light', 'solarized', 'solarized-light', 'kanagawa', 'kanagawa-lotus',
  'rose-pine', 'rose-pine-dawn', 'vesper',
];
const LIGHT = [
  'catppuccin-latte', 'tokyo-night-day', 'gruvbox-light', 'one-light', 'solarized-light', 'kanagawa-lotus', 'rose-pine-dawn',
];
const COLOUR_KEYS = [
  'background', 'foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue',
  'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
];

describe('console look', () => {
  test('fresh: the default look, every herdr theme offered, the font sizes; reading writes nothing', async () => {
    const sb = sandbox({ seat: null });
    const s = await inBox(sb, 'return look.lookSettings()');
    assert.equal(s.theme, '');
    assert.equal(s.fontSize, '');
    assert.deepEqual(s.themes.map((t) => t.id), ['', ...HERDR_THEMES]);
    assert.equal(s.themes[0].label, 'AI Intervention (default)');
    assert.equal(s.themes.find((t) => t.id === 'catppuccin-latte').light, true);
    assert.equal(s.themes.find((t) => t.id === 'nord').light, false);
    for (const t of s.themes.slice(1)) assert.match(t.background, /^#[0-9a-f]{6}$/, t.id);
    assert.deepEqual(s.fontSizes.map((f) => f.id), ['', '12', '14', '16', '18', '20']);
    assert.equal(s.fontSizes[0].label, 'Default (13 px)');
    assert.equal(existsSync(join(sb.data, 'look.json')), false);
    sb.cleanup();
  });

  test('save: kept in look.json, changed only when something is new', async () => {
    const sb = sandbox({ seat: null });
    assert.deepEqual(await attempt(sb, "{ theme: 'nord', fontSize: '16' }"), { changed: true });
    assert.deepEqual(JSON.parse(readFileSync(join(sb.data, 'look.json'), 'utf8')), { theme: 'nord', fontSize: '16' });
    const s = await inBox(sb, 'return look.lookSettings()');
    assert.deepEqual([s.theme, s.fontSize], ['nord', '16']);
    assert.deepEqual(await attempt(sb, "{ theme: 'nord', fontSize: '16' }"), { changed: false });
    assert.deepEqual(await attempt(sb, "{ theme: 'nord', fontSize: '18' }"), { changed: true }, 'a new font size alone');
    assert.deepEqual(await attempt(sb, "{ theme: '', fontSize: '' }"), { changed: true });
    assert.deepEqual(await inBox(sb, 'return look.readLook()'), { theme: '', fontSize: '' });
    sb.cleanup();
  });

  test('refusals: an unknown theme or font size writes nothing', async () => {
    const sb = sandbox({ seat: null });
    assert.equal(await attempt(sb, "{ theme: 'everforest', fontSize: '' }"), 'bad-theme');
    assert.equal(await attempt(sb, "{ theme: 'terminal', fontSize: '' }"), 'bad-theme');
    assert.equal(await attempt(sb, "{ theme: '__proto__', fontSize: '' }"), 'bad-theme');
    assert.equal(await attempt(sb, "{ theme: 5, fontSize: '' }"), 'bad-theme');
    assert.equal(await attempt(sb, "{ theme: '', fontSize: '15' }"), 'bad-font-size');
    assert.equal(await attempt(sb, "{ theme: '', fontSize: 16 }"), 'bad-font-size');
    assert.equal(await attempt(sb, '{}'), 'bad-theme');
    assert.equal(existsSync(join(sb.data, 'look.json')), false);
    sb.cleanup();
  });

  test('a look.json that is not one this app wrote reads as the default', async () => {
    const sb = sandbox({ seat: null });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(sb.data, 'look.json'), '{ not json');
    assert.deepEqual(await inBox(sb, 'return look.readLook()'), { theme: '', fontSize: '' });
    writeFileSync(join(sb.data, 'look.json'), JSON.stringify({ theme: 'everforest', fontSize: '99' }));
    assert.deepEqual(await inBox(sb, 'return look.readLook()'), { theme: '', fontSize: '' });
    writeFileSync(join(sb.data, 'look.json'), JSON.stringify({ theme: 'dracula', fontSize: '99' }));
    assert.deepEqual(await inBox(sb, 'return look.readLook()'), { theme: 'dracula', fontSize: '' });
    sb.cleanup();
  });

  test('herdr config: the default is the shipped file; a theme replaces only the [theme] tables', async () => {
    const sb = sandbox({ seat: null });
    for (const f of ['console.toml', 'attach.toml']) {
      const base = readFileSync(join(ETC, f), 'utf8');
      const head = base.slice(0, base.search(/^\[theme\]$/m));
      assert.ok(head.length > 100, `${f} has a [theme] table`);
      assert.equal(await inBox(sb, `return look.herdrConfig(${JSON.stringify(base)}, '')`), base);
      const nord = await inBox(sb, `return look.herdrConfig(${JSON.stringify(base)}, 'nord')`);
      assert.ok(nord.startsWith(head), `${f}: everything before [theme] is kept`);
      assert.equal(nord.slice(head.length), '[theme]\nname = "nord"\n');
    }
    const late = '[theme]\nname = "terminal"\n\n[ui]\naccent = "#fff"\n';
    assert.match(await inBox(sb, `try { return look.herdrConfig(${JSON.stringify(late)}, 'nord'); } catch (e) { return e.message; }`),
      /\[theme\] must be last/);
    sb.cleanup();
  });

  test('ttyd options: none for the default look; the theme\'s colours and the font size otherwise', async () => {
    const sb = sandbox({ seat: null });
    assert.deepEqual(await inBox(sb, "return look.ttydArgs({ theme: '', fontSize: '' })"), []);
    assert.deepEqual(await inBox(sb, "return look.ttydArgs({ theme: '', fontSize: '18' })"), ['-t', 'fontSize=18']);
    const args = await inBox(sb, "return look.ttydArgs({ theme: 'nord', fontSize: '' })");
    assert.equal(args.length, 2);
    assert.equal(args[0], '-t');
    assert.ok(args[1].startsWith('theme={'));
    const colours = JSON.parse(args[1].slice('theme='.length));
    assert.deepEqual(Object.keys(colours), COLOUR_KEYS);
    assert.equal(colours.background, '#2e3440', 'Nord\'s background');
    sb.cleanup();
  });

  test('every theme has all 20 terminal colours, and readable text on its background', async () => {
    const sb = sandbox({ seat: null });
    const themes = await inBox(sb, 'return look.THEMES');
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const t of themes.filter((x) => x.id)) {
      assert.deepEqual(Object.keys(t.colors), COLOUR_KEYS, t.id);
      for (const [k, v] of Object.entries(t.colors)) assert.match(v, /^#[0-9a-f]{6}([0-9a-f]{2})?$/, `${t.id}.${k}`);
      // 4: Solarized Light is 4.1 by its own design; every other theme is 4.5 or more.
      const [a, b] = [lum(t.colors.foreground), lum(t.colors.background)].sort((x, y) => y - x);
      assert.ok((a + 0.05) / (b + 0.05) >= 4, `${t.id}: text contrast ${((a + 0.05) / (b + 0.05)).toFixed(2)}`);
      assert.equal(lum(t.colors.background) > 0.5, LIGHT.includes(t.id), `${t.id}: light background or dark`);
      assert.equal(t.light, LIGHT.includes(t.id), `${t.id}: light flag`);
    }
    const labels = (await inBox(sb, 'return look.lookSettings()')).themes;
    assert.equal(labels.find((t) => t.id === 'rose-pine-dawn').label, 'Rosé Pine Dawn (light)');
    assert.equal(labels.find((t) => t.id === 'rose-pine').label, 'Rosé Pine');
    sb.cleanup();
  });

  test('look.mjs configs writes both herdr configs under /run; ttyd-args prints one argument a line', async () => {
    const sb = sandbox({ seat: null });
    let r = await runNode(sb, 'look.mjs', { args: ['configs'] });
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['console.toml', 'attach.toml']) {
      assert.equal(readFileSync(join(sb.run, 'herdr', f), 'utf8'), readFileSync(join(ETC, f), 'utf8'), `${f}: default`);
    }
    r = await runNode(sb, 'look.mjs', { args: ['ttyd-args'] });
    assert.deepEqual([r.code, r.stdout], [0, '']);

    await attempt(sb, "{ theme: 'gruvbox-light', fontSize: '14' }");
    r = await runNode(sb, 'look.mjs', { args: ['configs'] });
    assert.equal(r.code, 0, r.stderr);
    const attach = readFileSync(join(sb.run, 'herdr', 'attach.toml'), 'utf8');
    assert.match(attach, /^name = "gruvbox-light"$/m);
    assert.match(attach, /^mouse_capture = false$/m, 'the attach client stays locked');
    assert.match(readFileSync(join(sb.run, 'herdr', 'console.toml'), 'utf8'), /^name = "gruvbox-light"$/m);
    r = await runNode(sb, 'look.mjs', { args: ['ttyd-args'] });
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.deepEqual(lines.slice(0, 3), ['-t', 'fontSize=14', '-t']);
    assert.equal(JSON.parse(lines[3].slice('theme='.length)).background, '#fbf1c7');
    assert.equal(lines.length, 4);
    r = await runNode(sb, 'look.mjs', { args: ['nonsense'] });
    assert.notEqual(r.code, 0);
    sb.cleanup();
  });

  test('herdr is given the configs written for the look, and the shipped ones until they exist', async () => {
    const sb = sandbox({ seat: null });
    const lib = pathToFileURL(join(AGENT_DIR, 'lib.mjs')).href;
    const paths = () => new Promise((resolve, reject) => {
      const env = { ...sb.env };
      delete env.ADDON_CONSOLE_CONFIG;
      delete env.ADDON_ATTACH_CONFIG;
      execFile(process.execPath, ['--input-type=module', '-e',
        `import { ATTACH_CONFIG, CONSOLE_CONFIG } from ${JSON.stringify(lib)}; console.log(JSON.stringify([CONSOLE_CONFIG, ATTACH_CONFIG]));`],
      { env }, (err, out, e) => (err ? reject(new Error(e)) : resolve(JSON.parse(out))));
    });
    assert.deepEqual(await paths(), ['/etc/herdr/console.toml', '/etc/herdr/attach.toml']);
    assert.equal((await runNode(sb, 'look.mjs', { args: ['configs'] })).code, 0);
    assert.deepEqual(await paths(), [join(sb.run, 'herdr', 'console.toml'), join(sb.run, 'herdr', 'attach.toml')]);
    sb.cleanup();
  });
});
