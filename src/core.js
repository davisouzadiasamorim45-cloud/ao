'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AURORA — a small functional language, in five observable stages.

     source → lexer → parser → type inference (Hindley–Milner)
            → bytecode compiler → resumable stack VM

   Dependency-free and deterministic: the UI can re-run any stage, pause
   the machine at any instruction, and replay it to reach any earlier one.
   ═══════════════════════════════════════════════════════════════════════ */

function AErr(stage, msg, start, end, line) {
  const e = new Error(msg);
  e.aurora = true; e.stage = stage; e.start = start; e.end = end; e.line = line;
  return e;
}

const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/* ───────────────────────────── 1 · LEXER ──────────────────────────────── */

const KEYWORDS = new Set(['let', 'in', 'fn', 'if', 'then', 'else', 'true', 'false']);
const OPS = ['==', '!=', '<=', '>=', '=>', '++', '&&', '||',
             '+', '-', '*', '/', '%', '<', '>', '!', '='];
const PUNCT = new Set(['(', ')', '[', ']', '{', '}', ',', ';']);

const isDigit = c => c >= '0' && c <= '9';
const isIdentStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdent = c => isIdentStart(c) || isDigit(c);

/* `lenient` never throws: the editor's highlighter uses it on half-typed code */
function lex(src, lenient) {
  const tokens = [], trivia = [];
  let i = 0, line = 1, nl = true;
  const emit = (type, value, start, startLine) => {
    tokens.push({ type, value, start, end: i, line: startLine, nl });
    nl = false;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { i++; line++; nl = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '#') {
      const s = i;
      while (i < src.length && src[i] !== '\n') i++;
      trivia.push({ type: 'comment', start: s, end: i, line });
      continue;
    }

    const start = i, startLine = line;

    if (isDigit(c)) {
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === '.' && isDigit(src[i + 1] || '')) {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      emit('num', parseFloat(src.slice(start, i)), start, startLine);
      continue;
    }

    if (isIdentStart(c)) {
      while (i < src.length && isIdent(src[i])) i++;
      const word = src.slice(start, i);
      emit(KEYWORDS.has(word) ? 'kw' : 'ident', word, start, startLine);
      continue;
    }

    if (c === '"') {
      i++;
      let out = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '"' ? '"'
               : esc === '\\' ? '\\' : (esc || '');
          i += 2;
        } else {
          if (src[i] === '\n') line++;
          out += src[i++];
        }
      }
      if (i >= src.length) {
        i = src.length;
        if (!lenient) throw AErr('lex', 'esta string nunca é fechada — termine-a com "', start, i, startLine);
        emit('str', out, start, startLine);
        continue;
      }
      i++;
      emit('str', out, start, startLine);
      continue;
    }

    const op = OPS.find(o => src.startsWith(o, i));
    if (op) { i += op.length; emit('op', op, start, startLine); continue; }

    if (PUNCT.has(c)) { i++; emit('punct', c, start, startLine); continue; }

    if (lenient) { i++; emit('bad', c, start, startLine); continue; }
    throw AErr('lex', 'Aurora não tem o caractere ' + JSON.stringify(c), start, start + 1, line);
  }

  tokens.push({ type: 'eof', value: '', start: i, end: i, line, nl: true });
  return { tokens, trivia };
}

/* ───────────────────────────── 2 · PARSER ─────────────────────────────
   Precedence climbing over a hand-rolled recursive-descent front end.
   `let` / `fn` / `if` are expressions, so they are recognised at every
   precedence entry point rather than treated as statement forms.
   A statement ends at a new line (or ';'), which is why a call's "("
   must sit on the same line as the thing being called.                */

const BINOP = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '++': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

