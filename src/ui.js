(function () {
'use strict';

const A = AURORA;

/* ───────────────────────────── helpers ───────────────────────────── */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nf = n => Number(n).toLocaleString('pt-BR');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const plural = (n, one, many) => nf(n) + ' ' + (n === 1 ? one : many);

/* "2,3 mi", "38 mil": short enough for the stage strip */
function compact(n) {
  if (n >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: n >= 1e7 ? 0 : 1 }) + ' mi';
  if (n >= 1e4) return Math.round(n / 1e3).toLocaleString('pt-BR') + ' mil';
  return nf(n);
}

/* a final value worth reading: long or multi-line text is described, not dumped */
function valueText(v) {
  if (typeof v === 'string' && (v.length > 40 || v.indexOf('\n') >= 0)) return 'um texto de ' + plural(v.length, 'caractere', 'caracteres');
  return A.fmt(v);
}

function ms(t) {
  if (t == null) return '—';
  if (t < 0.01) return '< 0,01 ms';
  const d = t < 10 ? 2 : t < 100 ? 1 : 0;
  return t.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ms';
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('aurora.' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('aurora.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  },
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PRELUDE = A.prelude();
const LIB = new Set(Object.keys(A.BUILTIN_TYPES).concat(PRELUDE.bindings.map(b => b.name)));

/* ───────────────────────────── elements ──────────────────────────── */

const ta = $('src'), hl = $('hl'), gutter = $('gutter'), tip = $('tip'), note = $('note');
const editorEl = $('editor'), stagesEl = $('stages'), panel = $('panel');
const examplesEl = $('examples'), subEl = $('source-sub');

/* ─────────────────────────────── state ───────────────────────────── */

const SLICE = 3e6;          /* instructions per slice before yielding to the page */
const MAX_STEPS = 250e6;

const S = {
  exId: null,
  drafts: {},
  front: null,              /* stages 1–4 */
  run: null,                /* stage 5 */
  dirty: false,             /* text changed since the last compile */
  tab: 'output',
  hover: null,              /* span under the mouse in the editor */
  hot: null,                /* span pointed at from a panel */
  execLine: 0,              /* line the debugger is on */
  gen: 0,                   /* bumps to cancel a run in flight */
  booting: !REDUCED,
  first: true,
};

const SPEEDS = [
  { label: 'devagar', sps: 3 },
  { label: 'normal', sps: 20 },
  { label: 'rápido', sps: 400 },
  { label: 'turbo', sps: 50000 },
];

const V = { m: null, snap: null, step: 0, playing: false, speed: 1, last: 0, carry: 0, listingFn: null, drag: false };

const STAGES = [
  { id: 'lex', tab: 'tokens', n: '1', name: 'Lexer' },
  { id: 'parse', tab: 'ast', n: '2', name: 'Parser' },
  { id: 'type', tab: 'types', n: '3', name: 'Tipos' },
  { id: 'compile', tab: 'bytecode', n: '4', name: 'Bytecode' },
  { id: 'run', tab: 'vm', n: '5', name: 'Máquina' },
];
const TABS = ['tokens', 'ast', 'types', 'bytecode', 'vm', 'output'];
const ORDER = { lex: 0, parse: 1, type: 2, compile: 3, run: 4, runtime: 4 };
const STAGE_LABEL = {
  lex: 'erro léxico', parse: 'erro de sintaxe', type: 'erro de tipo',
  compile: 'erro de compilação', runtime: 'erro na execução',
};
const WHY = {
  lex: 'O lexer não consegue cortar este texto em tokens, e sem tokens nenhum outro estágio tem o que ler.',
  parse: 'Os tokens estão certos, mas não formam uma frase da gramática. Sem árvore, não há o que tipar nem compilar.',
  type: 'A inferência encontrou uma contradição. Aurora só gera bytecode para programas cujos tipos fecham — por isso a máquina nem liga, e nem os print de antes do erro chegam a rodar.',
  compile: 'O compilador não conseguiu gerar código para esta construção.',
};

/* ─────────────────────── editor: metrics & paint ─────────────────── */

const metrics = { cw: 8.1, lh: 21, pl: 16, pt: 14 };

function measure() {
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(200);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  hl.appendChild(probe);
  metrics.cw = probe.getBoundingClientRect().width / 200 || metrics.cw;
  probe.remove();
  const cs = getComputedStyle(ta);
  metrics.lh = parseFloat(cs.lineHeight) || metrics.lh;
  metrics.pl = parseFloat(cs.paddingLeft) || 0;
  metrics.pt = parseFloat(cs.paddingTop) || 0;
}

function tokClass(t) {
  switch (t.type) {
    case 'kw': return t.value === 'true' || t.value === 'false' ? 't-lit' : 't-kw';
    case 'ident': return LIB.has(t.value) ? 't-lib' : 't-id';
    case 'num': return 't-num';
    case 'str': return 't-str';
    case 'op': return 't-op';
    case 'punct': return 't-pun';
    default: return 't-bad';
  }
}

/* Syntax colouring plus overlapping marks (error, hover), cut at every boundary. */
function paint(src, marks) {
  const lx = A.lex(src, true);
  const segs = [];
  for (const t of lx.tokens) if (t.type !== 'eof') segs.push({ s: t.start, e: t.end, c: tokClass(t) });
  for (const c of lx.trivia) segs.push({ s: c.start, e: c.end, c: 't-com' });
  segs.sort((a, b) => a.s - b.s);
  marks = (marks || []).filter(m => m.e > m.s);

  const cuts = new Set([0, src.length]);
  for (const g of segs) { cuts.add(g.s); cuts.add(g.e); }
  for (const m of marks) { cuts.add(clamp(m.s, 0, src.length)); cuts.add(clamp(m.e, 0, src.length)); }
  const pts = Array.from(cuts).sort((a, b) => a - b);

  let out = '', si = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    while (si < segs.length && segs[si].e <= a) si++;
    const cls = [];
    if (si < segs.length && segs[si].s <= a) cls.push(segs[si].c);
    for (const m of marks) if (m.s <= a && a < m.e) cls.push(m.c);
    const text = esc(src.slice(a, b));
    out += cls.length ? '<span class="' + cls.join(' ') + '">' + text + '</span>' : text;
  }
  return out;
}

function currentError() {
  if (S.front && S.front.error) return S.front.error;
  if (S.run && S.run.error) return S.run.error;
  return null;
}

const bar = (line, cls) =>
  '<i class="lb ' + cls + '" style="top:' + (metrics.pt + (line - 1) * metrics.lh) + 'px"></i>';

function renderEditor() {
  const src = ta.value;
  const err = S.dirty ? null : currentError();
  const marks = [];
  let atEnd = false;
  if (err && err.start != null) {
    if (err.start >= src.length) atEnd = true;
    else marks.push({ s: err.start, e: Math.max(err.end, err.start + 1), c: 'mk-err' });
  }
  const pointed = S.dirty ? null : (S.hot || S.hover);
  if (pointed) marks.push({ s: pointed.start, e: pointed.end, c: 'mk-hi' });

  let bars = '';
  if (err && err.start == null && err.line) bars += bar(err.line, 'lb-err');
  if (S.execLine) bars += bar(S.execLine, 'lb-exec');

  hl.innerHTML = bars + paint(src, marks) + (atEnd ? '<span class="mk-err"> </span>' : '') + '\n';
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;

  const lines = src.split('\n').length;
  const errLine = err ? err.line : 0;
  let g = '';
  for (let i = 1; i <= lines; i++) {
    g += i === S.execLine ? '<div class="is-exec">' + i + '</div>'
       : i === errLine ? '<div class="is-err">' + i + '</div>'
       : '<div>' + i + '</div>';
  }
  gutter.innerHTML = g;
}

function lineOf(offset) {
  let line = 1;
  const src = ta.value;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function scrollToLine(line) {
  const y = metrics.pt + (line - 1) * metrics.lh;
  const h = ta.clientHeight;
  if (y < ta.scrollTop + metrics.lh || y > ta.scrollTop + h - metrics.lh * 3) {
    ta.scrollTop = Math.max(0, y - h / 3);
  }
}

ta.addEventListener('scroll', () => {
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  gutter.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  hideTip();
});

/* ───────────────────────── editor: typing ────────────────────────── */

let debounce = 0;
let tabEscapes = false;

ta.addEventListener('input', () => {
  S.dirty = true;
  const ex = EXAMPLES.find(e => e.id === S.exId);
  if (ex && ta.value === ex.code) delete S.drafts[S.exId];
  else S.drafts[S.exId] = ta.value;
  store.set('drafts', S.drafts);
  S.hover = null;
  hideTip();
  renderEditor();
  renderNote();
  renderSub();
  renderExamples();
  clearTimeout(debounce);
  debounce = setTimeout(compileAndRun, 280);
});

function insert(text) {
  /* execCommand keeps the browser's own undo stack intact */
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}

ta.addEventListener('keydown', e => {
  hideTip();
  if (e.key === 'Escape') { tabEscapes = true; return; }
  if (e.key !== 'Tab') tabEscapes = false;

  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    compileAndRun();
    return;
  }

  const v = ta.value, s = ta.selectionStart, end = ta.selectionEnd;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const before = v.slice(lineStart, s);

  if (e.key === 'Tab') {
    if (tabEscapes) return;                       /* Esc, then Tab: leave the editor */
    e.preventDefault();
    if (!e.shiftKey && v.slice(s, end).indexOf('\n') < 0) { insert('  '); return; }
    const block = v.slice(lineStart, end);
    const next = block.split('\n').map(l => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
    ta.setSelectionRange(lineStart, end);
    insert(next);
    ta.setSelectionRange(lineStart, lineStart + next.length);
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    const indent = before.match(/^ */)[0];
    const opens = /(\{|\(|\[|=>|=|\bthen|\belse)\s*$/.test(before);
    insert('\n' + indent + (opens ? '  ' : ''));
    return;
  }

  if (e.key === '}' && /^ {2,}$/.test(before)) {
    e.preventDefault();
    ta.setSelectionRange(s - 2, s);
    insert('}');
  }
});

/* ─────────────────────── editor: hover for types ─────────────────── */

let hoverRaf = 0, lastMouse = null;

ta.addEventListener('mousemove', e => {
  lastMouse = e;
  if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover);
});
ta.addEventListener('mouseleave', () => { lastMouse = null; setHover(null); });

function offsetAt(cx, cy) {
  const r = ta.getBoundingClientRect();
  const x = cx - r.left - metrics.pl + ta.scrollLeft;
  const y = cy - r.top - metrics.pt + ta.scrollTop;
  if (x < 0 || y < 0) return -1;
  const row = Math.floor(y / metrics.lh), col = Math.floor(x / metrics.cw);
  const lines = ta.value.split('\n');
  if (row >= lines.length || col >= lines[row].length) return -1;
  let off = 0;
  for (let i = 0; i < row; i++) off += lines[i].length + 1;
  return off + col;
}

function doHover() {
  hoverRaf = 0;
  const e = lastMouse;
  if (!e || S.dirty || !S.front || !S.front.typed) return setHover(null);
  const off = offsetAt(e.clientX, e.clientY);
  if (off < 0) return setHover(null);
  let best = null;
  for (const s of S.front.typed) {
    if (s.k === 'Block') continue;
    if (s.start <= off && off < s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
  }
  setHover(best, e);
}

function setHover(span, e) {
  if (!span) {
    if (S.hover) { S.hover = null; renderEditor(); }
    tip.hidden = true;
    return;
  }
  const same = S.hover && span.start === S.hover.start && span.end === S.hover.end;
  if (!same) {
    S.hover = span;
    renderEditor();
    tip.innerHTML = tipHTML(span);
  }
  tip.hidden = false;
  placeTip(e);
}

function tipHTML(span) {
  const src = S.front.src;
  let label = span.name || src.slice(span.start, span.end).replace(/\s+/g, ' ');
  if (label.length > 42) label = label.slice(0, 40) + '…';
  const type = span.scheme ? A.schemeStr(span.scheme) : A.typeStr(span.ty);
  const kind = span.scheme ? 'definição'
             : span.k === 'Var' ? (LIB.has(span.name) ? 'biblioteca, instanciada aqui' : 'nome')
             : span.name ? 'parâmetro' : 'expressão';
  return '<span class="tip-k">' + kind + '</span>' + esc(label) +
         '<span class="tip-c"> : </span><span class="tip-t">' + esc(type) + '</span>';
}

function placeTip(e) {
  const er = editorEl.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = e.clientX - er.left + 14, y = e.clientY - er.top + 20;
  if (x + tw > er.width - 8) x = Math.max(8, er.width - tw - 8);
  if (y + th > er.height - 8) y = e.clientY - er.top - th - 14;
  tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
}

function hideTip() {
  if (!tip.hidden) tip.hidden = true;
}

/* ───────────────────────── examples & subline ────────────────────── */

function renderExamples() {
  examplesEl.innerHTML = EXAMPLES.map(ex => {
    const edited = S.drafts[ex.id] != null;
    return '<button type="button" class="ex" data-ex="' + ex.id + '" aria-pressed="' + (ex.id === S.exId) + '">' +
      esc(ex.title) + (edited ? '<span class="dot" title="editado"></span>' : '') + '</button>';
  }).join('');
  revealIn(examplesEl, examplesEl.querySelector('[aria-pressed="true"]'));
}

/* keep the active item of a sideways-scrolling strip in view, without moving the page */
function revealIn(strip, el) {
  if (!el) return;
  const l = el.offsetLeft, r = l + el.offsetWidth;
  if (l < strip.scrollLeft) strip.scrollLeft = l - 16;
  else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 16;
}

function renderSub() {
  const ex = EXAMPLES.find(e => e.id === S.exId);
  const edited = S.drafts[S.exId] != null;
  subEl.innerHTML =
    '<span class="blurb">' + esc(ex ? ex.blurb : '') +
    (edited ? ' · editado — <button type="button" class="linkish" data-restore>restaurar o original</button>' : '') +
    '</span><span><kbd>' + MOD + '</kbd> <kbd>Enter</kbd> executa · passe o mouse no código para ver os tipos</span>';
}

examplesEl.addEventListener('click', e => {
  const b = e.target.closest('[data-ex]');
  if (b) selectExample(b.dataset.ex);
});

subEl.addEventListener('click', e => {
  if (!e.target.closest('[data-restore]')) return;
  const ex = EXAMPLES.find(x => x.id === S.exId);
  delete S.drafts[S.exId];
  store.set('drafts', S.drafts);
  ta.value = ex.code;
  renderExamples();
  renderSub();
  compileAndRun();
});

function selectExample(id) {
  const ex = EXAMPLES.find(e => e.id === id) || EXAMPLES[0];
  S.exId = ex.id;
  store.set('last', ex.id);
  ta.value = S.drafts[ex.id] != null ? S.drafts[ex.id] : ex.code;
  ta.scrollTop = 0;
  ta.scrollLeft = 0;
  S.tab = ex.focus;
  renderExamples();
  renderSub();
  compileAndRun();
  panel.scrollTop = 0;
}

/* ─────────────────────────── the pipeline ────────────────────────── */

function compileAndRun() {
  clearTimeout(debounce);
  const my = ++S.gen;
  stopPlay();
  V.m = null; V.snap = null; V.step = 0; V.listingFn = null;
  S.execLine = 0; S.hot = null; S.hover = null;
  hideTip();
  S.dirty = false;

  const f = A.front(ta.value);
  S.front = f;
  S.run = null;
  if (!f.ok) { renderAll(); afterFirst(); return; }

  const m = A.machine(f.compiled, { profile: true });
  const run = { m, steps: 0, ms: 0, running: true, out: m.out, error: null, value: undefined, profile: null };
  S.run = run;

  const slice = () => {
    if (my !== S.gen) return;
    const t0 = performance.now();
    m.exec(m.state.steps + SLICE);
    run.ms += performance.now() - t0;
    run.steps = m.state.steps;
    if (!m.state.halted && run.steps < MAX_STEPS) {
      renderStages(); renderNote();
      if (S.tab === 'output' || S.tab === 'vm') renderPanel();
      setTimeout(slice, 0);
      return;
    }
    finishRun(run);
  };
  slice();
}

function finishRun(run) {
  const m = run.m;
  run.running = false;
  run.profile = m.profile();
  run.out = m.out;
  if (!m.state.halted) {
    run.error = {
      stage: 'runtime', start: null, end: null, line: 0,
      msg: run.stoppedByUser
        ? 'você parou a execução depois de ' + nf(run.steps) + ' instruções'
        : 'interrompido depois de ' + nf(run.steps) + ' instruções — há um laço que nunca termina?',
    };
  } else if (m.state.error) {
    run.error = m.state.error;
  } else {
    run.value = m.state.value;
  }
  renderAll();
  afterFirst();
}

function stopRun() {
  if (!S.run || !S.run.running) return;
  S.gen++;
  S.run.stoppedByUser = true;
  finishRun(S.run);
}

function afterFirst() {
  if (!S.first) return;
  S.first = false;
  if (!S.booting) return;
  setTimeout(() => {
    S.booting = false;
    stagesEl.classList.remove('boot');
  }, 2400);
}

function renderAll() {
  renderEditor();
  renderStages();
  renderNote();
  renderPanel();
}

/* ─────────────────────────── stage strip ─────────────────────────── */

function countNodes(ast) {
  if (ast._count == null) { let n = 0; A.walk(ast, () => n++); ast._count = n; }
  return ast._count;
}

function stageInfo(i) {
  const f = S.front, r = S.run;
  const failAt = f.error ? ORDER[f.error.stage] : (r && r.error ? 4 : 99);
  if (i > failAt) return { cls: 'is-skip', time: '—', count: 'não rodou' };
  if (i === failAt) {
    const err = f.error || r.error;
    return {
      cls: 'is-fail',
      time: err.line ? 'linha ' + err.line : 'erro',
      count: i === 4 ? 'erro no passo ' + compact(r.steps) : 'erro aqui',
    };
  }
  switch (STAGES[i].id) {
    case 'lex': return { cls: 'is-ok', time: ms(f.timing.lex), count: plural(f.tokens.length - 1, 'token', 'tokens') };
    case 'parse': return { cls: 'is-ok', time: ms(f.timing.parse), count: plural(countNodes(f.ast), 'nó', 'nós') };
    case 'type': return { cls: 'is-ok', time: ms(f.timing.type), count: plural(f.typeStats.unifications, 'unificação', 'unificações') };
    case 'compile': return { cls: 'is-ok', time: ms(f.timing.compile), count: plural(f.compiled.bytes, 'byte', 'bytes') };
    default:
      if (!r) return { cls: '', time: '—', count: '' };
      if (r.running) return { cls: 'is-running', time: ms(r.ms), count: compact(r.steps) + ' passos…' };
      return { cls: 'is-ok', time: ms(r.ms), count: r.steps === 1 ? '1 passo' : compact(r.steps) + ' passos' };
  }
}

function printedLines(out) {
  return out && out.length ? out.join('\n').split('\n') : [];
}

function outInfo() {
  const r = S.run;
  if (!S.front.ok) return { cls: 'is-skip', time: '—', count: 'não rodou' };
  if (!r || r.running) return { cls: '', time: '…', count: '' };
  const n = printedLines(r.out).length;
  return {
    cls: r.error ? 'is-fail' : 'is-ok',
    time: n ? plural(n, 'linha', 'linhas') : 'folha vazia',
    count: r.error ? 'terminou com erro' : 'impressas',
  };
}

function stageCell(tab, n, name, info, i, extra) {
  const sel = S.tab === tab;
  return '<button type="button" role="tab" id="tab-' + tab + '" class="stage ' + extra + ' ' + (info.cls || '') +
    '" style="--i:' + i + '" aria-selected="' + sel + '" aria-controls="panel" tabindex="' + (sel ? 0 : -1) +
    '" data-tab="' + tab + '"><span class="stage-n" aria-hidden="true">' + n + '</span>' +
    '<span class="stage-name">' + name + '</span>' +
    '<span class="stage-time">' + esc(info.time) + '</span>' +
    '<span class="stage-count">' + esc(info.count) + '</span></button>';
}

function renderStages() {
  if (!S.front) return;
  const hadFocus = stagesEl.contains(document.activeElement);
  if (S.booting && S.first) stagesEl.classList.add('boot');
  const cells = STAGES.map((st, i) => stageCell(st.tab, st.n, st.name, stageInfo(i), i, ''));
  cells.push(stageCell('output', '≡', 'Saída', outInfo(), 5, 'stage-out'));
  const keep = stagesEl.scrollLeft;
  stagesEl.innerHTML = cells.join('');
  stagesEl.scrollLeft = keep;
  revealIn(stagesEl, $('tab-' + S.tab));
  if (hadFocus) $('tab-' + S.tab).focus();
}

stagesEl.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

stagesEl.addEventListener('keydown', e => {
  let i = TABS.indexOf(S.tab);
  if (e.key === 'ArrowRight') i = (i + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') i = (i + TABS.length - 1) % TABS.length;
  else if (e.key === 'Home') i = 0;
  else if (e.key === 'End') i = TABS.length - 1;
  else return;
  e.preventDefault();
  setTab(TABS[i]);
  $('tab-' + TABS[i]).focus();
});

function setTab(tab) {
  if (S.tab === tab) return;
  const leavingVm = S.tab === 'vm';
  S.tab = tab;
  S.hot = null;
  if (leavingVm) { stopPlay(); S.execLine = 0; V.listingFn = null; }
  renderEditor();
  renderStages();
  renderPanel();
  panel.scrollTop = 0;
}

/* ──────────────────────────── status line ────────────────────────── */

function renderNote() {
  const f = S.front, r = S.run;
  note.className = 'note';
  if (S.dirty) {
    note.innerHTML = '<span class="note-tag">editando</span><span class="note-msg">recompila assim que você parar de digitar</span>';
    return;
  }
  const err = currentError();
  if (err) {
    note.classList.add('is-err');
    note.innerHTML = '<span class="note-tag">' + STAGE_LABEL[err.stage] + '</span>' +
      '<span class="note-msg">' + esc(err.msg) +
      (err.line ? ' <span class="note-num">· linha ' + err.line + '</span>' : '') + '</span>' +
      (err.line ? '<button type="button" class="linkish" data-goto="' + err.line + '">mostrar no código</button>' : '');
    return;
  }
  if (r && r.running) {
    note.innerHTML = '<span class="note-tag">rodando</span><span class="note-msg"><span class="note-num">' +
      nf(r.steps) + '</span> instruções até agora</span><button type="button" class="linkish" data-stop>parar</button>';
    return;
  }
  if (r) {
    const total = f.timing.lex + f.timing.parse + f.timing.type + f.timing.compile + r.ms;
    note.innerHTML = '<span class="note-tag">pronto</span><span class="note-msg">cinco estágios em <span class="note-num">' +
      ms(total) + '</span> · a máquina executou <span class="note-num">' + nf(r.steps) + '</span> instruções</span>';
  }
}

note.addEventListener('click', e => {
  if (e.target.closest('[data-stop]')) { stopRun(); return; }
  const g = e.target.closest('[data-goto]');
  if (!g) return;
  const err = currentError();
  ta.focus();
  if (err && err.start != null) ta.setSelectionRange(err.start, Math.max(err.start, err.end));
  scrollToLine(Number(g.dataset.goto));
});

/* ─────────────────────────────── panes ───────────────────────────── */

function head(title, paras) {
  return '<div class="pane-head"><h2>' + title + '</h2>' + (paras || []).map(p => '<p>' + p + '</p>').join('') + '</div>';
}

/* when an earlier stage failed, later panes explain instead of showing stale data */
function blockedAt(idx) {
  const f = S.front;
  if (!f.error) return null;
  const at = ORDER[f.error.stage];
  if (at > idx) return null;
  const st = STAGES[at];
  return '<div class="pane"><div class="halt"><div class="label">parou no estágio ' + st.n + ' · ' + st.name + '</div>' +
    '<p class="halt-msg">' + esc(f.error.msg) + '</p>' +
    (f.error.line ? '<div class="label">linha ' + f.error.line + '</div>' : '') +
    '<p class="halt-why">' + WHY[f.error.stage] + '</p></div></div>';
}

function renderPanel() {
  panel.setAttribute('aria-labelledby', 'tab-' + S.tab);
  if (!S.front) return;
  const build = { tokens: paneTokens, ast: paneTree, types: paneTypes, bytecode: paneBytecode, vm: paneVm, output: paneOutput }[S.tab];
  panel.innerHTML = build();
  if (S.tab === 'vm') vmMount();
}

/* point at source from any panel row carrying data-s/data-e or data-line */
panel.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-s],[data-line]');
  let span = null;
  if (el && el.dataset.s != null) span = { start: +el.dataset.s, end: +el.dataset.e };
  else if (el && el.dataset.line) {
    const lines = ta.value.split('\n'), n = +el.dataset.line;
    let off = 0;
    for (let i = 0; i < n - 1 && i < lines.length; i++) off += lines[i].length + 1;
    span = { start: off, end: off + (lines[n - 1] || '').length };
  }
  if ((span && S.hot && span.start === S.hot.start && span.end === S.hot.end) || (!span && !S.hot)) return;
  S.hot = span;
  renderEditor();
});
panel.addEventListener('mouseleave', () => { if (S.hot) { S.hot = null; renderEditor(); } });

panel.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) { vmAction(act.dataset.act); return; }
  const sp = e.target.closest('[data-speed]');
  if (sp) { V.speed = +sp.dataset.speed; store.set('speed', V.speed); paintTransport(); return; }
  const src = e.target.closest('[data-s]');
  if (src) { scrollToLine(lineOf(+src.dataset.s)); return; }
  const ln = e.target.closest('[data-line]');
  if (ln) scrollToLine(+ln.dataset.line);
});

/* ── 1 · tokens ── */

const KIND = { kw: 'palavra-chave', ident: 'nome', num: 'número', str: 'texto', op: 'operador', punct: 'pontuação' };

function chip(t, src) {
  let text = t.type === 'str' || t.type === 'num' ? src.slice(t.start, t.end) : String(t.value);
  text = text.replace(/\n/g, '↵');
  if (text.length > 30) text = text.slice(0, 28) + '…';
  return '<span class="chip ' + tokClass(t).replace('t-', 'c-') + '" data-s="' + t.start + '" data-e="' + t.end +
    '" title="' + (LIB.has(t.value) && t.type === 'ident' ? 'nome da biblioteca' : KIND[t.type]) + ' · linha ' + t.line + '">' + esc(text) + '</span>';
}

function paneTokens() {
  const b = blockedAt(0);
  if (b) return b;
  const f = S.front, src = f.src;
  const toks = f.tokens.filter(t => t.type !== 'eof');
  const rows = [];
  let line = -1, buf = '';
  for (const t of toks) {
    if (t.line !== line) {
      if (line > 0) rows.push('<div class="tokrow"><span class="ln">' + line + '</span><span class="chips">' + buf + '</span></div>');
      line = t.line; buf = '';
    }
    buf += chip(t, src);
  }
  if (line > 0) rows.push('<div class="tokrow"><span class="ln">' + line + '</span><span class="chips">' + buf + '</span></div>');

  const legend = [['c-kw', 'palavra-chave'], ['c-id', 'nome'], ['c-lib', 'biblioteca'], ['c-num', 'número'], ['c-str', 'texto'], ['c-op', 'operador']]
    .map(([c, l]) => '<span class="' + c + '"><i></i>' + l + '</span>').join('');

  return '<div class="pane">' + head('Tokens', [
    'O lexer lê ' + plural(src.length, 'caractere', 'caracteres') + ' e devolve ' + plural(toks.length, 'token', 'tokens') +
    ' — as palavras da linguagem. ' + (f.trivia.length ? plural(f.trivia.length, 'comentário fica', 'comentários ficam') + ' para trás, junto com o espaço em branco: o parser nunca os vê.' : 'O espaço em branco fica para trás: o parser nunca o vê.'),
    'Passe o mouse num token para ver de onde ele veio; clique para rolar o editor até ele.',
  ]) + '<div class="legend">' + legend + '</div><div class="tokrows">' + rows.join('') + '</div></div>';
}

/* ── 2 · tree ── */

function nodeLabel(n, src) {
  switch (n.k) {
    case 'Program': return ['programa', '', ''];
    case 'Def': return ['let', n.name, ''];
    case 'Let': return ['let … in', n.name, ''];
    case 'Fn': return ['fn', '(' + n.params.map(p => p.name).join(', ') + ')', ''];
    case 'Call': return ['chamada', n.callee.k === 'Var' ? n.callee.name : '', ''];
    case 'Index': return ['índice', '', ''];
    case 'If': return ['if', '', ''];
    case 'Bin': return [n.op, '', ''];
    case 'Un': return [n.op, 'unário', ''];
    case 'List': return ['lista', plural(n.items.length, 'item', 'itens'), ''];
    case 'Block': return ['bloco', plural(n.items.length, 'instrução', 'instruções'), ''];
    case 'Num': return ['', src.slice(n.start, n.end), ' c-num'];
    case 'Bool': return ['', String(n.v), ' c-lit'];
    case 'Str': {
      const s = JSON.stringify(n.v);
      return ['', s.length > 32 ? s.slice(0, 30) + '…"' : s, ' c-str'];
    }
    case 'Var': return ['', n.name, LIB.has(n.name) ? ' c-lib' : ''];
  }
  return [n.k, '', ''];
}

function paneTree() {
  const b = blockedAt(1);
  if (b) return b;
  const f = S.front, src = f.src;
  const typed = !f.error;
  const rows = [];
  const visit = (n, prefix, last, root) => {
    const guide = root ? '' : prefix + (last ? '└─ ' : '├─ ');
    const [k, d, dc] = nodeLabel(n, src);
    const ty = !typed ? '' : n.k === 'Def' && n.scheme ? A.schemeStr(n.scheme) : n.ty ? A.typeStr(n.ty) : '';
    const at = n.k === 'Program' ? '' : ' data-s="' + n.start + '" data-e="' + n.end + '"';
    rows.push('<div class="node"' + at + '><span><span class="g">' + guide + '</span>' +
      (k ? '<span class="nk">' + esc(k) + '</span>' + (d ? ' ' : '') : '') +
      (d ? '<span class="nd' + dc + '">' + esc(d) + '</span>' : '') +
      '</span><span class="nt">' + esc(ty) + '</span></div>');
    const kids = A.children(n);
    const next = root ? '' : prefix + (last ? '   ' : '│  ');
    kids.forEach((c, i) => visit(c, next, i === kids.length - 1, false));
  };
  visit(f.ast, '', true, true);

  return '<div class="pane">' + head('Árvore sintática', [
    'O parser organiza os tokens em ' + plural(countNodes(f.ast), 'nó', 'nós') + '. A precedência já está resolvida aqui: em <code>a + b * c</code>, a multiplicação fica mais funda na árvore, então é calculada primeiro.',
    typed ? 'À direita, o tipo que a inferência atribuiu a cada nó.' : 'Os tipos não aparecem porque a inferência falhou — veja o painel Tipos.',
  ]) + '<div class="scroll-x"><div class="tree">' + rows.join('') + '</div></div></div>';
}

/* ── 3 · types ── */

function schemeHTML(s) {
  const str = A.schemeStr(s);
  const m = str.match(/^(∀[^.]*\.\s)(.*)$/);
  return m ? '<span class="q">' + esc(m[1]) + '</span>' + esc(m[2]) : esc(str);
}

function paneTypes() {
  const b = blockedAt(2);
  if (b) return b;
  const f = S.front;
  const sigs = f.bindings.map(bd => {
    const at = ' data-s="' + bd.start + '" data-e="' + bd.end + '"';
    return '<dt' + at + '>' + esc(bd.name) + '</dt><dd' + at + '>' + schemeHTML(bd.scheme) + '</dd>';
  }).join('');

  const figures = '<div class="figures">' +
    '<div class="figure"><span class="label">unificações</span><b>' + nf(f.typeStats.unifications) + '</b></div>' +
    '<div class="figure"><span class="label">variáveis de tipo</span><b>' + nf(f.typeStats.tvars) + '</b></div>' +
    '<div class="figure"><span class="label">tempo</span><b>' + ms(f.timing.type) + '</b></div></div>';

  return '<div class="pane">' + head('Tipos', [
    'Nenhum tipo aqui foi escrito à mão. Cada expressão recebe uma variável de tipo, cada uso vira uma equação, e a unificação resolve todas de uma vez — é o Algoritmo W, de Hindley e Milner.',
    '<span class="q">∀</span> marca um tipo que continua genérico: cada uso recebe cópias novas das suas variáveis. É assim que uma única função serve para Num, Str e listas.',
  ]) + figures +
    (sigs ? '<dl class="sigs">' + sigs + '</dl>' : '<p class="waiting">Este programa não define nada no nível de cima.</p>') +
    '<div class="result-type"><span class="label">o programa inteiro vale</span><span class="ty">' + esc(A.typeStr(f.topType)) + '</span></div>' +
    '<p class="aside">Passe o mouse sobre qualquer expressão no editor para ver o tipo dela — inclusive como uma função genérica da biblioteca foi instanciada naquele ponto.</p></div>';
}

/* ── 4 · bytecode ── */

const CONTROL = new Set(['JMP', 'JMPF', 'JMPF_KEEP', 'JMPT_KEEP', 'CALL', 'TAILCALL', 'RET', 'CLOSURE']);
const OP_HELP = {
  CONST: 'empilha uma constante', NIL: 'empilha nil', TRUE: 'empilha true', FALSE: 'empilha false',
  POP: 'descarta o topo da pilha',
  NEWCELL: 'cria a célula de uma variável local — antes do valor, para que uma função possa capturar a si mesma',
  STORE: 'desempilha e guarda numa variável local', LOAD: 'empilha uma variável local',
  LOADUP: 'empilha uma variável capturada por esta closure',
  NEWGLOBAL: 'reserva um nome global', STOREG: 'desempilha e guarda num nome global', LOADG: 'empilha um nome global',
  JMP: 'salta para outro endereço', JMPF: 'desempilha; salta se for false',
  JMPF_KEEP: 'o && em curto-circuito: se o topo for false, salta e o mantém',
  JMPT_KEEP: 'o || em curto-circuito: se o topo não for false, salta e o mantém',
  CALL: 'chama uma função, empilhando uma frame nova',
  TAILCALL: 'chamada de cauda: reaproveita a frame atual em vez de empilhar outra',
  RET: 'devolve o topo da pilha para quem chamou',
  CLOSURE: 'cria uma closure, capturando as células de que ela precisa',
  LIST: 'junta os n valores do topo numa lista', INDEX: 'lista[i]',
  ADD: 'soma', SUB: 'subtração', MUL: 'multiplicação', DIV: 'divisão', MOD: 'resto',
  NEG: 'troca o sinal', NOT: 'nega um Bool', CONCAT: 'junta duas Strs',
  EQ: 'igualdade estrutural', NEQ: 'diferença estrutural', LT: 'menor que', GT: 'maior que', LE: 'menor ou igual', GE: 'maior ou igual',
};

const listingCache = new WeakMap();
function rowsOf(fn) {
  let rows = listingCache.get(fn);
  if (!rows) { rows = A.disassemble(fn); listingCache.set(fn, rows); }
  return rows;
}

function fnMeta(fn) {
  const parts = [plural(fn.arity, 'parâmetro', 'parâmetros'), plural(fn.slots, 'slot', 'slots')];
  if (fn.upvals.length) parts.push('captura ' + fn.upvalNames.join(', '));
  parts.push(plural(fn.code.length, 'byte', 'bytes'));
  return parts.join(' · ');
}

function listingHTML(fn) {
  return '<table class="listing"><tbody>' + rowsOf(fn).map(r => {
    const ln = !fn.prelude && r.line ? r.line : '';
    return '<tr class="' + (CONTROL.has(r.op) ? 'op-ctl' : '') + '" data-at="' + r.at + '"' +
      (ln ? ' data-line="' + ln + '"' : '') + ' title="' + esc(OP_HELP[r.op] || '') + '">' +
      '<td class="at">' + String(r.at).padStart(3, '0') + '</td>' +
      '<td class="op">' + r.op + '</td>' +
      '<td class="arg">' + r.args.join(' ') + '</td>' +
      '<td class="nt">' + esc(r.note) + '</td>' +
      '<td class="ln">' + ln + '</td></tr>';
  }).join('') + '</tbody></table>';
}

function paneBytecode() {
  const b = blockedAt(3);
  if (b) return b;
  const c = S.front.compiled;
  const blocks = c.functions.map(fn => {
    const tail = rowsOf(fn).some(r => r.op === 'TAILCALL');
    return '<section class="fnblock"><header class="fnhead"><span class="fn-name">' +
      esc(fn.name === 'main' ? 'main — o programa' : fn.name) + '</span><span class="fn-meta">' + fnMeta(fn) + '</span>' +
      (tail ? '<span class="tag">chamada de cauda</span>' : '') +
      '</header><div class="scroll-x">' + listingHTML(fn) + '</div></section>';
  }).join('');

  const nested = c.functions.find(fn => fn.name.indexOf('.') > 0);
  return '<div class="pane">' + head('Bytecode', [
    plural(c.functions.length, 'função', 'funções') + ', ' + plural(c.bytes, 'byte', 'bytes') +
    '. O compilador achata a árvore em instruções para uma máquina de pilha: operandos são empilhados, operadores desempilham e empilham o resultado.' +
    (nested ? ' Nomes com ponto, como <code>' + esc(nested.name) + '</code>, são funções aninhadas; <code>λ</code> é uma função sem nome.' : ''),
    'Passe o mouse numa instrução para ver o que ela faz. As faixas verdes são as do formulário contínuo em que os compiladores imprimiam suas listagens.',
  ]) + blocks + '</div>';
}

/* ── 5 · machine ── */

const ICON = {
  start: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h2.2v12H2zM14 2v12L5.5 8z"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.8 2H14v12h-2.2zM10.5 2v12L2 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h3.6v12H3zM9.4 2H13v12H9.4z"/></svg>',
  fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h2.2v12H2zM5.5 2v12L14 8z"/></svg>',
  line: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 1.5h2V9h3l-4 5-4-5h3z"/></svg>',
};

function paneVm() {
  const b = blockedAt(3);
  if (b) return b;
  const r = S.run;
  if (!r || r.running) {
    return '<div class="pane">' + head('Máquina') + '<p class="waiting">A máquina ainda está rodando — ' +
      nf(r ? r.steps : 0) + ' instruções até agora. O depurador abre quando ela terminar.</p></div>';
  }
  return '<div class="pane vm">' + head('Máquina', [
    'O gráfico é a profundidade da pilha de chamadas ao longo de toda a execução: recursão aparece como montanhas; um laço com chamada de cauda, como uma linha reta. Clique ou arraste nele para viajar no tempo.',
    'A máquina é determinística, então voltar no tempo é só executar de novo, do zero, até aquele passo.',
  ]) +
    '<figure class="depth"><canvas id="depth" tabindex="0" role="slider" aria-label="Posição na execução" aria-valuemin="0" aria-valuemax="' +
      r.steps + '" aria-valuenow="0"></canvas><figcaption><span id="depth-cap"></span><span id="depth-read"></span></figcaption></figure>' +
    '<div class="transport">' +
      '<button type="button" class="tbtn" data-act="start" title="Voltar ao início (Home)" aria-label="Voltar ao início">' + ICON.start + '</button>' +
      '<button type="button" class="tbtn" data-act="back" title="Um passo atrás (←)" aria-label="Um passo atrás">' + ICON.back + '</button>' +
      '<button type="button" class="tbtn primary" data-act="play" id="play-btn"></button>' +
      '<button type="button" class="tbtn" data-act="fwd" title="Um passo à frente (→)" aria-label="Um passo à frente">' + ICON.fwd + '</button>' +
      '<button type="button" class="tbtn" data-act="line" title="Avança até a próxima linha do código, sem entrar nas chamadas">' + ICON.line + '<span>próxima linha</span></button>' +
      '<div class="speed" role="radiogroup" aria-label="Velocidade">' + SPEEDS.map((s, i) =>
        '<button type="button" role="radio" data-speed="' + i + '" aria-checked="' + (i === V.speed) + '">' + s.label + '</button>').join('') + '</div>' +
      '<output class="stepcount" id="stepcount"></output>' +
    '</div>' +
    '<div class="vm-grid">' +
      '<section class="box vm-code"><header class="box-h"><span>executando <b id="vm-fn"></b></span><span id="vm-fnmeta"></span></header>' +
        '<div class="scroll" id="vm-listing"></div></section>' +
      '<div class="vm-side">' +
        '<section class="box"><header class="box-h"><span>pilha de chamadas</span><span id="vm-depth"></span></header><ol class="frames" id="vm-frames"></ol></section>' +
        '<section class="box"><header class="box-h"><span>pilha de operandos</span><span id="vm-stackn"></span></header><ol class="opstack" id="vm-stack"></ol></section>' +
        '<section class="box"><header class="box-h"><span>variáveis desta frame</span></header><dl class="vars" id="vm-vars"></dl></section>' +
      '</div>' +
    '</div>' +
    '<section class="box printed"><header class="box-h"><span>saída até este passo</span><span id="vm-outn"></span></header><pre id="vm-out"></pre></section>' +
  '</div>';
}

const resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawDepth()) : null;

function vmMount() {
  const cv = $('depth');
  if (!cv) return;
  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    cv.focus();
    V.drag = true;
    stopPlay();
    seekFromEvent(e);
  });
  cv.addEventListener('pointermove', e => { if (V.drag) seekFromEvent(e); readout(e); });
  cv.addEventListener('pointerup', () => { V.drag = false; });
  cv.addEventListener('pointercancel', () => { V.drag = false; });
  cv.addEventListener('pointerleave', () => { if (!V.drag) $('depth-read').textContent = ''; });
  if (resizeObs) { resizeObs.disconnect(); resizeObs.observe(cv); }

  const P = S.run.profile;
  let maxD = 1;
  for (const d of P.data) if (d > maxD) maxD = d;
  $('depth-cap').textContent = 'profundidade máxima ' + maxD + ' · ' + plural(S.run.steps, 'passo', 'passos');

  V.listingFn = null;
  if (V.m && V.snap) paintVm(); else seek(0);
}

