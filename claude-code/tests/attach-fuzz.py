#!/usr/bin/env python3
"""Fuzz a herdr attach client for escapes: the prefix (ctrl+a, ctrl+b, F12) + every key,
then left and right clicks over the whole screen. An escape = any new workspace, tab or
pane, or the pane's foreground process changing.

usage: attach-fuzz.py <herdr-binary> <client-config> [--quick]
  e.g. attach-fuzz.py ./herdr ../rootfs/etc/herdr/attach.toml     -> HELD, exit 0
       attach-fuzz.py ./herdr ../rootfs/etc/herdr/console.toml    -> ESCAPED (the control)
Runs its own herdr server (session "fz") under a short temp HOME; needs tmux. ~5 minutes.
"""
import json, os, shutil, subprocess, sys, tempfile, time

HERDR, cfg = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
mode = 'session'
quick = '--quick' in sys.argv
S = os.path.dirname(os.path.abspath(__file__))
SESSION = 'fz'
T = 'hxfz'
HOME = tempfile.mkdtemp(prefix='fz-', dir=os.environ.get('TMPDIR') or '/tmp')
os.environ['HOME'] = HOME
os.environ.pop('XDG_CONFIG_HOME', None)
# The server runs console.toml as shipped, with the pane gate at its path in this repo.
_agent = os.path.abspath(os.path.join(S, '..', 'rootfs', 'opt', 'addon-agent'))
with open(os.path.join(S, '..', 'rootfs', 'etc', 'herdr', 'console.toml')) as f:
    _toml = f.read().replace('/opt/addon-agent/', _agent + '/')
os.environ['HERDR_CONFIG_PATH'] = os.path.join(HOME, 'console.toml')
with open(os.environ['HERDR_CONFIG_PATH'], 'w') as f:
    f.write(_toml)


def h(*a):
    r = subprocess.run([HERDR, '--session', SESSION, *a], capture_output=True, text=True)
    return json.loads(r.stdout) if r.stdout.strip().startswith('{') else {'raw': r.stdout + r.stderr}


def tm(*a):
    subprocess.run(['tmux', '-L', T, *a], check=False)


def fingerprint():
    ws = h('workspace', 'list')['result']['workspaces']
    panes = h('pane', 'list')['result']['panes']
    pi = h('pane', 'process-info', '--pane', PANE).get('result', {}).get('process_info')
    fg = sorted(p['name'] for p in pi['foreground_processes']) if pi else ['<pane gone>']
    return (tuple((w['workspace_id'], w['tab_count'], w['pane_count']) for w in ws),
            tuple(sorted(p['pane_id'] for p in panes)), tuple(fg))


subprocess.Popen(['setsid', HERDR, '--session', SESSION, 'server'],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(40):
    if 'result' in h('workspace', 'list'):
        break
    time.sleep(0.25)
c = h('workspace', 'create', '--cwd', '/tmp', '--label', 'claude', '--no-focus', '--env', 'ADDON_CONSOLE=1')
PANE = c['result']['root_pane']['pane_id']
h('workspace', 'focus', c['result']['workspace']['workspace_id'])
h('pane', 'run', PANE, f'exec {S}/fakes/claude-fuzz')
time.sleep(1.5)
base = fingerprint()
print('base', base)
# The fuzz means nothing unless the stand-in agent (not a shell) holds the pane.
if base[2] != ('python3',):
    print('RESULT NOT RUN: the stand-in agent is not running in the pane', flush=True)
    subprocess.run([HERDR, '--session', SESSION, 'server', 'stop'], capture_output=True)
    sys.exit(2)

attach = [HERDR, 'session', 'attach', SESSION]
tm('kill-server')
tm('new-session', '-d', '-s', 't', '-x', '120', '-y', '36',
   ' '.join(['env', f'HERDR_CONFIG_PATH={cfg}', *attach, ';', 'sleep', '600']))
time.sleep(2)

escapes = []


gated = []


def check(what):
    fp = fingerprint()
    if fp != base:
        # Panes herdr made by itself are not an escape if each one runs only the gate
        # (pane-shell.sh: no shell); anything else in a new pane is.
        panes = h('pane', 'list')['result']['panes']
        others = [p['pane_id'] for p in panes if p['pane_id'] != PANE]
        argvs = []
        for pid in others:
            pi = h('pane', 'process-info', '--pane', pid).get('result', {}).get('process_info') or {}
            argvs += [p['argv'] for p in pi.get('foreground_processes', [])]
        if others and all(any(a.endswith('pane-shell.sh') for a in v) or v[0] == 'sleep' for v in argvs):
            gated.append((what, fp))
            print('PANE LOST after', what, '- herdr made a pane, and it got no shell:', argvs, flush=True)
        else:
            escapes.append((what, fp))
            print('ESCAPE after', what, fp, argvs, flush=True)
        return True
    return False


prefixes = ['C-a', 'C-b', 'F12']
keys = [chr(c) for c in range(33, 127)] + [
    'Enter', 'Tab', 'BTab', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
    'PPage', 'NPage', 'IC', 'DC'] + [f'F{i}' for i in range(1, 13)] + [
    f'C-{c}' for c in 'abcefghjklnopqrstuvwxyz'] + [f'M-{c}' for c in 'abcdnwxtpqsz']
if quick:
    keys = ['N', 'c', 'v', 'minus', 'w']
for p in prefixes:
    for k in keys:
        tm('send-keys', '-t', 't', p)
        time.sleep(0.03)
        tm('send-keys', '-t', 't', '-l', k) if len(k) == 1 else tm('send-keys', '-t', 't', k)
        time.sleep(0.12)
        if check(f'{p} {k}'):
            break
        tm('send-keys', '-t', 't', 'Escape')
    if escapes or gated:
        break

if not escapes and not gated:
    # SGR mouse: press+release, left (0) and right (2) buttons, over a grid of cells
    for btn in (0, 2):
        for y in range(1, 37, 1 if not quick else 5):
            for x in range(1, 121, 3 if not quick else 10):
                tm('send-keys', '-t', 't', '-l', f'\x1b[<{btn};{x};{y}M\x1b[<{btn};{x};{y}m')
            time.sleep(0.05)
            if check(f'mouse btn{btn} row{y}'):
                break
            tm('send-keys', '-t', 't', 'Escape')
        if escapes or gated:
            break

time.sleep(1)
if not gated:
    check('final')
tm('capture-pane', '-p', '-t', 't')
print('RESULT', 'ESCAPED' if escapes else 'HELD (pane lost, gate held)' if gated else 'HELD', len(escapes))
tm('kill-server')
subprocess.run([HERDR, '--session', SESSION, 'server', 'stop'], capture_output=True)
if escapes or gated:
    print('kept for reading:', HOME)
else:
    shutil.rmtree(HOME, ignore_errors=True)
sys.exit(1 if escapes else 0)