function describe(t) {
  if (t.type === 'eof') return 'o fim do programa';
  if (t.type === 'str') return 'uma string';
  if (t.type === 'num') return 'o número ' + t.value;
  return '"' + t.value + '"';
}

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[Math.min(p, tokens.length - 1)];
  const at = (type, value) => {
    const t = peek();
    return t.type === type && (value === undefined || t.value === value);
  };
  const advance = () => tokens[p++];
  const fail = (msg) => {
    const t = peek();
    throw AErr('parse', msg + ', mas encontrou ' + describe(t), t.start, Math.max(t.end, t.start + 1), t.line);
  };
  const eat = (type, value, what) => {
    if (!at(type, value)) fail('esperava ' + (what || value));
    return advance();
  };
  const span = (node, start, end) => (node.start = start, node.end = end, node);

  /* a block, or the whole program: a run of statements */
  function parseItems(stop) {
    const items = [];
    while (!stop()) {
      const before = p;
      if (at('kw', 'let')) {
        const kw = advance();
        const nameTok = eat('ident', undefined, 'um nome depois de "let"');
        eat('op', '=', '"=" depois de "let ' + nameTok.value + '"');
        const value = parseExpr();
        if (at('kw', 'in')) {
          advance();
          const body = parseExpr();
          items.push(span({ k: 'Let', name: nameTok.value, nameTok, value, body, line: kw.line },
                          kw.start, body.end));
        } else {
          items.push(span({ k: 'Def', name: nameTok.value, nameTok, value, line: kw.line },
                          kw.start, value.end));
        }
      } else {
        items.push(parseExpr());
      }
      if (at('punct', ';')) advance();
      else if (!stop() && !peek().nl) fail('esperava uma nova linha ou ";" antes da próxima instrução');
      if (p === before) fail('o parser não conseguiu avançar');
    }
    return items;
  }

  function parseExpr(minPrec) {
    minPrec = minPrec || 0;

    if (at('kw', 'let')) {
      const kw = advance();
      const nameTok = eat('ident', undefined, 'um nome depois de "let"');
      eat('op', '=', '"=" depois de "let ' + nameTok.value + '"');
      const value = parseExpr();
      eat('kw', 'in', '"in" — dentro de uma expressão, let precisa de um corpo');
      const body = parseExpr();
      return span({ k: 'Let', name: nameTok.value, nameTok, value, body, line: kw.line },
                  kw.start, body.end);
    }
    if (at('kw', 'fn')) {
      const kw = advance();
      eat('punct', '(', '"(" para abrir a lista de parâmetros');
      const params = [];
      while (!at('punct', ')')) {
        const t = eat('ident', undefined, 'um nome de parâmetro');
        params.push({ name: t.value, start: t.start, end: t.end });
        if (at('punct', ',')) advance(); else break;
      }
      eat('punct', ')', '")" para fechar a lista de parâmetros');
      eat('op', '=>', '"=>" antes do corpo da função');
      const body = parseExpr();
      return span({ k: 'Fn', params, body, line: kw.line }, kw.start, body.end);
    }
    if (at('kw', 'if')) {
      const kw = advance();
      const cond = parseExpr();
      eat('kw', 'then', '"then" depois da condição');
      const thenB = parseExpr();
      eat('kw', 'else', '"else" — if é uma expressão, então precisa dos dois ramos');
      const elseB = parseExpr();
      return span({ k: 'If', cond, then: thenB, else: elseB, line: kw.line },
                  kw.start, elseB.end);
    }

    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.type !== 'op') break;
      const prec = BINOP[t.value];
      if (prec === undefined || prec < minPrec) break;
      advance();
      const right = parseExpr(prec + 1);
      left = span({ k: 'Bin', op: t.value, l: left, r: right, line: t.line },
                  left.start, right.end);
    }
    return left;
  }

  function parseUnary() {
    if (at('op', '-') || at('op', '!')) {
      const t = advance();
      const operand = parseUnary();
      return span({ k: 'Un', op: t.value, e: operand, line: t.line }, t.start, operand.end);
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.nl) break;                  /* a new line always ends the expression */
      if (t.type === 'punct' && t.value === '(') {
        advance();
        const args = [];
        while (!at('punct', ')')) {
          args.push(parseExpr());
          if (at('punct', ',')) advance(); else break;
        }
        const close = eat('punct', ')', '")" para fechar os argumentos');
        node = span({ k: 'Call', callee: node, args, line: t.line }, node.start, close.end);
      } else if (t.type === 'punct' && t.value === '[') {
        advance();
        const index = parseExpr();
        const close = eat('punct', ']', '"]" para fechar o índice');
        node = span({ k: 'Index', target: node, index, line: t.line }, node.start, close.end);
      } else break;
    }
    return node;
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'num') { advance(); return span({ k: 'Num', v: t.value, line: t.line }, t.start, t.end); }
    if (t.type === 'str') { advance(); return span({ k: 'Str', v: t.value, line: t.line }, t.start, t.end); }
    if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) {
      advance();
      return span({ k: 'Bool', v: t.value === 'true', line: t.line }, t.start, t.end);
    }
    if (t.type === 'ident') { advance(); return span({ k: 'Var', name: t.value, line: t.line }, t.start, t.end); }
    if (t.type === 'punct' && t.value === '(') {
      advance();
      const inner = parseExpr();
      eat('punct', ')', '")"');
      return inner;
    }
    if (t.type === 'punct' && t.value === '[') {
      advance();
      const items = [];
      while (!at('punct', ']')) {
        items.push(parseExpr());
        if (at('punct', ',')) advance(); else break;
      }
      const close = eat('punct', ']', '"]" para fechar a lista');
      return span({ k: 'List', items, line: t.line }, t.start, close.end);
    }
    if (t.type === 'punct' && t.value === '{') {
      advance();
      const items = parseItems(() => at('punct', '}') || at('eof'));
      const close = eat('punct', '}', '"}" para fechar o bloco');
      return span({ k: 'Block', items, line: t.line }, t.start, close.end);
    }
    fail('esperava uma expressão');
  }

  const items = parseItems(() => at('eof'));
  return { k: 'Program', items, start: 0, end: tokens[tokens.length - 1].start, line: 1 };
}

/* The shape of the tree, in one place: used by the checker's span index,
   the Tree panel, and anything else that needs to walk the AST.        */
function children(n) {
  switch (n.k) {
    case 'Program': case 'Block': case 'List': return n.items;
    case 'Def': return [n.value];
    case 'Let': return [n.value, n.body];
    case 'Fn': return [n.body];
    case 'Call': return [n.callee].concat(n.args);
    case 'Index': return [n.target, n.index];
    case 'If': return [n.cond, n.then, n.else];
    case 'Bin': return [n.l, n.r];
    case 'Un': return [n.e];
    default: return [];
  }
}

function walk(node, visit, depth) {
  depth = depth || 0;
  visit(node, depth);
  children(node).forEach(c => walk(c, visit, depth + 1));
}

/* ──────────────────── 3 · TYPES · Hindley–Milner ──────────────────────
   Algorithm W over union-find type variables, with an occurs check and
   let-polymorphism: generalise at every binding, instantiate at use.   */

let tvarSeq = 0;
const TVar  = () => ({ k: 'var', id: tvarSeq++, ref: null });
const TCon  = name => ({ k: 'con', name });
const TList = el => ({ k: 'list', el });
const TFn   = (params, ret) => ({ k: 'fn', params, ret });

const T_NUM = TCon('Num'), T_BOOL = TCon('Bool'), T_STR = TCon('Str'), T_NIL = TCon('Nil');

function prune(t) {
  if (t.k === 'var' && t.ref) return (t.ref = prune(t.ref));
  return t;
}

function occurs(v, t) {
  t = prune(t);
  if (t === v) return true;
  if (t.k === 'list') return occurs(v, t.el);
  if (t.k === 'fn') return t.params.some(p => occurs(v, p)) || occurs(v, t.ret);
  return false;
}

function letterName(n) {
  return String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
}

function typeStr(t, names) {
  names = names || new Map();
  const go = (t, paren) => {
    t = prune(t);
    if (t.k === 'var') {
      if (!names.has(t.id)) names.set(t.id, letterName(names.size));
      return names.get(t.id);
    }
    if (t.k === 'con') return t.name;
    if (t.k === 'list') return '[' + go(t.el, false) + ']';
    const s = '(' + t.params.map(p => go(p, false)).join(', ') + ') -> ' + go(t.ret, true);
    return paren ? '(' + s + ')' : s;
  };
  return go(t, false);
}

/* "∀a b. ((a) -> b, [a]) -> [b]" — quantifiers named to match the body */
function schemeStr(s) {
  const names = new Map();
  const body = typeStr(s.type, names);
  const q = (s.vars || []).filter(id => names.has(id)).map(id => names.get(id)).sort();
  return (q.length ? '∀' + q.join(' ') + '. ' : '') + body;
}

let stats = { unifications: 0 };

function Mismatch(kind) { this.kind = kind; }