let seekRaf = 0, seekTarget = 0;
function seekFromEvent(e) {
  const r = e.currentTarget.getBoundingClientRect();
  /* width - 1, so the last pixel is the last step */
  seekTarget = Math.round(clamp((e.clientX - r.left) / Math.max(1, r.width - 1), 0, 1) * S.run.steps);
  if (!seekRaf) seekRaf = requestAnimationFrame(() => { seekRaf = 0; seek(seekTarget); });
}

function readout(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const step = Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * S.run.steps);
  const P = S.run.profile;
  const d = P.data[Math.min(P.data.length - 1, Math.floor(step / P.stride))] || 1;
  $('depth-read').textContent = 'passo ' + nf(step) + ' · profundidade ' + d;
}

/* Deterministic replay: going back means running a fresh machine forward. */
function seek(k) {
  if (!S.run || !S.front || !S.front.ok) return;
  k = clamp(Math.round(k), 0, S.run.steps);
  if (!V.m || k < V.m.state.steps) V.m = A.machine(S.front.compiled);
  if (k > V.m.state.steps) V.m.exec(k);
  V.step = V.m.state.steps;
  V.snap = V.m.snapshot();
  paintVm();
}

function nextLine() {
  if (!V.m) seek(0);
  const m = V.m, total = S.run.steps;
  /* start from the line the user sees — the nearest frame of their own code,
     not a prelude frame (map.go and friends) that may be on top */
  let startLine = 0, startDepth = 0;
  const frames = V.snap ? V.snap.frames : [];
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!frames[i].prelude) { startLine = frames[i].line; startDepth = i + 1; break; }
  }
  let guard = 0;
  while (m.state.steps < total && !m.state.halted && guard++ < 2e6) {
    m.exec(m.state.steps + 1);
    const w = m.where();
    if (!w) break;
    if (!w.prelude && w.depth <= startDepth && w.line !== startLine) break;
  }
  V.step = m.state.steps;
  V.snap = m.snapshot();
  paintVm();
}

