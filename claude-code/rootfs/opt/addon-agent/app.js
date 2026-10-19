// The add-on page: Console and Settings tabs (Settings holds the seat). All URLs are relative (ingress serves this
// page under a path prefix). The sign-in link is checked here too, with the same
// check the server uses, before any tab is sent to it.
import { checkCode, checkLoginUrl } from './linkcheck.mjs';

const $ = (id) => document.getElementById(id);
const views = ['v-signed-in', 'v-signed-out', 'v-code', 'v-done'];
let link = null;
let busy = false;
// Edits not saved yet: a refresh leaves the name, provider, model, thinking and permission
// mode as typed, and the Console's theme and font size as picked.
let dirty = false;
let lookDirty = false;
// The Console client's process from the last state: a new one means ttyd started again.
let view = null;

const MESSAGES = {
  'not-taken': 'claude.ai did not take that code. Copy all of it and paste it again, or press Sign in at claude.ai for a fresh one.',
  'not-a-code': 'That is not a login code. Copy all of it from the claude.ai tab and paste it again.',
  'not-waiting': 'No sign-in is waiting (it stops after 15 minutes). Press Sign in at claude.ai for a fresh one.',
  'not-finished': 'The sign-in did not finish. Press Sign in at claude.ai to try again.',
  'bad-link': 'The sign-in link was not one this add-on accepts, so its tab was closed. Nothing was changed.',
  'no-link': 'The sign-in did not start. Try again in a minute.',
  busy: 'Another sign-in step is running. Wait a moment, then try again.',
  'bad-name': 'A name is up to 40 characters on one line.',
  'bad-provider': 'That provider is not one this app runs yet. Reload the page and pick Anthropic.',
  'bad-model': 'That model is not one this app offers. Reload the page and pick again.',
  'bad-thinking': 'That thinking level is not one this app offers. Reload the page and pick again.',
  'bad-mode': 'That permission mode is not one this app offers. Reload the page and pick again.',
  'bad-theme': 'That theme is not one this app offers. Reload the page and pick again.',
  'bad-font-size': 'That font size is not one this app offers. Reload the page and pick again.',
  'settings-unreadable':
    "Claude Code's settings file (/data/claude/settings.json) is not valid JSON, so nothing was changed. Fix or remove it, then save again.",
  failed: 'Something went wrong. Try again in a minute.',
};
const SAVED = {
  now: 'Saved. Claude in the Console was started again with these settings; the conversation is kept.',
  'after-shell': 'Saved. Claude uses them when you leave the shell in the Console.',
  none: 'Saved.',
};
const LOOK_SAVED = {
  wait: 'Saved. The Console reconnects with the new look in a few seconds; Claude keeps running.',
  done: 'Saved. The Console has the new look.',
  late: 'Saved. If the Console still shows the old look, reload the page.',
  same: 'Saved.',
};
const REMOTE = {
  unknown: 'Not known yet: the app is starting.',
  off: 'Off. Set the remote_key option on the Configuration tab to turn it on.',
  'refused-key': 'Off: remote_key is not one plain ssh-ed25519 public key line.',
  'refused-from': 'Off: remote_allow_from must name the addresses the key may log in from.',
  on: 'On',
};
const DONE = {
  now: 'Signed in. Claude in the Console was started again on the new login.',
  'after-shell': 'Signed in. Claude starts on the new login when you leave the shell in the Console.',
  none: 'Signed in. Claude starts on the new login with the Console.',
};

function selectTab(name) {
  for (const t of ['console', 'settings']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(t).hidden = t !== name;
  }
}

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  // The sign-in steps take the seat's space; the settings come back after them.
  $('v-form').hidden = view === 'v-code' || view === 'v-done';
  $('link-box').hidden = true;
  $('link-box').value = '';
}

function error(code) {
  $('error').textContent = code ? MESSAGES[code] || MESSAGES.failed : '';
  $('error').hidden = !code;
  // The messages that point at "Sign in at claude.ai" get that button with them.
  $('fresh-row').hidden = !['not-taken', 'not-waiting', 'not-finished'].includes(code);
}

function chip(signedIn) {
  $('chip').textContent = signedIn ? 'signed in' : 'sign in needed';
  $('chip').classList.toggle('ok', signedIn);
}

async function post(path, body = {}) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seat': '1' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? data : { error: data.error || 'failed' };
  } catch {
    return { error: 'failed' };
  }
}