function unifyInner(a, b) {
  a = prune(a); b = prune(b);
  if (a === b) return;
  if (a.k === 'var') {
    if (occurs(a, b)) throw new Mismatch('occurs');
    a.ref = b; return;
  }
  if (b.k === 'var') return unifyInner(b, a);
  if (a.k === 'con' && b.k === 'con' && a.name === b.name) return;
  if (a.k === 'list' && b.k === 'list') return unifyInner(a.el, b.el);
  if (a.k === 'fn' && b.k === 'fn') {
    if (a.params.length !== b.params.length) throw new Mismatch('arity');
    for (let i = 0; i < a.params.length; i++) unifyInner(a.params[i], b.params[i]);
    return unifyInner(a.ret, b.ret);
  }
  throw new Mismatch('shape');
}

/* unify(expected, actual): on failure, report the whole types involved,
   not just the innermost pair that happened to disagree.              */
function unify(expected, actual, node, what) {
  stats.unifications++;
  try { unifyInner(expected, actual); }
  catch (e) {
    if (!(e instanceof Mismatch)) throw e;
    let msg;
    if (e.kind === 'occurs') {
      msg = 'isto exigiria um tipo infinitamente aninhado';
    } else {
      const names = new Map();
      msg = 'esperava ' + typeStr(expected, names) + ', encontrou ' + typeStr(actual, names);
    }
    throw AErr('type', (what ? what + ': ' : '') + msg, node.start, node.end, node.line);
  }
}

function freeVars(t, acc) {
  t = prune(t);
  if (t.k === 'var') acc.add(t.id);
  else if (t.k === 'list') freeVars(t.el, acc);
  else if (t.k === 'fn') { t.params.forEach(p => freeVars(p, acc)); freeVars(t.ret, acc); }
  return acc;
}

function instantiate(scheme) {
  if (!scheme.vars || scheme.vars.length === 0) return scheme.type;
  const sub = new Map();
  scheme.vars.forEach(id => sub.set(id, TVar()));
  const go = t => {
    t = prune(t);
    if (t.k === 'var') return sub.get(t.id) || t;
    if (t.k === 'list') return TList(go(t.el));
    if (t.k === 'fn') return TFn(t.params.map(go), go(t.ret));
    return t;
  };
  return go(scheme.type);
}

function newScope(parent) { return { vars: new Map(), parent }; }

function lookup(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const hit = s.vars.get(name);
    if (hit) return hit;
  }
  return null;
}

function envFreeVars(scope) {
  const acc = new Set();
  for (let s = scope; s; s = s.parent) {
    for (const entry of s.vars.values()) {
      if (entry.vars && entry.vars.length) {
        const local = freeVars(entry.type, new Set());
        entry.vars.forEach(v => local.delete(v));
        local.forEach(v => acc.add(v));
      } else freeVars(entry.type, acc);
    }
  }
  return acc;
}

function generalise(scope, type) {
  const bound = freeVars(type, new Set());
  envFreeVars(scope).forEach(v => bound.delete(v));
  return { vars: [...bound], type };
}

/* Optimal string alignment: like Levenshtein, but a swapped pair of
   neighbours ("fitler") costs one edit, the way typos actually happen. */
