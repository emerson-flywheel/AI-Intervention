// The add-on page: Console and Seat tabs. All URLs are relative (ingress serves this
// page under a path prefix). The sign-in link is checked here too, with the same
// check the server uses, before any tab is sent to it.
import { checkCode, checkLoginUrl } from './linkcheck.mjs';

const $ = (id) => document.getElementById(id);
const views = ['v-signed-in', 'v-signed-out', 'v-code', 'v-done'];
let link = null;
let busy = false;

const MESSAGES = {
  'not-taken': 'claude.ai did not take that code. Copy all of it and paste it again, or press Sign in at claude.ai for a fresh one.',
  'not-a-code': 'That is not a login code. Copy all of it from the claude.ai tab and paste it again.',
  'not-waiting': 'No sign-in is waiting (it stops after 15 minutes). Press Sign in at claude.ai for a fresh one.',
  'not-finished': 'The sign-in did not finish. Press Sign in at claude.ai to try again.',
  'bad-link': 'The sign-in link was not one this add-on accepts, so its tab was closed. Nothing was changed.',
  'no-link': 'The sign-in did not start. Try again in a minute.',
  busy: 'Another sign-in step is running. Wait a moment, then try again.',
  failed: 'Something went wrong. Try again in a minute.',
};
const DONE = {
  now: 'Signed in. Claude in the Console was started again on the new login.',
  'after-shell': 'Signed in. Claude starts on the new login when you leave the shell in the Console.',
  none: 'Signed in. Claude starts on the new login with the Console.',
};

function selectTab(name) {
  for (const t of ['console', 'seat']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(t).hidden = t !== name;
  }
}

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
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

function render(s) {
  chip(s.signedIn);
  if (s.signedIn) {
    $('status').textContent = s.byOption ? 'Signed in (by the oauth_token option)' : 'Signed in';
    $('plan').textContent = s.plan || '';
    $('plan').hidden = $('plan-dt').hidden = !s.plan;
    $('since').textContent = s.since ? new Date(s.since).toLocaleString() : '';
    $('since').hidden = $('since-dt').hidden = !s.since;
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

async function refresh() {
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    const s = await r.json();
    if (!$('v-code').hidden || !$('v-done').hidden) {
      chip(s.signedIn);
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

async function cancel() {
  await post('api/login/cancel');
  link = null;
  error(null);
  show('v-signed-out');
  await refresh();
}

$('tab-console').addEventListener('click', () => selectTab('console'));
$('tab-seat').addEventListener('click', () => {
  selectTab('seat');
  refresh();
});
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