function vmAction(a) {
  if (!S.run || S.run.running) return;
  if (a === 'play') { if (V.playing) stopPlay(); else play(); return; }
  stopPlay();
  if (a === 'start') seek(0);
  else if (a === 'back') seek(V.step - 1);
  else if (a === 'fwd') seek(V.step + 1);
  else if (a === 'line') nextLine();
}

function play() {
  if (!S.run) return;
  if (V.step >= S.run.steps) seek(0);
  V.playing = true;
  V.last = performance.now();
  V.carry = 0;
  seek(V.step + 1);
  paintTransport();
  requestAnimationFrame(tick);
}

function tick(now) {
  if (!V.playing) return;
  if (S.tab !== 'vm' || !S.run) { V.playing = false; return; }
  const dt = Math.min(0.25, (now - V.last) / 1000);
  V.last = now;
  V.carry += dt * SPEEDS[V.speed].sps;
  const n = Math.floor(V.carry);
  if (n > 0) { V.carry -= n; seek(V.step + n); }
  if (V.step >= S.run.steps) { V.playing = false; paintTransport(); return; }
  requestAnimationFrame(tick);
}

function stopPlay() {
  if (!V.playing) return;
  V.playing = false;
  paintTransport();
}

function paintTransport() {
  const b = $('play-btn');
  if (!b || !S.run) return;
  const label = V.playing ? 'Pausar' : V.step >= S.run.steps ? 'Do início' : V.step > 0 ? 'Continuar' : 'Executar';
  b.innerHTML = (V.playing ? ICON.pause : ICON.play) + '<span>' + label + '</span>';
  panel.querySelectorAll('[data-speed]').forEach(x => x.setAttribute('aria-checked', String(+x.dataset.speed === V.speed)));
}