function editDistance(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                         d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function suggest(scope, name) {
  let best = null, bestD = Infinity;
  for (let s = scope; s; s = s.parent) {
    for (const k of s.vars.keys()) {
      const dist = editDistance(name, k);
      if (dist < bestD) { bestD = dist; best = k; }
    }
  }
  return best && bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

/* Builtins implemented natively. `v()` mints a fresh quantified variable. */
function scheme(build) {
  const vars = [];
  const v = () => { const t = TVar(); vars.push(t.id); return t; };
  return { vars, type: build(v) };
}

const BUILTIN_TYPES = {
  print:  scheme(v => { const a = v(); return TFn([a], a); }),
  str:    scheme(v => TFn([v()], T_STR)),
  len:    scheme(v => TFn([TList(v())], T_NUM)),
  push:   scheme(v => { const a = v(); return TFn([TList(a), a], TList(a)); }),
  concat: scheme(v => { const a = v(); return TFn([TList(a), TList(a)], TList(a)); }),
  slice:  scheme(v => { const a = v(); return TFn([TList(a), T_NUM, T_NUM], TList(a)); }),
  range:  scheme(() => TFn([T_NUM, T_NUM], TList(T_NUM))),
  sqrt:   scheme(() => TFn([T_NUM], T_NUM)),
  floor:  scheme(() => TFn([T_NUM], T_NUM)),
  abs:    scheme(() => TFn([T_NUM], T_NUM)),
  min:    scheme(() => TFn([T_NUM, T_NUM], T_NUM)),
  max:    scheme(() => TFn([T_NUM, T_NUM], T_NUM)),
  join:   scheme(() => TFn([TList(T_STR), T_STR], T_STR)),
  charAt: scheme(() => TFn([T_STR, T_NUM], T_STR)),
  size:   scheme(() => TFn([T_STR], T_NUM)),
};

function builtinScope() {
  const s = newScope(null);
  for (const name in BUILTIN_TYPES) s.vars.set(name, BUILTIN_TYPES[name]);
  return s;
}

const NUMERIC = new Set(['+', '-', '*', '/', '%']);
const ORDERED = new Set(['<', '>', '<=', '>=']);

function typecheck(prog, parentScope) {
  stats = { unifications: 0 };
  const firstVar = tvarSeq;
  const global = newScope(parentScope || builtinScope());
  const bindings = [];

  function inferItems(items, scope, mutual) {
    /* The top level is one recursive binding group: every definition can
       see every other, so reserve a type variable for each name first.
       Blocks keep plain sequential scoping.                              */
    if (mutual) {
      for (const item of items) {
        if (item.k === 'Def') scope.vars.set(item.name, { vars: [], type: TVar() });
      }
    }

    let last = T_NIL;
    for (const item of items) {
      if (item.k === 'Def') {
        const reserved = mutual && scope.vars.get(item.name);
        const placeholder = reserved ? reserved.type : TVar();
        scope.vars.set(item.name, { vars: [], type: placeholder });
        const vt = infer(item.value, scope);
        unify(placeholder, vt, item.value, 'a definição de "' + item.name + '"');
        /* leave the environment before generalising, or the binding holds
           its own type variables hostage as "still in use" */
        scope.vars.delete(item.name);
        const s = generalise(scope, placeholder);
        scope.vars.set(item.name, s);
        item.ty = placeholder;
        item.scheme = s;
        if (mutual) bindings.push({ name: item.name, scheme: s, line: item.line, start: item.start, end: item.end });
        last = T_NIL;
      } else {
        last = infer(item, scope);
      }
    }
    return last;
  }

  function infer(node, scope) {
    const t = inferRaw(node, scope);
    node.ty = t;
    return t;
  }

  function inferRaw(node, scope) {
    switch (node.k) {
      case 'Num':  return T_NUM;
      case 'Str':  return T_STR;
      case 'Bool': return T_BOOL;

      case 'Var': {
        const s = lookup(scope, node.name);
        if (!s) {
          const near = suggest(scope, node.name);
          throw AErr('type', '"' + node.name + '" não está definido' +
            (near ? ' — você quis dizer "' + near + '"?' : ''), node.start, node.end, node.line);
        }
        return instantiate(s);
      }

      case 'List': {
        const el = TVar();
        node.items.forEach(it => unify(el, infer(it, scope), it, 'todos os itens de uma lista precisam ter o mesmo tipo'));
        return TList(el);
      }

      case 'Fn': {
        const inner = newScope(scope);
        const params = node.params.map(p => {
          const t = TVar();
          inner.vars.set(p.name, { vars: [], type: t });
          p.ty = t;
          return t;
        });
        return TFn(params, infer(node.body, inner));
      }

      case 'Call': {
        const fnT = prune(infer(node.callee, scope));
        const argTs = node.args.map(a => infer(a, scope));
        const who = node.callee.k === 'Var' ? '"' + node.callee.name + '"' : 'esta função';
        if (fnT.k === 'fn') {
          if (fnT.params.length !== argTs.length) {
            throw AErr('type', who + ' recebe ' + plural(fnT.params.length, 'argumento') +
              ', mas esta chamada passa ' + argTs.length, node.start, node.end, node.line);
          }
          fnT.params.forEach((p, i) =>
            unify(p, argTs[i], node.args[i], 'argumento ' + (i + 1) + ' de ' + who));
          return fnT.ret;
        }
        if (fnT.k !== 'var') {
          throw AErr('type', who + ' é um ' + typeStr(fnT) + ', não uma função',
            node.callee.start, node.callee.end, node.line);
        }
        const ret = TVar();
        unify(fnT, TFn(argTs, ret), node, 'esta chamada');
        return ret;
      }

      case 'Index': {
        const el = TVar();
        unify(TList(el), infer(node.target, scope), node.target, 'só listas podem ser indexadas');
        unify(T_NUM, infer(node.index, scope), node.index, 'o índice de uma lista');
        return el;
      }

      case 'If': {
        unify(T_BOOL, infer(node.cond, scope), node.cond, 'a condição de um if');
        const a = infer(node.then, scope);
        const b = infer(node.else, scope);
        unify(a, b, node.else, 'os dois ramos de um if precisam concordar');
        return a;
      }

      case 'Un': {
        const t = infer(node.e, scope);
        if (node.op === '-') { unify(T_NUM, t, node.e, 'a negação'); return T_NUM; }
        unify(T_BOOL, t, node.e, '"!"');
        return T_BOOL;
      }

      case 'Bin': {
        const lt = infer(node.l, scope), rt = infer(node.r, scope);
        const op = node.op;
        const side = '"' + op + '"';
        if (NUMERIC.has(op) || ORDERED.has(op)) {
          unify(T_NUM, lt, node.l, side + ' opera sobre Nums');
          unify(T_NUM, rt, node.r, side + ' opera sobre Nums');
          return NUMERIC.has(op) ? T_NUM : T_BOOL;
        }
        if (op === '++') {
          unify(T_STR, lt, node.l, '"++" junta Strs');
          unify(T_STR, rt, node.r, '"++" junta Strs');
          return T_STR;
        }
        if (op === '&&' || op === '||') {
          unify(T_BOOL, lt, node.l, side + ' opera sobre Bools');
          unify(T_BOOL, rt, node.r, side + ' opera sobre Bools');
          return T_BOOL;
        }
        /* == and != are structural and fully polymorphic */
        unify(lt, rt, node.r, 'só dá para comparar valores do mesmo tipo');
        return T_BOOL;
      }

      case 'Let': {
        const inner = newScope(scope);
        const placeholder = TVar();
        inner.vars.set(node.name, { vars: [], type: placeholder });
        unify(placeholder, infer(node.value, inner), node.value, 'a definição de "' + node.name + '"');
        const s = generalise(scope, placeholder);
        inner.vars.set(node.name, s);
        node.scheme = s;
        return infer(node.body, inner);
      }

      case 'Block':
        return inferItems(node.items, newScope(scope), false);
    }
    throw AErr('type', 'não sei tipar ' + node.k, node.start, node.end, node.line);
  }

  const result = inferItems(prog.items, global, true);
  prog.ty = result;
  return {
    type: result, scope: global, bindings,
    stats: { unifications: stats.unifications, tvars: tvarSeq - firstVar },
  };
}

/* Every span that carries a type, for "hover to see the type" in the editor. */
function typedSpans(ast) {
  const spans = [];
  walk(ast, n => {
    if (n.k === 'Program') return;
    if (n.k === 'Def' || n.k === 'Let') {
      if (n.scheme) spans.push({ start: n.nameTok.start, end: n.nameTok.end, name: n.name, scheme: n.scheme });
      if (n.k === 'Def') return;
    }
    if (n.k === 'Fn') n.params.forEach(p => p.ty && spans.push({ start: p.start, end: p.end, name: p.name, ty: p.ty }));
    if (n.ty) spans.push({ start: n.start, end: n.end, name: n.k === 'Var' ? n.name : null, ty: n.ty, k: n.k });
  });
  return spans;
}

/* ─────────────────── 4 · COMPILER · bytecode emission ─────────────────
   Every local lives in a heap cell, so an inner function captures a
   binding simply by holding the cell. Recursion and closure capture
   become the same mechanism, with no back-patching.                   */

const OPNAMES = [
  'CONST', 'NIL', 'TRUE', 'FALSE', 'POP',
  'NEWCELL', 'STORE', 'LOAD', 'LOADUP',
  'NEWGLOBAL', 'STOREG', 'LOADG',
  'JMP', 'JMPF', 'JMPF_KEEP', 'JMPT_KEEP',
  'CALL', 'TAILCALL', 'RET', 'CLOSURE',
  'LIST', 'INDEX',
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'NOT', 'CONCAT',
  'EQ', 'NEQ', 'LT', 'GT', 'LE', 'GE',
];
const OP = {};
OPNAMES.forEach((n, i) => { OP[n] = i; });

const OPERANDS = {
  CONST: 1, NEWCELL: 1, STORE: 1, LOAD: 1, LOADUP: 1,
  NEWGLOBAL: 1, STOREG: 1, LOADG: 1,
  JMP: 1, JMPF: 1, JMPF_KEEP: 1, JMPT_KEEP: 1,
  CALL: 1, TAILCALL: 1, LIST: 1, CLOSURE: 1,
};

function compile(prog, options) {
  const isPrelude = !!(options && options.prelude);
  const functions = [];

  function newFn(name, arity, line) {
    const fn = {
      name, arity, line, code: [], lines: [], consts: [], upvals: [], upvalNames: [],
      slots: 0, slotNames: [], index: functions.length, prelude: isPrelude,
    };
    functions.push(fn);
    return fn;
  }

  let cur = null;
  const newCompiler = (fn, enclosing) => ({ fn, enclosing, locals: [], depth: 0, nextSlot: 0 });

  const emit = (op, line) => { cur.fn.code.push(op); cur.fn.lines.push(line | 0); return cur.fn.code.length - 1; };
  const constant = (v) => {
    const list = cur.fn.consts;
    for (let i = 0; i < list.length; i++) if (list[i] === v) return i;
    list.push(v);
    return list.length - 1;
  };
  const emitConst = (v, line) => { emit(OP.CONST, line); emit(constant(v), line); };
  const jump = (op, line) => { emit(op, line); return emit(0, line); };
  const patch = (at) => { cur.fn.code[at] = cur.fn.code.length; };

  function declareLocal(name) {
    const slot = cur.nextSlot++;
    if (cur.nextSlot > cur.fn.slots) cur.fn.slots = cur.nextSlot;
    const names = cur.fn.slotNames;
    names[slot] = names[slot] && names[slot] !== name ? names[slot] + '/' + name : name;
    cur.locals.push({ name, slot, depth: cur.depth });
    return slot;
  }

  function resolveLocal(comp, name) {
    for (let i = comp.locals.length - 1; i >= 0; i--) {
      if (comp.locals[i].name === name) return comp.locals[i].slot;
    }
    return -1;
  }

  function addUpvalue(comp, index, isLocal, name) {
    const list = comp.fn.upvals;
    for (let i = 0; i < list.length; i++) {
      if (list[i].index === index && list[i].isLocal === isLocal) return i;
    }
    list.push({ index, isLocal });
    comp.fn.upvalNames.push(name);
    return list.length - 1;
  }

  function resolveUpvalue(comp, name) {
    if (!comp.enclosing) return -1;
    const local = resolveLocal(comp.enclosing, name);
    if (local >= 0) return addUpvalue(comp, local, true, name);
    const up = resolveUpvalue(comp.enclosing, name);
    if (up >= 0) return addUpvalue(comp, up, false, name);
    return -1;
  }

  const beginScope = () => { cur.depth++; };
  function endScope() {
    cur.depth--;
    while (cur.locals.length && cur.locals[cur.locals.length - 1].depth > cur.depth) {
      cur.locals.pop();
      cur.nextSlot--;
    }
  }

  const BIN_OPS = {
    '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD,
    '++': OP.CONCAT, '==': OP.EQ, '!=': OP.NEQ,
    '<': OP.LT, '>': OP.GT, '<=': OP.LE, '>=': OP.GE,
  };

  function defineLocal(name, value, line) {
    const slot = declareLocal(name);
    emit(OP.NEWCELL, line); emit(slot, line);    /* the cell exists before the value, */
    if (value.k === 'Fn') value.name = name;     /* so a function can capture itself  */
    expr(value, false);
    emit(OP.STORE, line); emit(slot, line);
  }

  /* `tail` marks positions whose value is returned straight out of the
     enclosing function: calls there reuse the frame instead of pushing. */
  function expr(node, tail) {
    const line = node.line | 0;
    switch (node.k) {
      case 'Num': case 'Str': emitConst(node.v, line); return;
      case 'Bool': emit(node.v ? OP.TRUE : OP.FALSE, line); return;

      case 'Var': {
        const local = resolveLocal(cur, node.name);
        if (local >= 0) { emit(OP.LOAD, line); emit(local, line); return; }
        const up = resolveUpvalue(cur, node.name);
        if (up >= 0) { emit(OP.LOADUP, line); emit(up, line); return; }
        emit(OP.LOADG, line); emit(constant(node.name), line);
        return;
      }

      case 'List':
        node.items.forEach(it => expr(it, false));
        emit(OP.LIST, line); emit(node.items.length, line);
        return;

      case 'Index':
        expr(node.target, false); expr(node.index, false);
        emit(OP.INDEX, line);
        return;

      case 'Un':
        expr(node.e, false);
        emit(node.op === '-' ? OP.NEG : OP.NOT, line);
        return;

      case 'Bin': {
        if (node.op === '&&' || node.op === '||') {
          expr(node.l, false);
          const j = jump(node.op === '&&' ? OP.JMPF_KEEP : OP.JMPT_KEEP, line);
          expr(node.r, false);
          patch(j);
          return;
        }
        expr(node.l, false); expr(node.r, false);
        emit(BIN_OPS[node.op], line);
        return;
      }

      case 'If': {
        expr(node.cond, false);
        const toElse = jump(OP.JMPF, line);
        expr(node.then, tail);
        const over = jump(OP.JMP, line);
        patch(toElse);
        expr(node.else, tail);
        patch(over);
        return;
      }

      case 'Call':
        expr(node.callee, false);
        node.args.forEach(a => expr(a, false));
        emit(tail && cur.enclosing ? OP.TAILCALL : OP.CALL, line);
        emit(node.args.length, line);
        return;

      case 'Fn': {
        const base = node.name || 'λ';
        const name = cur.enclosing ? cur.fn.name + '.' + base : base;
        const fn = newFn(name, node.params.length, line);
        const enclosing = cur;
        cur = newCompiler(fn, enclosing);
        node.params.forEach(p => declareLocal(p.name));
        expr(node.body, true);
        emit(OP.RET, line);
        cur = enclosing;
        emit(OP.CLOSURE, line); emit(constant(fn), line);
        return;
      }

      case 'Let':
        beginScope();
        defineLocal(node.name, node.value, line);
        expr(node.body, tail);
        endScope();
        return;

      case 'Block':
        beginScope();
        items(node.items, false, tail);
        endScope();
        return;
    }
    throw AErr('compile', 'não sei compilar ' + node.k, node.start, node.end, node.line);
  }

  /* A run of statements: the last expression is the value, everything
     before it is evaluated for its effect and dropped.               */
  function items(list, isGlobal, tail) {
    let produced = false;
    list.forEach((item, i) => {
      const isLast = i === list.length - 1;
      if (item.k === 'Def') {
        if (isGlobal) {
          const c = constant(item.name);
          if (item.value.k === 'Fn') item.value.name = item.name;
          emit(OP.NEWGLOBAL, item.line); emit(c, item.line);
          expr(item.value, false);
          emit(OP.STOREG, item.line); emit(c, item.line);
        } else {
          defineLocal(item.name, item.value, item.line);
        }
      } else {
        expr(item, isLast && tail);
        if (isLast) produced = true;
        else emit(OP.POP, item.line | 0);
      }
    });
    if (!produced) emit(OP.NIL, 0);
  }

  const script = newFn(isPrelude ? 'prelude' : 'main', 0, 1);
  cur = newCompiler(script, null);
  items(prog.items, true, false);
  emit(OP.RET, 0);

  const bytes = functions.reduce((n, f) => n + f.code.length, 0);
  return { script, functions, bytes };
}

/* One function's code as readable listing rows. */
function disassemble(fn) {
  const rows = [];
  let i = 0;
  while (i < fn.code.length) {
    const at = i;
    const op = fn.code[i++];
    const name = OPNAMES[op];
    const n = OPERANDS[name] || 0;
    const args = [];
    for (let k = 0; k < n; k++) args.push(fn.code[i++]);
    let note = '';
    if (name === 'CONST') note = fmt(fn.consts[args[0]]);
    else if (name === 'LOADG' || name === 'STOREG' || name === 'NEWGLOBAL') note = fn.consts[args[0]];
    else if (name === 'LOAD' || name === 'STORE' || name === 'NEWCELL') note = fn.slotNames[args[0]] || '';
    else if (name === 'LOADUP') note = fn.upvalNames[args[0]] || '';
    else if (name === 'CLOSURE') {
      const child = fn.consts[args[0]];
      note = child.name + (child.upvals.length ? ' · captura ' + child.upvalNames.join(', ') : '');
    } else if (name === 'JMP' || name === 'JMPF' || name === 'JMPF_KEEP' || name === 'JMPT_KEEP') {
      note = '→ ' + String(args[0]).padStart(3, '0');
    } else if (name === 'CALL' || name === 'TAILCALL' || name === 'LIST') {
      note = name === 'LIST' ? args[0] + (args[0] === 1 ? ' item' : ' itens') : plural(args[0], 'arg');
    }
    rows.push({ at, op: name, args, note, line: fn.lines[at] });
  }
  return rows;
}

/* ─────────────────────── 5 · THE MACHINE ─────────────────────────────── */

/* Compact, for the debugger: long lists are elided. */
function fmt(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
  if (Array.isArray(v)) {
    if (depth > 2) return '[…]';
    const inner = v.slice(0, 8).map(x => fmt(x, depth + 1));
    if (v.length > 8) inner.push('+' + (v.length - 8));
    return '[' + inner.join(', ') + ']';
  }
  if (v.k === 'closure') return 'fn ' + v.fn.name;
  if (v.k === 'native') return 'builtin ' + v.name;
  return String(v);
}

/* Complete, for program output and str(). */
function show(v, nested) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return nested ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return '[' + v.map(x => show(x, true)).join(', ') + ']';
  if (v.k === 'closure') return '<fn ' + v.fn.name + '>';
  if (v.k === 'native') return '<builtin ' + v.name + '>';
  return String(v);
}

function num(v) {
  if (Number.isInteger(v)) return String(v);
  if (!isFinite(v)) return String(v);
  return String(+v.toPrecision(12));
}

function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  return false;
}