function options(select, list, pick) {
  select.replaceChildren(
    ...list.map((o) => {
      const el = document.createElement('option');
      el.value = o.id;
      el.textContent = o.label;
      el.disabled = Boolean(o.disabled);
      el.selected = o.id === pick;
      return el;
    }),
  );
}

// The seat's row: "Seat", its name, then signed in / signed out on the same line.
function seatHead(s) {
  const set = s.settings || {};
  $('seat-name').textContent = set.name || s.seat || '';
  $('seat-chip').textContent = s.signedIn ? 'Signed in' : 'Signed out';
  $('seat-chip').classList.toggle('ok', s.signedIn);
  let meta = '';
  if (s.signedIn && s.byOption) meta = 'by the oauth_token option';
  else if (s.signedIn) {
    const plan = s.plan ? `${s.plan[0].toUpperCase()}${s.plan.slice(1)} plan` : '';
    const when = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    const since = s.since ? `since ${new Date(s.since).toLocaleString(undefined, when)}` : '';
    meta = [plan, since].filter(Boolean).join(' · ');
  }
  $('seat-meta').textContent = meta;
  if (!dirty) {
    $('name').value = set.name || '';
    // OpenAI and Grok are listed but greyed out: this app runs only Anthropic (Claude Code).
    const providers = (set.providers || []).map((p) => ({
      id: p.id,
      label: `${p.label} · ${p.runs ? p.program : 'coming later'}`,
      disabled: !p.runs,
    }));
    options($('provider'), providers, set.provider || '');
    options($('model'), set.models || [], set.model || '');
    options($('thinking'), set.thinkingLevels || [], set.thinking || '');
    options($('mode'), set.permissionModes || [], set.permissionMode || '');
  }
  $('again').hidden = !s.signedIn || Boolean(s.byOption);
  $('start').hidden = s.signedIn;
  $('save-note').textContent = s.signedIn
    ? 'Save restarts Claude in the Console on a new model, thinking level or permission mode; the conversation is kept.'
    : 'Saved now, used from the first start after you sign in.';
}

// The Console card (theme, font size) and the frame's own background, so a theme's colour
// fills the frame while the Console loads.
function look(c = {}) {
  const pick = (c.themes || []).find((t) => t.id === c.theme);
  $('frame').style.background = pick?.background || '';
  if (lookDirty) return;
  options($('theme'), c.themes || [], c.theme || '');
  options($('font-size'), c.fontSizes || [], c.fontSize || '');
}

function remote(r = {}) {
  $('remote-state').textContent = REMOTE[r.state] || REMOTE.unknown;
  const on = r.state === 'on';
  for (const el of document.querySelectorAll('.remote-on')) el.hidden = !on;
  $('remote-from').textContent = r.from || '';
  $('remote-host').textContent = r.hostKey || 'not made yet';
}

function render(s) {
  chip(s.signedIn);
  seatHead(s);
  if (s.signedIn) {
    $('by-file').hidden = Boolean(s.byOption);
    $('by-option').hidden = !s.byOption;
    show('v-signed-in');
  } else {
    // A login that ran out says so; one that never existed says "Not signed in yet."
    $('out-lapsed').hidden = !s.lapsed;
    $('out-never').hidden = Boolean(s.lapsed);
    show('v-signed-out');
  }
}

async function state() {
  const r = await fetch('api/state', { cache: 'no-store' });
  return r.json();
}

async function refresh() {
  try {
    const s = await state();
    view = s.view;
    look(s.console);
    remote(s.remote);
    if (!$('v-code').hidden || !$('v-done').hidden) {
      chip(s.signedIn);
      seatHead(s);
      return;
    }
    render(s);
  } catch {}
}

// A page may open a tab only during a press, and the link takes up to 20 s, so the
// press opens a blank tab at once and sends it on when the checked link arrives.
async function startSignIn() {
  if (busy) return;
  busy = true;
  error(null);
  const w = window.open('', '_blank');
  if (w) {
    try {
      w.document.title = 'Opening the sign-in…';
      w.document.body.textContent = 'Opening the sign-in…';
    } catch {}
  }
  for (const id of ['start', 'again', 'fresh']) $(id).disabled = true;
  const r = await post('api/login/start');
  for (const id of ['start', 'again', 'fresh']) $(id).disabled = false;
  busy = false;
  if (r.url && checkLoginUrl(r.url)) {
    link = r.url;
    if (w) {
      w.opener = null;
      w.location.replace(link);
    }
    $('code').value = '';
    // No focus() here: attention belongs on the claude.ai tab that just opened (and a
    // focus in this page while that tab navigates crashed it in headless Chromium).
    show('v-code');
    return;
  }
  if (w) w.close();
  link = null;
  await refresh();
  error(r.url ? 'bad-link' : r.error || 'no-link');
}

