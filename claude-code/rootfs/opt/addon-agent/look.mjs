// The Console's look, set on the Settings tab and kept in /data/look.json: herdr's theme (its
// sidebar, borders and status) and the browser terminal's colours and font size (ttyd's
// xterm). The default is the app's own look: herdr's "terminal" theme with the app's colours
// and ttyd's defaults, exactly as the shipped configs have it.
//   node look.mjs configs     write /run's herdr configs (console and attach) for the look
//   node look.mjs ttyd-args   print ttyd's extra arguments for the look, one a line
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RUN } from './lib.mjs';

export class LookError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const ETC = process.env.ADDON_HERDR_ETC || '/etc/herdr';
export const CONFIGS = ['console.toml', 'attach.toml'];

const COLOUR_KEYS = [
  'background', 'foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue',
  'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
];
// Light themes: the label says so.
const LIGHT = new Set([
  'catppuccin-latte', 'tokyo-night-day', 'gruvbox-light', 'one-light', 'solarized-light', 'kanagawa-lotus',
  'rose-pine-dawn',
]);
function theme(id, label, colours) {
  const values = colours.split(' ');
  return { id, label, light: LIGHT.has(id), colors: Object.fromEntries(COLOUR_KEYS.map((k, i) => [k, values[i]])) };
}

// herdr 0.9.3's built-in themes (its own list, less "terminal", which the default uses). The
// terminal colours are each theme's Windows Terminal scheme from mbadolato/iTerm2-Color-Schemes
// (commit 86a776d), with the selection at 30% so selected text stays readable.
export const THEMES = [
  { id: '', label: 'AI Intervention (default)', light: false, colors: null },
  theme('catppuccin', 'Catppuccin', '#1e1e2e #cdd6f4 #f5e0dc #f5e0dc4d #45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f7aec2 #c2ecbf #fcd682 #aeccfc #f398da #b1eae1 #a6adc8'),
  theme('catppuccin-latte', 'Catppuccin Latte', '#eff1f5 #4c4f69 #dc8a78 #dc8a784d #bcc0cc #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #5c5f77 #acb0be #e7103f #46b02f #e49931 #3878f6 #ef95d7 #19a1a8 #6c6f85'),
  theme('tokyo-night', 'Tokyo Night', '#1a1b26 #c0caf5 #c0caf5 #2834574d #15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5'),
  theme('tokyo-night-day', 'Tokyo Night Day', '#e1e2e7 #3760bf #3760bf #99a7df4d #e9e9ed #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #6172b0 #a1a6c5 #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #3760bf'),
  theme('dracula', 'Dracula', '#282a36 #f8f8f2 #f8f8f2 #44475a4d #21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff'),
  theme('nord', 'Nord', '#2e3440 #d8dee9 #eceff4 #eceff44d #3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #596377 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4'),
  theme('gruvbox', 'Gruvbox', '#282828 #ebdbb2 #ebdbb2 #665c544d #282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2'),
  theme('gruvbox-light', 'Gruvbox Light', '#fbf1c7 #3c3836 #3c3836 #3c38364d #fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836'),
  theme('one-dark', 'One Dark', '#21252b #abb2bf #abb2bf #3238444d #21252b #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #767676 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf'),
  theme('one-light', 'One Light', '#f9f9f9 #2a2c33 #bbbbbb #d0dffc4d #000000 #de3e35 #3f953a #d2b67c #2f5af3 #950095 #3f953a #bbbbbb #000000 #de3e35 #3f953a #d2b67c #2f5af3 #a00095 #3f953a #ffffff'),
  theme('solarized', 'Solarized Dark', '#002b36 #839496 #839496 #0736424d #073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #335e69 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3'),
  theme('solarized-light', 'Solarized Light', '#fdf6e3 #657b83 #657b83 #eee8d54d #073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #bbb5a2 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3'),
  theme('kanagawa', 'Kanagawa', '#1f1f28 #dcd7ba #dcd7ba #dcd7ba4d #090618 #c34043 #76946a #c0a36e #7e9cd8 #957fb8 #6a9589 #c8c093 #727169 #e82424 #98bb6c #e6c384 #7fb4ca #938aa9 #7aa89f #dcd7ba'),
  theme('kanagawa-lotus', 'Kanagawa Lotus', '#f2ecbc #545464 #43436c #5454644d #1f1f28 #c84053 #6f894e #77713f #4d699b #b35b79 #597b75 #545464 #8a8980 #d7474b #6e915f #836f4a #6693bf #624c83 #5e857a #43436c'),
  theme('rose-pine', 'Rosé Pine', '#191724 #e0def4 #e0def4 #403d524d #26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4'),
  theme('rose-pine-dawn', 'Rosé Pine Dawn', '#faf4ed #575279 #575279 #dfdad94d #f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #9893a5 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279'),
  theme('vesper', 'Vesper', '#101010 #ffffff #acb1ab #9880494d #101010 #f5a191 #90b99f #e6b99d #aca1cf #e29eca #ea83a5 #a0a0a0 #7e7e7e #ff8080 #99ffe4 #ffc799 #b9aeda #ecaad6 #f591b2 #ffffff'),
];