function makeNatives(out) {
  const N = (name, fn) => ({ k: 'native', name, fn });
  return {
    print:  N('print', a => { out.push(show(a)); return a; }),
    str:    N('str', a => show(a)),
    len:    N('len', a => a.length),
    push:   N('push', (a, x) => { const r = a.slice(); r.push(x); return r; }),
    concat: N('concat', (a, b) => a.concat(b)),
    slice:  N('slice', (a, i, j) => a.slice(i, j)),
    range:  N('range', (a, b) => {
      if (b - a > 1e6) throw AErr('runtime', 'range é limitado a um milhão de itens');
      const r = [];
      for (let i = a; i < b; i++) r.push(i);
      return r;
    }),
    sqrt:   N('sqrt', Math.sqrt),
    floor:  N('floor', Math.floor),
    abs:    N('abs', Math.abs),
    min:    N('min', Math.min),
    max:    N('max', Math.max),
    join:   N('join', (a, s) => a.join(s)),
    charAt: N('charAt', (s, i) => s.charAt(i)),
    size:   N('size', s => s.length),
  };
}

/* The higher-order library is written in Aurora itself. Because nothing
   native ever calls back into the VM, the machine stays flat, and so it
   can be paused between any two instructions.                          */
const PRELUDE_SRC = [
  'let map = fn(f, xs) => {',
  '  let go = fn(i, acc) =>',
  '    if i >= len(xs) then acc else go(i + 1, push(acc, f(xs[i])))',
  '  go(0, [])',
  '}',
  'let filter = fn(keep, xs) => {',
  '  let go = fn(i, acc) =>',
  '    if i >= len(xs) then acc',
  '    else go(i + 1, if keep(xs[i]) then push(acc, xs[i]) else acc)',
  '  go(0, [])',
  '}',
  'let fold = fn(f, init, xs) => {',
  '  let go = fn(i, acc) =>',
  '    if i >= len(xs) then acc else go(i + 1, f(acc, xs[i]))',
  '  go(0, init)',
  '}',
].join('\n');

