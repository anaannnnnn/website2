export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const r1 = v => Math.round(v * 10) / 10;
export const r2 = v => Math.round(v * 100) / 100;
export const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
export const niceStep = (range, maxTicks) => [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find(s => range / s <= maxTicks) || 10000;
export const canvasBlob = (cv, type = 'image/png', q) => new Promise(r => cv.toBlob(r, type, q));

export function download(data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** small animated notifications */
export function toast(msg, kind = 'info', ms = 4200) {
  let host = $('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, ms);
}

/** count a number up smoothly inside an element */
export function countUp(el, to, { d = 0, suffix = '', ms = 900 } = {}) {
  const from = parseFloat(el.dataset.v || '0') || 0, t0 = performance.now();
  el.dataset.v = to;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to, d) + suffix; return; }
  const step = t => { const k = Math.max(0, Math.min(1, (t - t0) / ms)), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e, d) + suffix; if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/** fetch with timeout + retries */
export async function fetchRetry(url, opts = {}, { tries = 3, timeout = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    try { const r = await fetch(url, { ...opts, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
    catch (e) { last = e.name === 'AbortError' ? new Error('timed out') : e; await sleep(500 * (i + 1)); }
    finally { clearTimeout(t); }
  }
  throw last;
}