// ttyd's own default is 13 px.
export const FONT_SIZES = [
  { id: '', label: 'Default (13 px)' },
  ...['12', '14', '16', '18', '20'].map((id) => ({ id, label: `${id} px` })),
];

const lookFile = () => join(DATA, 'look.json');
const isTheme = (id) => typeof id === 'string' && THEMES.some((t) => t.id === id);
const isFontSize = (id) => typeof id === 'string' && FONT_SIZES.some((f) => f.id === id);

// The saved look. Anything this app does not offer reads as the default.
export function readLook() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(lookFile(), 'utf8'));
  } catch {}
  return {
    theme: isTheme(saved?.theme) ? saved.theme : '',
    fontSize: isFontSize(saved?.fontSize) ? saved.fontSize : '',
  };
}

// What the Settings tab shows. Reading never writes.
export function lookSettings() {
  return {
    ...readLook(),
    themes: THEMES.map((t) => ({
      id: t.id,
      label: t.light ? `${t.label} (light)` : t.label,
      light: t.light,
      background: t.colors?.background ?? null,
    })),
    fontSizes: FONT_SIZES.map((f) => ({ ...f })),
  };
}

// Save the look. changed: the Console needs its client started again to show it.
export function saveLook({ theme: id, fontSize } = {}) {
  if (!isTheme(id)) throw new LookError('bad-theme');
  if (!isFontSize(fontSize)) throw new LookError('bad-font-size');
  const now = readLook();
  const changed = id !== now.theme || fontSize !== now.fontSize;
  if (changed) {
    mkdirSync(DATA, { recursive: true });
    const tmp = `${lookFile()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ theme: id, fontSize }, null, 2)}\n`);
    renameSync(tmp, lookFile());
  }
  return { changed };
}

// A shipped herdr config with its [theme] tables (the last thing in it) swapped for the
// chosen built-in theme. The default keeps the file as it is.
export function herdrConfig(base, id) {
  if (!id) return base;
  if (!isTheme(id)) throw new Error(`not a theme this app offers: ${id}`);
  const at = base.search(/^\[theme\]$/m);
  if (at < 0) throw new Error('the herdr config has no [theme] table');
  const tables = base.slice(at).match(/^\[[^\]]+\]$/gm);
  if (!tables.every((t) => t === '[theme]' || t.startsWith('[theme.'))) {
    throw new Error('[theme] must be last in the herdr config');
  }
  return `${base.slice(0, at)}[theme]\nname = "${id}"\n`;
}

// ttyd's extra arguments: the font size and the terminal colours, only where not default.
export function ttydArgs({ theme: id, fontSize } = readLook()) {
  const args = [];
  if (fontSize) args.push('-t', `fontSize=${fontSize}`);
  const t = THEMES.find((x) => x.id === id && id);
  if (t) args.push('-t', `theme=${JSON.stringify(t.colors)}`);
  return args;
}

// Both herdr configs for the saved look, under /run (written whole, then moved into place).
export function writeConfigs() {
  const { theme: id } = readLook();
  const dir = join(RUN, 'herdr');
  mkdirSync(dir, { recursive: true });
  for (const f of CONFIGS) {
    const text = herdrConfig(readFileSync(join(ETC, f), 'utf8'), id);
    writeFileSync(join(dir, `.${f}.tmp`), text);
    renameSync(join(dir, `.${f}.tmp`), join(dir, f));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const verb = process.argv[2];
  if (verb === 'configs') writeConfigs();
  else if (verb === 'ttyd-args') {
    const args = ttydArgs();
    if (args.length) process.stdout.write(`${args.join('\n')}\n`);
  } else {
    console.error('usage: look.mjs configs | ttyd-args');
    process.exitCode = 2;
  }
}