function keepVisible(box, el) {
  const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (er.top < br.top + er.height) box.scrollTop += er.top - br.top - er.height * 2;
  else if (er.bottom > br.bottom - er.height) box.scrollTop += er.bottom - br.bottom + er.height * 3;
}

function paintVm() {
  const s = V.snap;
  if (!s || !$('depth')) return;
  const total = S.run.steps;

  $('stepcount').innerHTML = 'passo <b>' + nf(s.steps) + '</b> de ' + nf(total);
  const cv = $('depth');
  cv.setAttribute('aria-valuenow', s.steps);
  cv.setAttribute('aria-valuetext', 'passo ' + nf(s.steps) + ' de ' + nf(total));
  drawDepth();

  /* listing of the function on top of the call stack */
  const top = s.frames[s.frames.length - 1];
  const lst = $('vm-listing');
  if (!top) {
    V.listingFn = null;
    $('vm-fn').textContent = s.error ? 'nada — falhou' : 'nada — terminou';
    $('vm-fnmeta').textContent = '';
    lst.innerHTML = '<p class="waiting" style="padding:12px 12px 14px;margin:0">' +
      (s.error ? esc(s.error.msg) : 'A máquina parou. O programa vale <b>' + esc(valueText(s.value)) + '</b>.') + '</p>';
  } else {
    if (V.listingFn !== top.fn) {
      V.listingFn = top.fn;
      $('vm-fn').textContent = top.fn.name;
      $('vm-fnmeta').textContent = top.fn.prelude ? 'prelúdio · escrito em Aurora' : fnMeta(top.fn);
      lst.innerHTML = listingHTML(top.fn);
    }
    lst.querySelectorAll('tr.is-cur, tr.is-fault').forEach(r => r.classList.remove('is-cur', 'is-fault'));
    const target = s.error ? top.ip - 1 : top.ip;
    let row = null;
    for (const r of rowsOf(top.fn)) if (r.at <= target) row = r; else break;
    const tr = row && lst.querySelector('tr[data-at="' + row.at + '"]');
    if (tr) { tr.classList.add(s.error ? 'is-fault' : 'is-cur'); keepVisible(lst, tr); }
  }

  /* call stack, current frame first */
  $('vm-depth').textContent = s.frames.length ? 'profundidade ' + s.frames.length : '';
  const shown = s.frames.slice(-40).reverse();
  $('vm-frames').innerHTML = s.frames.length
    ? shown.map((fr, i) => '<li class="' + (i === 0 ? 'is-top' : '') + (fr.prelude ? ' is-pre' : '') + '"><span>' +
        esc(fr.name) + '</span><span>' + (fr.prelude ? '' : 'linha ' + fr.line) + '</span></li>').join('') +
      (s.frames.length > 40 ? '<li class="empty"><span>+ ' + nf(s.frames.length - 40) + ' frames abaixo</span></li>' : '')
    : '<li class="empty"><span>' + (s.error ? 'parou com erro' : 'vazia — a máquina parou') + '</span></li>';

  /* operand stack, top first */
  $('vm-stackn').textContent = s.stackLen ? plural(s.stackLen, 'valor', 'valores') : '';
  const st = s.stack.slice().reverse();
  $('vm-stack').innerHTML = st.length
    ? st.map((v, i) => '<li class="' + (i === 0 ? 'is-top' : '') + '"><span>' + (s.stackLen - i - 1) + '</span><span>' + esc(v) + '</span></li>').join('') +
      (s.stackLen > st.length ? '<li class="empty"><span></span><span>+ ' + nf(s.stackLen - st.length) + ' abaixo</span></li>' : '')
    : '<li class="empty"><span></span><span>vazia</span></li>';

  /* locals and captured cells */
  const vars = s.locals.map(l => '<dt>' + esc(l.name) + '</dt><dd' + (l.live ? '' : ' class="unset"') + '>' +
      (l.live ? esc(l.value) : 'ainda não criada') + '</dd>')
    .concat(s.upvals.map(u => '<dt>' + esc(u.name) + ' <span class="cap">capturada</span></dt><dd>' + esc(u.value) + '</dd>'))
    .join('');
  $('vm-vars').innerHTML = vars || '<dt class="unset">—</dt><dd class="unset">esta frame não tem variáveis</dd>';

  /* what has been printed so far */
  const lines = printedLines(s.out);
  $('vm-outn').textContent = lines.length ? plural(lines.length, 'linha', 'linhas') : '';
  const outEl = $('vm-out');
  outEl.textContent = lines.length ? lines.slice(-80).join('\n') : '(nada ainda)';
  outEl.scrollTop = outEl.scrollHeight;

  /* follow along in the editor */
  let line = 0;
  for (let i = s.frames.length - 1; i >= 0; i--) if (!s.frames[i].prelude) { line = s.frames[i].line; break; }
  if (line !== S.execLine) {
    S.execLine = line;
    renderEditor();
    if (line) scrollToLine(line);
  }

  paintTransport();
}