let PRELUDE = null;
function prelude() {
  if (PRELUDE) return PRELUDE;
  const ast = parse(lex(PRELUDE_SRC).tokens);
  const checked = typecheck(ast, builtinScope());
  PRELUDE = { src: PRELUDE_SRC, ast, scope: checked.scope, bindings: checked.bindings,
              compiled: compile(ast, { prelude: true }) };
  return PRELUDE;
}

const MAX_DEPTH = 10000;
const PROFILE_BUCKETS = 1 << 15;

function machine(program, opts) {
  opts = opts || {};
  const P = prelude();
  const out = [];
  const natives = makeNatives(out);
  const globals = new Map();
  for (const name in natives) globals.set(name, { v: natives[name] });

  const stack = [];
  const frames = [];
  const S = { steps: 0, halted: false, value: undefined, error: null };

  /* Call depth over time, decimated to a fixed number of buckets: when
     the buffer fills, adjacent buckets merge (keeping the max) and each
     bucket starts covering twice as many steps.                        */
  let prof = null, stride = 1, filled = 0, bMax = 0, bCount = 0;

  const enter = fn => frames.push({ closure: { k: 'closure', fn, upvals: [] }, ip: 0, slots: new Array(fn.slots) });
  const fault = msg => AErr('runtime', msg);

  function faultLine(ip) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const fr = frames[i], fn = fr.closure.fn;
      if (!fn.prelude) return fn.lines[Math.max(0, (i === frames.length - 1 ? ip : fr.ip) - 1)] | 0;
    }
    return 0;
  }

  /* Run until `limit` total steps, a halt, or a fault. The hot state
     lives in locals and is written back to the frame on the way out. */
  function exec(limit) {
    if (S.halted) return S;
    let f = frames[frames.length - 1];
    let fn = f.closure.fn, code = fn.code, consts = fn.consts, slots = f.slots, ip = f.ip;
    let steps = S.steps;
    const pr = prof;
    let st = stride, fl = filled, bm = bMax, bc = bCount;

    try {
      while (steps < limit) {
        steps++;
        if (pr !== null) {
          const d = frames.length;
          if (d > bm) bm = d;
          if (++bc === st) {
            pr[fl++] = bm; bm = 0; bc = 0;
            if (fl === PROFILE_BUCKETS) {
              for (let i = 0, h = PROFILE_BUCKETS >> 1; i < h; i++) {
                const a = pr[2 * i], b = pr[2 * i + 1];
                pr[i] = a > b ? a : b;
              }
              fl = PROFILE_BUCKETS >> 1; st *= 2;
            }
          }
        }

        /* Literal case labels let the engine build a jump table; the
           test suite checks each one against OPNAMES.               */
        switch (code[ip++]) {
          case 0: /* CONST */ stack.push(consts[code[ip++]]); break;
          case 1: /* NIL */ stack.push(null); break;
          case 2: /* TRUE */ stack.push(true); break;
          case 3: /* FALSE */ stack.push(false); break;
          case 4: /* POP */ stack.pop(); break;

          case 5: /* NEWCELL */ slots[code[ip++]] = { v: null }; break;
          case 6: /* STORE */ slots[code[ip++]].v = stack.pop(); break;
          case 7: /* LOAD */ stack.push(slots[code[ip++]].v); break;
          case 8: /* LOADUP */ stack.push(f.closure.upvals[code[ip++]].v); break;

          case 9: /* NEWGLOBAL */ {
            const name = consts[code[ip++]];
            if (!globals.has(name)) globals.set(name, { v: undefined });
            break;
          }
          case 10: /* STOREG */ globals.get(consts[code[ip++]]).v = stack.pop(); break;
          case 11: /* LOADG */ {
            const name = consts[code[ip++]];
            const cell = globals.get(name);
            if (!cell || cell.v === undefined) throw fault('"' + name + '" é usado antes de ter um valor');
            stack.push(cell.v);
            break;
          }

          case 12: /* JMP */ ip = code[ip]; break;
          case 13: /* JMPF */ { const t = code[ip++]; if (stack.pop() === false) ip = t; break; }
          case 14: /* JMPF_KEEP */ {
            const t = code[ip++];
            if (stack[stack.length - 1] === false) ip = t; else stack.pop();
            break;
          }
          case 15: /* JMPT_KEEP */ {
            const t = code[ip++];
            if (stack[stack.length - 1] !== false) ip = t; else stack.pop();
            break;
          }

          case 16: /* CALL */
          case 17: /* TAILCALL */ {
            const tail = code[ip - 1] === 17;
            const n = code[ip++];
            const at = stack.length - n - 1;
            const callee = stack[at];
            if (!callee || typeof callee !== 'object' || !(callee.k === 'closure' || callee.k === 'native')) {
              throw fault('tentou chamar ' + fmt(callee) + ', que não é uma função');
            }
            if (callee.k === 'native') {
              const args = stack.slice(at + 1);
              stack.length = at;
              stack.push(callee.fn.apply(null, args));
              break;
            }
            const cf = callee.fn;
            const ns = new Array(cf.slots);
            for (let i = 0; i < n; i++) ns[i] = { v: stack[at + 1 + i] };
            stack.length = at;
            if (tail && frames.length > 1) {
              f.closure = callee; f.slots = ns;          /* reuse the frame */
            } else {
              if (frames.length >= MAX_DEPTH) {
                throw fault('a pilha de chamadas chegou a ' + MAX_DEPTH + ' frames — falta o caso base de uma ' +
                            'recursão, ou a chamada não está em posição de cauda');
              }
              f.ip = ip;
              f = { closure: callee, ip: 0, slots: ns };
              frames.push(f);
            }
            fn = cf; code = cf.code; consts = cf.consts; slots = ns; ip = 0;
            break;
          }

          case 18: /* RET */ {
            const value = stack.pop();
            frames.pop();
            if (frames.length === 0) { S.halted = true; S.value = value; return S; }
            f = frames[frames.length - 1];
            fn = f.closure.fn; code = fn.code; consts = fn.consts; slots = f.slots; ip = f.ip;
            stack.push(value);
            break;
          }

          case 19: /* CLOSURE */ {
            const child = consts[code[ip++]];
            const ups = new Array(child.upvals.length);
            for (let i = 0; i < ups.length; i++) {
              const u = child.upvals[i];
              ups[i] = u.isLocal ? slots[u.index] : f.closure.upvals[u.index];
            }
            stack.push({ k: 'closure', fn: child, upvals: ups });
            break;
          }

          case 20: /* LIST */ { const n = code[ip++]; stack.push(stack.splice(stack.length - n, n)); break; }
          case 21: /* INDEX */ {
            const i = stack.pop(), list = stack.pop();
            if (!Number.isInteger(i) || i < 0 || i >= list.length) {
              throw fault('o índice ' + num(i) + ' está fora de uma lista de tamanho ' + list.length);
            }
            stack.push(list[i]);
            break;
          }

          case 22: /* ADD */ { const b = stack.pop(); stack[stack.length - 1] += b; break; }
          case 23: /* SUB */ { const b = stack.pop(); stack[stack.length - 1] -= b; break; }
          case 24: /* MUL */ { const b = stack.pop(); stack[stack.length - 1] *= b; break; }
          case 25: /* DIV */ {
            const b = stack.pop();
            if (b === 0) throw fault('divisão por zero');
            stack[stack.length - 1] /= b;
            break;
          }
          case 26: /* MOD */ {
            const b = stack.pop();
            if (b === 0) throw fault('resto de divisão por zero');
            stack[stack.length - 1] %= b;
            break;
          }
          case 27: /* NEG */ stack[stack.length - 1] = -stack[stack.length - 1]; break;
          case 28: /* NOT */ stack[stack.length - 1] = stack[stack.length - 1] === false; break;
          case 29: /* CONCAT */ { const b = stack.pop(); stack[stack.length - 1] += b; break; }

          case 30: /* EQ */ { const b = stack.pop(); stack.push(deepEq(stack.pop(), b)); break; }
          case 31: /* NEQ */ { const b = stack.pop(); stack.push(!deepEq(stack.pop(), b)); break; }
          case 32: /* LT */ { const b = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] < b; break; }
          case 33: /* GT */ { const b = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] > b; break; }
          case 34: /* LE */ { const b = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] <= b; break; }
          case 35: /* GE */ { const b = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] >= b; break; }

          default: throw fault('opcode desconhecido ' + code[ip - 1]);
        }
      }
    } catch (e) {
      S.halted = true;
      S.error = {
        stage: 'runtime', start: null, end: null,
        msg: e.aurora ? e.message : 'falha interna: ' + e.message,
        line: faultLine(ip),
      };
    } finally {
      f.ip = ip;
      S.steps = steps;
      stride = st; filled = fl; bMax = bm; bCount = bc;
    }
    return S;
  }

  function snapshot() {
    const n = frames.length;
    const fr = frames.map((x, i) => {
      const fn = x.closure.fn;
      const at = i === n - 1 ? x.ip : Math.max(0, x.ip - 1);
      return { fn, name: fn.name, ip: x.ip, line: fn.lines[at] | 0, prelude: fn.prelude };
    });
    const top = frames[n - 1];
    const locals = [], upvals = [];
    if (top) {
      const fn = top.closure.fn;
      for (let i = 0; i < top.slots.length; i++) {
        const c = top.slots[i];
        locals.push({ name: fn.slotNames[i] || 'slot ' + i, value: c ? fmt(c.v) : '—', live: !!c });
      }
      top.closure.upvals.forEach((c, i) => upvals.push({ name: fn.upvalNames[i], value: fmt(c.v) }));
    }
    return {
      steps: S.steps, halted: S.halted, error: S.error, value: S.value,
      frames: fr, depth: n,
      stack: stack.slice(-14).map(v => fmt(v)), stackLen: stack.length,
      locals, upvals, out: out.slice(),
    };
  }

  /* cheap position check, for stepping line by line without full snapshots */
  function where() {
    const fr = frames[frames.length - 1];
    if (!fr) return null;
    const fn = fr.closure.fn;
    return { fn, ip: fr.ip, depth: frames.length, line: fn.lines[fr.ip] | 0, prelude: fn.prelude };
  }

  function profile() {
    if (!prof) return null;
    const data = Array.from(prof.subarray(0, filled));
    if (bCount > 0) data.push(bMax);
    return { data, stride, steps: S.steps };
  }

  /* boot: define the prelude, then point the machine at the program */
  enter(P.compiled.script);
  exec(Infinity);
  if (S.error) throw new Error('prelude failed: ' + S.error.msg);
  S.halted = false; S.steps = 0; S.value = undefined;
  stack.length = 0;
  if (opts.profile) prof = new Uint16Array(PROFILE_BUCKETS);
  enter(program.script);

  return { exec, snapshot, profile, where, state: S, out };
}

