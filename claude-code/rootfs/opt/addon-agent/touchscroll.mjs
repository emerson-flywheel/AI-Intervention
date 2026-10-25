// Finger scrolling for the Console. herdr captures the mouse, so the browser terminal
// (xterm.js in ttyd) reports mouse events to herdr and ignores touch altogether: it only
// scrolls its own buffer by touch, and herdr's screen has none. A swipe did nothing on a
// phone. Here a vertical drag becomes wheel notches on the terminal, which xterm.js sends
// to herdr exactly as a desktop mouse wheel, and herdr scrolls the pane's scrollback.
// A tap is left alone, so it still focuses the terminal and brings up the keyboard.
// Shared by the page (served as-is to the browser) and the tests.

// Finger travel before a touch counts as a drag, not a tap (px).
export const SLOP = 10;
// herdr scrolls 3 lines a notch (its mouse_scroll_lines default): one notch per 3 rows
// of travel keeps the text under the finger.
export const ROWS_PER_NOTCH = 3;
const ROW_PX = 17;

// Notches for dy px of travel not yet scrolled, with rows rowPx high. Positive = finger
// moving down = back into the scrollback. rest is the travel left over for the next move.
export function notches(dy, rowPx = ROW_PX) {
  const step = (rowPx > 0 ? rowPx : ROW_PX) * ROWS_PER_NOTCH;
  const n = Math.trunc(dy / step);
  return { notches: n, rest: dy - n * step };
}

// Install on the Console frame's window (same origin). Again on each load: a reload
// brings a new document. Only while the terminal reports the mouse (herdr's case); with
// no mouse reporting xterm.js scrolls by touch itself.
export function touchScroll(win) {
  const doc = win?.document;
  if (!doc || doc.addonTouchScroll) return;
  doc.addonTouchScroll = true;
  const captured = () => !win.term || win.term.modes?.mouseTrackingMode !== 'none';
  const rowPx = () => {
    const el = doc.querySelector('.xterm-screen');
    return el && win.term?.rows ? el.clientHeight / win.term.rows : ROW_PX;
  };
  let start = null;
  let last = 0;
  let travel = 0;
  let dragging = false;
  doc.addEventListener('touchstart', (e) => {
    start = e.touches.length === 1 && captured() ? e.touches[0].clientY : null;
    last = start;
    travel = 0;
    dragging = false;
  }, { capture: true, passive: true });
  doc.addEventListener('touchmove', (e) => {
    if (start === null || e.touches.length !== 1) return;
    const { clientX, clientY } = e.touches[0];
    if (!dragging && Math.abs(clientY - start) < SLOP) return;
    dragging = true;
    // The swipe is the terminal's: not the page's scroll, nor a pull to refresh.
    e.preventDefault();
    travel += clientY - last;
    last = clientY;
    const { notches: n, rest } = notches(travel, rowPx());
    travel = rest;
    // The wheel is reported at the finger, so herdr scrolls the pane under it.
    const screen = doc.querySelector('.xterm-screen');
    for (let i = 0; screen && i < Math.abs(n); i++) {
      screen.dispatchEvent(new win.WheelEvent('wheel', {
        deltaY: n > 0 ? -1 : 1, deltaMode: 1, clientX, clientY, bubbles: true, cancelable: true,
      }));
    }
  }, { capture: true, passive: false });
  const end = () => {
    start = null;
  };
  doc.addEventListener('touchend', end, { capture: true, passive: true });
  doc.addEventListener('touchcancel', end, { capture: true, passive: true });
}
