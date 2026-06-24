// lilDiff: compare two versions of text and render an inline unified diff.
// Uses Myers' shortest-edit-script algorithm at word, line, or character
// granularity. Everything runs locally; nothing is uploaded.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- theme (OS-aware, matches the family) ---------- */
const MOON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4"/></g></svg>';

function setThemeIcon(btn, theme) {
  if (theme === 'dark') { btn.innerHTML = SUN_SVG; btn.setAttribute('aria-label', 'Switch to light mode'); }
  else { btn.innerHTML = MOON_SVG; btn.setAttribute('aria-label', 'Switch to dark mode'); }
}
function initTheme() {
  const btn = $('#ui-theme-btn');
  const current = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  setThemeIcon(btn, current());
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('lildiff-theme', next); } catch (e) { /* storage may be unavailable; safe to ignore */ }
    setThemeIcon(btn, next);
  });
}

/* ---------- state ---------- */
const state = { gran: 'word', ignoreWs: false, ignoreCase: false };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- tokenizers ---------- */
// each tokenizer returns an array of original substrings that, concatenated,
// rebuild the source exactly. line mode keeps the trailing newline on each line.
function tokenize(text, gran) {
  if (!text) return [];
  if (gran === 'char') return [...text];
  if (gran === 'line') {
    // split after each newline so joining is lossless
    return text.split(/(?<=\n)/);
  }
  // word mode: runs of whitespace or non-whitespace, so spacing survives
  return text.match(/\s+|\S+/g) || [];
}

// the comparison key for a token, honoring the ignore options
function keyOf(tok) {
  let k = tok;
  if (state.ignoreCase) k = k.toLowerCase();
  if (state.ignoreWs && /^\s+$/.test(tok)) k = ' '; // any whitespace run is equal
  return k;
}

/* ---------- Myers diff ---------- */
// returns ops: array of { type: 'eq'|'del'|'ins', tok } in output order, or
// null if the edit distance blows past the guard (caller falls back).
function myers(aKeys, bKeys, aTok, bTok, maxD) {
  const N = aKeys.length, M = bKeys.length;
  const MAXD = Math.min(maxD, N + M);
  const off = N + M;
  const v = new Int32Array(2 * (N + M) + 1);
  const trace = [];
  let done = false;
  for (let d = 0; d <= MAXD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && aKeys[x] === bKeys[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { done = true; break; }
    }
    if (done) break;
  }
  if (!done) return null; // exceeded the guard

  const ops = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'eq', tok: aTok[x - 1] }); x--; y--; }
    if (x === prevX) { ops.push({ type: 'ins', tok: bTok[y - 1] }); y--; }
    else { ops.push({ type: 'del', tok: aTok[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ type: 'eq', tok: aTok[x - 1] }); x--; y--; }
  while (x > 0) { ops.push({ type: 'del', tok: aTok[x - 1] }); x--; }
  while (y > 0) { ops.push({ type: 'ins', tok: bTok[y - 1] }); y--; }
  ops.reverse();
  return ops;
}

function diffTexts(before, after, gran) {
  const aTok = tokenize(before, gran);
  const bTok = tokenize(after, gran);
  const aKeys = aTok.map(keyOf);
  const bKeys = bTok.map(keyOf);
  // guard: keep worst-case trace memory bounded; fall back to line mode
  const ops = myers(aKeys, bKeys, aTok, bTok, 6000);
  if (ops) return { ops, gran };
  if (gran !== 'line') return diffTexts(before, after, 'line');
  // last resort: treat as a full replace
  return {
    ops: [...aTok.map((t) => ({ type: 'del', tok: t })), ...bTok.map((t) => ({ type: 'ins', tok: t }))],
    gran, fellBack: true,
  };
}