let colorCache = null;
function colors() {
  if (colorCache) return colorCache;
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  colorCache = { live: v('--live'), ink: v('--ink'), ink3: v('--ink-3'), rule: v('--rule'), sheet: v('--sheet') };
  return colorCache;
}
const themeChanged = () => { colorCache = null; drawDepth(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function drawDepth() {
  const cv = $('depth');
  if (!cv || !S.run || !S.run.profile) return;
  const P = S.run.profile, total = Math.max(1, S.run.steps);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const C = colors();

  const data = P.data, stride = P.stride;
  let maxD = 1;
  for (let i = 0; i < data.length; i++) if (data[i] > maxD) maxD = data[i];
  const top = 14, bottom = h - 5;
  const y = d => bottom - (d / maxD) * (bottom - top);

  /* one column per pixel: the deepest the stack got within that slice of time */
  const n = Math.ceil(w);
  const cols = new Array(n);
  for (let x = 0; x < n; x++) {
    const s0 = Math.floor((x / w) * total);
    const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / w) * total));
    const b0 = Math.min(data.length - 1, Math.floor(s0 / stride));
    const b1 = Math.min(data.length - 1, Math.floor((s1 - 1) / stride));
    let m = 0;
    for (let b = b0; b <= b1; b++) if (data[b] > m) m = data[b];
    cols[x] = m;
  }

  g.strokeStyle = C.rule;
  g.lineWidth = 1;
  g.setLineDash([2, 3]);
  g.beginPath();
  g.moveTo(0, Math.round(y(maxD)) + 0.5);
  g.lineTo(w, Math.round(y(maxD)) + 0.5);
  g.stroke();
  g.setLineDash([]);

  const area = new Path2D(), edge = new Path2D();
  area.moveTo(0, bottom);
  for (let x = 0; x < n; x++) {
    const yy = y(cols[x]);
    area.lineTo(x, yy); area.lineTo(x + 1, yy);
    if (x === 0) edge.moveTo(0, yy); else edge.lineTo(x, yy);
    edge.lineTo(x + 1, yy);
  }
  area.lineTo(w, bottom);
  area.closePath();

  const cx = (V.step / total) * w;
  g.fillStyle = C.live;
  g.save(); g.beginPath(); g.rect(0, 0, cx, h); g.clip();
  g.globalAlpha = 0.26; g.fill(area); g.restore();
  g.save(); g.beginPath(); g.rect(cx, 0, w - cx, h); g.clip();
  g.globalAlpha = 0.09; g.fill(area); g.restore();
  g.strokeStyle = C.live;
  g.lineWidth = 1.25;
  g.stroke(edge);

  g.fillStyle = C.ink3;
  g.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText('prof. ' + maxD, 6, Math.max(10, y(maxD) - 3));

  const px = Math.round(cx) + 0.5;
  g.strokeStyle = C.ink;
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
  g.fillStyle = C.ink;
  g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 6); g.closePath(); g.fill();
}