async function submit() {
  if (busy) return;
  const code = $('code').value.trim();
  if (!checkCode(code)) return error('not-a-code');
  busy = true;
  error(null);
  $('submit').disabled = true;
  const r = await post('api/login/code', { code });
  $('submit').disabled = false;
  busy = false;
  if (r.signedIn) {
    link = null;
    $('done-text').textContent = DONE[r.relaunched] || DONE.none;
    show('v-done');
    chip(true);
    return;
  }
  error(r.error);
}

async function save() {
  if (busy) return;
  busy = true;
  error(null);
  $('saved').hidden = true;
  $('save').disabled = true;
  const r = await post('api/seat/settings', {
    name: $('name').value,
    provider: $('provider').value,
    model: $('model').value,
    thinking: $('thinking').value,
    permissionMode: $('mode').value,
  });
  $('save').disabled = false;
  busy = false;
  if (!r.saved) return error(r.error);
  dirty = false;
  $('saved').textContent = SAVED[r.relaunched] || SAVED.none;
  $('saved').hidden = false;
  await refresh();
}

// A new look starts the Console's ttyd again (run.sh, within 5 s): wait for its new
// process, then load the Console again in the frame.
async function saveLook() {
  if (busy) return;
  busy = true;
  $('look-error').hidden = true;
  $('look-saved').hidden = true;
  $('save-look').disabled = true;
  let before = view;
  try {
    before = (await state()).view;
  } catch {}
  const r = await post('api/console/look', { theme: $('theme').value, fontSize: $('font-size').value });
  busy = false;
  if (!r.saved) {
    $('save-look').disabled = false;
    $('look-error').textContent = MESSAGES[r.error] || MESSAGES.failed;
    $('look-error').hidden = false;
    return;
  }
  lookDirty = false;
  const said = (key) => {
    $('look-saved').textContent = LOOK_SAVED[key];
    $('look-saved').hidden = false;
  };
  if (!r.reload) {
    $('save-look').disabled = false;
    said('same');
    return refresh();
  }
  said('wait');
  let moved = false;
  for (let i = 0; i < 20 && !moved; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    try {
      const s = await state();
      moved = Boolean(s.view) && s.view !== before;
    } catch {}
  }
  if (moved) $('frame').src = 'console/';
  said(moved ? 'done' : 'late');
  $('save-look').disabled = false;
  await refresh();
}

async function cancel() {
  await post('api/login/cancel');
  link = null;
  error(null);
  show('v-signed-out');
  await refresh();
}

$('tab-console').addEventListener('click', () => selectTab('console'));
$('tab-settings').addEventListener('click', () => {
  selectTab('settings');
  refresh();
});
for (const id of ['name', 'provider', 'model', 'thinking', 'mode']) {
  $(id).addEventListener('input', () => {
    dirty = true;
    $('saved').hidden = true;
  });
}
for (const id of ['theme', 'font-size']) {
  $(id).addEventListener('input', () => {
    lookDirty = true;
    $('look-saved').hidden = true;
  });
}
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});
$('save').addEventListener('click', save);
$('save-look').addEventListener('click', saveLook);
$('start').addEventListener('click', startSignIn);
$('again').addEventListener('click', startSignIn);
$('fresh').addEventListener('click', startSignIn);
$('submit').addEventListener('click', submit);
$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
$('cancel').addEventListener('click', cancel);
$('reopen').addEventListener('click', () => {
  if (link && checkLoginUrl(link)) window.open(link, '_blank', 'noopener');
});
$('copy').addEventListener('click', async () => {
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    $('copy').textContent = 'Copied';
    setTimeout(() => ($('copy').textContent = 'Copy the link'), 2000);
  } catch {
    // No clipboard (HA over plain http is not a secure context): show the link, selected.
    $('link-box').value = link;
    $('link-box').hidden = false;
    $('link-box').focus();
    $('link-box').select();
  }
});
$('open-console').addEventListener('click', async () => {
  selectTab('console');
  $('v-done').hidden = true;
  await refresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
refresh();