/* ---------- render ---------- */
function render() {
  const before = $('#f-before').value;
  const after = $('#f-after').value;
  $('#c-before').textContent = before.length;
  $('#c-after').textContent = after.length;

  const out = $('#diff-out');
  if (!before && !after) {
    out.innerHTML = '<div class="insp-empty" id="empty"><p class="insp-empty__big">No comparison yet</p><p class="insp-empty__sub">Paste a before and after on the left. The differences light up here as you type.</p></div>';
    setStats(0, 0, 'Paste both versions to compare.');
    return;
  }

  const { ops, gran, fellBack } = diffTexts(before, after, state.gran);

  // collapse consecutive same-type tokens into spans
  let html = '';
  let adds = 0, dels = 0;
  let run = null;
  const flush = () => {
    if (!run) return;
    const cls = run.type === 'ins' ? 'd-ins' : run.type === 'del' ? 'd-del' : 'd-eq';
    const tag = run.type === 'ins' ? 'ins' : run.type === 'del' ? 'del' : 'span';
    html += `<${tag} class="${cls}">${esc(run.text)}</${tag}>`;
    run = null;
  };
  for (const op of ops) {
    if (op.type === 'ins') adds += unitCount(op.tok, gran);
    else if (op.type === 'del') dels += unitCount(op.tok, gran);
    if (!run || run.type !== op.type) { flush(); run = { type: op.type, text: op.tok }; }
    else run.text += op.tok;
  }
  flush();

  out.innerHTML = `<div class="diff-doc diff-doc--${gran}">${html || '<span class="d-eq"></span>'}</div>`;

  if (!adds && !dels) setStats(0, 0, 'The two versions are identical.');
  else setStats(adds, dels, fellBack ? 'Texts are very different; showing a line-level replace.' : statLabel(adds, dels, gran));
}

function unitCount(tok, gran) {
  if (gran === 'char') return tok.length;
  if (gran === 'line') return 1;
  return /^\s+$/.test(tok) ? 0 : 1; // whitespace tokens are not counted as word changes
}

function statLabel(adds, dels, gran) {
  const unit = gran === 'char' ? 'character' : gran === 'line' ? 'line' : 'word';
  const plural = (n) => (n === 1 ? unit : unit + 's');
  return `${adds} ${plural(adds)} added, ${dels} ${plural(dels)} removed.`;
}

function setStats(adds, dels, msg) {
  $('#stat-add').textContent = '+' + adds;
  $('#stat-del').textContent = '−' + dels;
  $('#stat-msg').textContent = msg;
}

/* ---------- example ---------- */
const EXAMPLE_BEFORE = `This Agreement is made between the Company and the Client.

The Company agrees to deliver the website within 30 days. Payment is due within 60 days of the invoice date. The Client owns all final source files upon full payment.`;
const EXAMPLE_AFTER = `This Agreement is made between lilAgents and the Client.

The Company agrees to deliver the website within 21 days. Payment is due within 14 days of the invoice date. The Client owns all final source files, accounts, and code upon full payment.`;

/* ---------- wire-up ---------- */
function initDiff() {
  initTheme();

  let raf = null;
  const schedule = () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(render); };
  $('#f-before').addEventListener('input', schedule);
  $('#f-after').addEventListener('input', schedule);

  $$('[data-gran]').forEach((b) => b.addEventListener('click', () => {
    state.gran = b.dataset.gran;
    $$('[data-gran]').forEach((x) => x.classList.toggle('is-active', x === b));
    render();
  }));
  $('#opt-ws').addEventListener('change', (e) => { state.ignoreWs = e.target.checked; render(); });
  $('#opt-case').addEventListener('change', (e) => { state.ignoreCase = e.target.checked; render(); });

  $('#swap-btn').addEventListener('click', () => {
    const b = $('#f-before'), a = $('#f-after');
    [b.value, a.value] = [a.value, b.value];
    render();
  });
  $('#example-btn').addEventListener('click', () => {
    $('#f-before').value = EXAMPLE_BEFORE;
    $('#f-after').value = EXAMPLE_AFTER;
    render();
  });
  $('#clear-btn').addEventListener('click', () => {
    $('#f-before').value = '';
    $('#f-after').value = '';
    render();
  });

  $('#copy-after').addEventListener('click', async (e) => {
    const txt = $('#f-after').value;
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      const btn = e.currentTarget;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy revised text'; }, 1100);
    } catch (err) { /* storage may be unavailable; safe to ignore */ }
  });

  render();
}

export { initDiff };