/* keyboard control of the machine, whenever the editor does not have focus */
document.addEventListener('keydown', e => {
  if (S.tab !== 'vm' || !S.run || S.run.running || !$('depth')) return;
  const t = e.target;
  if (t === ta || (t.closest && (t.closest('dialog') || t.closest('.stages') || t.closest('.speed')))) return;
  if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  const big = e.shiftKey ? 100 : 1;
  if (e.key === 'ArrowRight') { stopPlay(); seek(V.step + big); }
  else if (e.key === 'ArrowLeft') { stopPlay(); seek(V.step - big); }
  else if (e.key === 'Home') { stopPlay(); seek(0); }
  else if (e.key === 'End') { stopPlay(); seek(S.run.steps); }
  else if (e.key === ' ') { if (V.playing) stopPlay(); else play(); }
  else return;
  e.preventDefault();
});

/* ── output ── */

function paneOutput() {
  const b = blockedAt(3);
  if (b) return b;
  const r = S.run, f = S.front;
  if (!r || r.running) {
    return '<div class="pane"><p class="waiting">Rodando… ' + nf(r ? r.steps : 0) + ' instruções até agora.</p></div>';
  }
  const lines = printedLines(r.out);
  let body = lines.map((l, i) => '<span class="pl" style="--i:' + i + '">' + esc(l) + '\n</span>').join('');
  if (r.error) {
    body += '<span class="pl perr" style="--i:' + lines.length + '">✕ ' +
      (r.error.line ? 'linha ' + r.error.line + ': ' : '') + esc(r.error.msg) + '</span>';
  }
  if (!lines.length && !r.error) {
    body = '<span class="empty">O programa não imprimiu nada. Use <code>print(...)</code> para escrever nesta folha.</span>';
  }
  const rate = r.steps > 2e5 && r.ms > 0
    ? '<span><b>' + (r.steps / r.ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' milhões</b> de instruções por segundo</span>'
    : '';
  const value = r.error ? '' :
    '<span>valor final <b>' + esc(valueText(r.value)) + '</b> : <span class="ty">' + esc(A.typeStr(f.topType)) + '</span></span>';

  return '<div class="pane">' + head('Saída', ['Tudo o que o programa passou para <code>print</code>, na ordem.']) +
    '<div class="printout"><div class="holes l" aria-hidden="true"></div>' +
    '<pre class="paper' + (S.booting ? ' printing' : '') + '">' + body + '</pre>' +
    '<div class="holes r" aria-hidden="true"></div></div>' +
    '<div class="result">' + value + '<span><b>' + nf(r.steps) + '</b> instruções em <b>' + ms(r.ms) + '</b></span>' + rate + '</div></div>';
}

/* ─────────────────────────────── guide ───────────────────────────── */

const LIB_DOC = {
  print: 'escreve um valor na saída e o devolve',
  str: 'converte qualquer valor em texto',
  len: 'quantos itens tem a lista',
  size: 'quantos caracteres tem a Str',
  push: 'uma lista nova, com um item a mais no fim',
  concat: 'junta duas listas',
  slice: 'os itens de i até j, sem incluir j',
  range: 'os números de a até b, sem incluir b',
  join: 'junta Strs usando um separador',
  charAt: 'o caractere na posição i',
  sqrt: 'raiz quadrada', floor: 'arredonda para baixo', abs: 'valor absoluto',
  min: 'o menor dos dois', max: 'o maior dos dois',
  map: 'aplica f a cada item',
  filter: 'só os itens em que keep devolve true',
  fold: 'reduz a lista a um valor, da esquerda para a direita',
};

let guideBuilt = false;
function buildGuide() {
  guideBuilt = true;
  const sample = code => '<pre class="sample">' + paint(code, []) + '</pre>';
  const lib = Object.keys(A.BUILTIN_TYPES).map(name =>
      '<span class="n">' + name + '</span><span class="s">' + esc(A.schemeStr(A.BUILTIN_TYPES[name])) + '</span><span class="d">' + LIB_DOC[name] + '</span>')
    .concat(PRELUDE.bindings.map(b =>
      '<span class="n">' + b.name + '</span><span class="s">' + esc(A.schemeStr(b.scheme)) + '</span><span class="d">' + LIB_DOC[b.name] + ' <span class="tag">em Aurora</span></span>'))
    .join('');

  $('guide-body').innerHTML =
    '<p>Aurora é pequena de propósito: tudo é uma expressão, todo valor é imutável, e o compilador descobre os tipos sozinho. Números são doubles; listas guardam itens de um único tipo.</p>' +
    '<h3>Nomes</h3>' +
    sample('let x = 10                 # define um nome\nlet y = x * 2 in y + 1     # let … in é uma expressão\n\n{\n  let a = 1\n  let b = 2\n  a + b                    # um bloco vale a sua última expressão\n}') +
    '<p class="explain">No nível de cima, toda definição enxerga todas as outras, então funções podem se chamar mutuamente. Dentro de um bloco, os nomes valem da definição para baixo.</p>' +
    '<h3>Funções</h3>' +
    sample('let dobro = fn(x) => x * 2\nlet soma  = fn(a, b) => a + b\nlet somaN = fn(n) => fn(x) => x + n   # devolve uma função\n\ndobro(soma(1, 2))                     # 6\nmap(somaN(10), [1, 2, 3])             # [11, 12, 13]') +
    '<p class="explain">Funções são valores: podem ser passadas, devolvidas e capturar variáveis de fora. Uma chamada que é a última coisa que a função faz vira <code>TAILCALL</code> e não cresce a pilha.</p>' +
    '<h3>Decisões e operadores</h3>' +
    sample('if n < 2 then n else n * 2          # os dois ramos são obrigatórios\n"au" ++ "rora"                        # ++ junta Strs\n[1, 2] == [1, 2]                      # igualdade é estrutural') +
    '<p class="explain">Do mais fraco ao mais forte: <code>||</code> · <code>&amp;&amp;</code> · <code>== !=</code> · <code>&lt; &gt; &lt;= &gt;=</code> · <code>++</code> · <code>+ -</code> · <code>* / %</code> · e os unários <code>-</code> e <code>!</code>. Uma instrução termina no fim da linha, então o <code>(</code> de uma chamada fica na mesma linha da função.</p>' +
    '<h3>Biblioteca — tipos inferidos agora, pelo próprio compilador</h3>' +
    '<div class="lib">' + lib + '</div>' +
    '<h3>Atalhos</h3>' +
    '<dl class="keys">' +
      '<dt><kbd>' + MOD + '</kbd> <kbd>Enter</kbd></dt><dd>executa agora</dd>' +
      '<dt><kbd>Tab</kbd> <kbd>Shift</kbd> <kbd>Tab</kbd></dt><dd>indenta e desindenta</dd>' +
      '<dt><kbd>Esc</kbd> e depois <kbd>Tab</kbd></dt><dd>sai do editor</dd>' +
      '<dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>na aba Máquina: um passo; com <kbd>Shift</kbd>, cem</dd>' +
      '<dt><kbd>Espaço</kbd></dt><dd>na aba Máquina: executa e pausa</dd>' +
      '<dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>na aba Máquina: início e fim</dd>' +
    '</dl>' +
    '<h3>O prelúdio inteiro</h3>' +
    sample(PRELUDE.src) +
    '<p class="explain">map, filter e fold são escritos na própria Aurora e compilados junto com o seu programa. Como nenhuma função nativa chama código Aurora de volta, a máquina nunca reentra em si mesma — e é isso que permite pausá-la entre duas instruções quaisquer.</p>';
}

const guide = $('guide');
$('open-guide').addEventListener('click', () => {
  if (!guideBuilt) buildGuide();
  if (guide.showModal) guide.showModal(); else guide.setAttribute('open', '');
});
$('close-guide').addEventListener('click', () => guide.close());
guide.addEventListener('click', e => { if (e.target === guide) guide.close(); });

/* ─────────────────────────────── start ───────────────────────────── */

function start() {
  S.drafts = store.get('drafts', {}) || {};
  for (const id in S.drafts) if (!EXAMPLES.some(e => e.id === id)) delete S.drafts[id];
  V.speed = clamp(store.get('speed', 1) | 0, 0, SPEEDS.length - 1);
  measure();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { measure(); renderEditor(); drawDepth(); });
  }
  const last = store.get('last', 'mandelbrot');
  selectExample(EXAMPLES.some(e => e.id === last) ? last : 'mandelbrot');
}

start();
})();