/* ─────────────── the front end (stages 1–4), timed ─────────────── */

const clock = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Number(process.hrtime.bigint()) / 1e6;

function front(src) {
  prelude();
  const timing = {};
  const r = { src, timing, ok: false, stage: 'lex' };
  try {
    let t = clock();
    const lexed = lex(src);
    timing.lex = clock() - t;
    r.tokens = lexed.tokens;
    r.trivia = lexed.trivia;

    r.stage = 'parse'; t = clock();
    r.ast = parse(lexed.tokens);
    timing.parse = clock() - t;

    r.stage = 'type'; t = clock();
    const checked = typecheck(r.ast, prelude().scope);
    timing.type = clock() - t;
    r.topType = checked.type;
    r.bindings = checked.bindings;
    r.typeStats = checked.stats;
    r.typed = typedSpans(r.ast);

    r.stage = 'compile'; t = clock();
    r.compiled = compile(r.ast);
    timing.compile = clock() - t;

    r.stage = 'run';
    r.ok = true;
  } catch (e) {
    if (!e.aurora) throw e;
    r.error = { stage: e.stage, msg: e.message, start: e.start, end: e.end, line: e.line };
  }
  return r;
}

/* All five stages, synchronously — what the tests use. */
function pipeline(src, opts) {
  opts = opts || {};
  const r = front(src);
  if (!r.ok) return r;
  const m = machine(r.compiled, { profile: opts.profile });
  const t = clock();
  m.exec(opts.maxSteps || 60e6);
  r.timing.run = clock() - t;
  const S = m.state;
  r.steps = S.steps;
  r.out = m.out;
  r.profile = m.profile();
  if (!S.halted) {
    r.ok = false;
    r.error = { stage: 'runtime', msg: 'interrompido depois de ' + S.steps.toLocaleString('pt-BR') + ' passos', line: 0 };
  } else if (S.error) {
    r.ok = false;
    r.error = S.error;
  } else {
    r.value = S.value;
  }
  return r;
}

const AURORA = {
  lex, parse, typecheck, compile, machine, front, pipeline, disassemble,
  children, walk, typeStr, schemeStr, fmt, show, prelude,
  OPNAMES, OP, BUILTIN_TYPES, PRELUDE_SRC, prune,
};

if (typeof module !== 'undefined' && module.exports) module.exports = AURORA;
