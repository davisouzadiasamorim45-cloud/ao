'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../src/core.js');
const EXAMPLES = require('../src/examples.js');

let pass = 0, fail = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name + '\n      ' + e.message); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n      expected ' + sb + '\n      got      ' + sa);
}

function ok(src, opts) {
  const r = A.pipeline(src, opts);
  if (!r.ok) throw new Error('[' + r.error.stage + '] ' + r.error.msg + ' (line ' + r.error.line + ')');
  return r;
}
const val = src => A.show(ok(src).value);
const typeOf = src => A.typeStr(ok(src).topType);
function errOf(src) {
  const r = A.pipeline(src);
  if (r.ok) throw new Error('expected an error, but it ran and produced ' + A.show(r.value));
  return r.error;
}

/* ─────────────────────────── lexer ─────────────────────────── */

check('lexer: spans and kinds', () => {
  const { tokens } = A.lex('let x = 42');
  eq(tokens.map(t => t.type), ['kw', 'ident', 'op', 'num', 'eof']);
  eq(tokens[3].value, 42);
  eq([tokens[1].start, tokens[1].end], [4, 5]);
});

check('lexer: comments become trivia, not tokens', () => {
  const r = A.lex('1 # hello\n2');
  eq(r.tokens.filter(t => t.type !== 'eof').map(t => t.value), [1, 2]);
  eq(r.trivia.length, 1);
});

check('lexer: string escapes', () => {
  eq(A.lex('"a\\nb\\t\\"c\\""').tokens[0].value, 'a\nb\t"c"');
});

check('lexer: longest-match operators', () => {
  const { tokens } = A.lex('a<=b a<b a==b a=>b');
  eq(tokens.filter(t => t.type === 'op').map(t => t.value), ['<=', '<', '==', '=>']);
});

check('lexer: lenient mode survives half-typed code', () => {
  const r = A.lex('let s = "never closed', true);
  eq(r.tokens.map(t => t.type), ['kw', 'ident', 'op', 'str', 'eof']);
  const bad = A.lex('a @ b', true);
  eq(bad.tokens.map(t => t.type), ['ident', 'bad', 'ident', 'eof']);
});

check('lexer: strict mode names the problem', () => {
  assert(/nunca é fechada/.test(errOf('"abc').msg));
  assert(/não tem o caractere "@"/.test(errOf('1 @ 2').msg));
});

/* ─────────────────────────── parser ────────────────────────── */

check('parser: precedence climbs correctly', () => {
  const top = A.parse(A.lex('1 + 2 * 3').tokens).items[0];
  eq(top.op, '+');
  eq(top.r.op, '*');
});

check('parser: comparison binds looser than arithmetic', () => {
  const top = A.parse(A.lex('1 + 2 < 4').tokens).items[0];
  eq(top.op, '<');
  eq(top.l.op, '+');
});

check('parser: a new line ends a call chain', () => {
  const ast = A.parse(A.lex('print\n(1 + 2)').tokens);
  eq(ast.items.length, 2);
  eq(ast.items[1].k, 'Bin');
});

check('parser: definitions and expressions are distinct nodes', () => {
  const ast = A.parse(A.lex('let a = 1\nlet b = 2 in b\na').tokens);
  eq(ast.items.map(n => n.k), ['Def', 'Let', 'Var']);
});

check('parser: missing else is reported with a span', () => {
  const e = errOf('if true then 1');
  eq(e.stage, 'parse');
  assert(/else/.test(e.msg), e.msg);
  assert(typeof e.start === 'number' && e.end > e.start);
});

check('parser: two expressions on one line are rejected', () => {
  assert(/nova linha ou ";"/.test(errOf('let x = 1 2').msg));
});

check('parser: children() reaches every node', () => {
  const ast = A.parse(A.lex('let f = fn(a) => if a then [1][0] else -f(!a)\nf(true)').tokens);
  const kinds = new Set();
  A.walk(ast, n => kinds.add(n.k));
  ['Program', 'Def', 'Fn', 'If', 'Index', 'List', 'Num', 'Un', 'Call', 'Var', 'Bool']
    .forEach(k => assert(kinds.has(k), 'walk never reached ' + k));
});

/* ─────────────────── type inference (Hindley–Milner) ─────────────────── */

check('types: literals', () => {
  eq(typeOf('1'), 'Num');
  eq(typeOf('"hi"'), 'Str');
  eq(typeOf('true'), 'Bool');
  eq(typeOf('[1,2,3]'), '[Num]');
});

check('types: signatures are inferred, never declared', () => {
  eq(typeOf('fn(x) => x + 1'), '(Num) -> Num');
  eq(typeOf('fn(a, b) => a && b'), '(Bool, Bool) -> Bool');
});

check('types: identity generalises', () => {
  eq(typeOf('fn(x) => x'), '(a) -> a');
});

check('types: let-polymorphism — one binding at two types', () => {
  eq(typeOf('let id = fn(x) => x\nlet a = id(1)\nlet b = id("s")\nb'), 'Str');
});

check('types: schemes print their quantifiers', () => {
  const r = ok('let twice = fn(f, x) => f(f(x))\ntwice');
  eq(A.schemeStr(r.bindings[0].scheme), '∀a. ((a) -> a, a) -> a');
});

check('types: the prelude, written in Aurora, infers the classic signatures', () => {
  const P = A.prelude();
  const sig = name => A.schemeStr(P.bindings.find(b => b.name === name).scheme);
  eq(sig('map'), '∀a b. ((a) -> b, [a]) -> [b]');
  eq(sig('filter'), '∀a. ((a) -> Bool, [a]) -> [a]');
  eq(sig('fold'), '∀a b. ((a, b) -> a, a, [b]) -> a');
});

check('types: higher-order use keeps its shape', () => {
  eq(typeOf('map(fn(x) => x > 2, [1,2,3])'), '[Bool]');
  eq(typeOf('fold(fn(a, b) => a + b, 0, [1,2,3])'), 'Num');
});

check('types: mutual recursion at the top level', () => {
  eq(typeOf('let ev = fn(n) => if n == 0 then true else od(n - 1)\n' +
            'let od = fn(n) => if n == 0 then false else ev(n - 1)\nev'), '(Num) -> Bool');
});

check('types: mismatch reported as expected-vs-found, at the culprit', () => {
  const e = errOf('1 + "hello"');
  eq(e.stage, 'type');
  assert(/esperava Num, encontrou Str/.test(e.msg), e.msg);
  eq(e.start, 4);
});

check('types: argument errors point at the argument and show whole types', () => {
  const src = 'let lengths = fn(xs) => map(size, xs)\nlengths([1, 2])';
  const e = errOf(src);
  assert(/argumento 1 de "lengths": esperava \[Str\], encontrou \[Num\]/.test(e.msg), e.msg);
  eq(src.slice(e.start, e.end), '[1, 2]');
});

check('types: arity mismatch', () => {
  assert(/recebe 2 argumentos, mas esta chamada passa 1/.test(errOf('let f = fn(a,b) => a\nf(1)').msg));
});

check('types: if-branch mismatch', () => {
  assert(/ramos/.test(errOf('if true then 1 else "two"').msg));
});

check('types: heterogeneous list', () => {
  assert(/mesmo tipo/.test(errOf('[1, "a"]').msg));
});

check('types: unknown name suggests a near miss', () => {
  assert(/"fitler" não está definido — você quis dizer "filter"\?/.test(errOf('fitler(fn(x) => true, [1])').msg));
  assert(/você quis dizer "print"\?/.test(errOf('prnit("x")').msg));
  assert(!/quis dizer/.test(errOf('zzzzzz').msg), 'should not suggest when nothing is close');
});

check('types: occurs check stops infinite types', () => {
  assert(/infinitamente/.test(errOf('let f = fn(x) => x(x)\nf').msg));
});

check('types: calling a non-function', () => {
  assert(/é um Num, não uma função/.test(errOf('let n = 3\nn(1)').msg));
});

check('types: hover index covers names, params and expressions', () => {
  const r = A.front('let inc = fn(k) => k + 1\ninc(2)');
  const at = off => r.typed.filter(s => s.start <= off && off < s.end)
                           .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  eq(A.schemeStr(at(5).scheme), '(Num) -> Num');   /* "inc" in let inc */
  eq(A.typeStr(at(13).ty), 'Num');                 /* param k          */
  eq(at(26).name, 'inc');                          /* use of inc       */
  eq(A.typeStr(at(26).ty), '(Num) -> Num');
  eq(A.typeStr(at(29).ty), 'Num');                 /* the literal 2    */
});

/* ───────────────────────── evaluation ──────────────────────── */

check('eval: arithmetic and precedence', () => {
  eq(val('2 + 3 * 4'), '14');
  eq(val('(2 + 3) * 4'), '20');
  eq(val('7 % 3'), '1');
  eq(val('-3 + 10'), '7');
  eq(val('0.1 + 0.2'), '0.3');
});

check('eval: short-circuit && and ||', () => {
  eq(val('false && (1 / 0 == 0)'), 'false');
  eq(val('true || (1 / 0 == 0)'), 'true');
});

check('eval: strings', () => {
  eq(val('"aur" ++ "ora"'), 'aurora');
  eq(val('str(42) ++ "!"'), '42!');
  eq(val('str("x")'), 'x');
});

check('eval: blocks scope their bindings', () => {
  eq(val('let x = 1\n{ let x = 99\n x + 1 }'), '100');
  eq(val('let x = 1\n{ let y = 2\n y }\nx'), '1');
});

check('eval: let-in is an expression', () => {
  eq(val('(let a = 5 in a * a) + 1'), '26');
});

check('eval: lists, indexing, structural equality', () => {
  eq(val('[1,2,3][1]'), '2');
  eq(val('[[1],[2]] == [[1],[2]]'), 'true');
  eq(val('[1,2] == [2,1]'), 'false');
});

check('eval: str() never truncates', () => {
  eq(val('str(range(0, 20))'), '[' + Array.from({ length: 20 }, (_, i) => i).join(', ') + ']');
});

check('eval: fib(20)', () => {
  eq(val('let fib = fn(n) => if n < 2 then n else fib(n-1) + fib(n-2)\nfib(20)'), '6765');
});

check('eval: closures capture cells, and each call gets fresh ones', () => {
  eq(val('let adder = fn(n) => fn(x) => x + n\n' +
         'let a5 = adder(5)\nlet a9 = adder(9)\n[a5(1), a9(1), a5(100)]'), '[6, 10, 105]');
});

check('eval: mutual recursion runs', () => {
  eq(val('let ev = fn(n) => if n == 0 then true else od(n - 1)\n' +
         'let od = fn(n) => if n == 0 then false else ev(n - 1)\nev(64)'), 'true');
});

check('eval: local recursion inside a block', () => {
  eq(val('{ let go = fn(n) => if n == 0 then 0 else n + go(n - 1)\n go(10) }'), '55');
});

check('eval: capture across three levels', () => {
  eq(val('let f = fn(a) => fn(b) => fn(c) => a * 100 + b * 10 + c\nf(1)(2)(3)'), '123');
});

check('eval: the Aurora-written prelude', () => {
  eq(val('map(fn(x) => x * x, [1,2,3,4])'), '[1, 4, 9, 16]');
  eq(val('filter(fn(x) => x % 2 == 0, range(0, 10))'), '[0, 2, 4, 6, 8]');
  eq(val('fold(fn(a, b) => a + b, 0, range(1, 101))'), '5050');
  eq(val('map(str, [1, 2])'), '["1", "2"]');
});

check('eval: user code may shadow the prelude', () => {
  eq(val('let map = fn(x) => x * 2\nmap(21)'), '42');
});

check('eval: print collects output and returns its argument', () => {
  const r = ok('let x = print("one")\nprint([1, 2] == [1, 2])\nx');
  eq(r.out, ['one', 'true']);
  eq(A.show(r.value), 'one');
});

/* ─────────────── tail calls: the space-complexity claim ─────────────── */

check('vm: tail recursion runs in constant stack space', () => {
  eq(val('let go = fn(n, acc) => if n == 0 then acc else go(n - 1, acc + n)\ngo(200000, 0)'),
     '20000100000');
});

check('vm: tail position flows through if, let-in and blocks', () => {
  eq(val('let go = fn(n) => if n == 0 then "done" else { let m = n - 1\n go(m) }\ngo(150000)'), 'done');
  eq(val('let go = fn(n) => if n == 0 then "ok" else let m = n - 1 in go(m)\ngo(150000)'), 'ok');
});

check('vm: non-tail runaway recursion fails cleanly, on the right line', () => {
  const e = errOf('let x = 1\nlet f = fn(n) => 1 + f(n + 1)\nf(0)');
  eq(e.stage, 'runtime');
  assert(/10000 frames/.test(e.msg), e.msg);
  eq(e.line, 2);
});

check('compiler: tail calls are really emitted', () => {
  const r = ok('let go = fn(n) => if n == 0 then 0 else go(n - 1)\ngo(1)');
  const ops = A.disassemble(r.compiled.functions.find(f => f.name === 'go')).map(x => x.op);
  assert(ops.includes('TAILCALL') && !ops.includes('CALL'), ops.join(' '));
});

check('compiler: nested functions get qualified names', () => {
  const r = A.front('let outer = fn(a) => { let inner = fn(b) => a + b\n inner(1) }\nouter(1)');
  const names = r.compiled.functions.map(f => f.name);
  assert(names.includes('outer.inner'), names.join(', '));
});

/* ─────────────────────── runtime errors ────────────────────── */

check('runtime: division by zero', () => {
  assert(/zero/.test(errOf('let a = 0\n10 / a').msg));
});

check('runtime: index out of range names the length', () => {
  assert(/fora de uma lista de tamanho 3/.test(errOf('[1,2,3][9]').msg));
});

check('runtime: faults inside a prelude callback point at user code', () => {
  const e = errOf('let xs = [1, 0]\n\nlet ys = map(fn(d) => 10 / d, xs)');
  eq(e.line, 3);
});

check('runtime: use before definition is caught', () => {
  assert(/antes de ter um valor/.test(errOf('print(later(1))\nlet later = fn(x) => x').msg));
});

/* ─────────────────────── the machine ───────────────────────── */

check('machine: literal case labels match the opcode table', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/core.js'), 'utf8');
  const cases = [...src.matchAll(/case (\d+): \/\* (\w+) \*\//g)];
  eq(cases.length, A.OPNAMES.length, 'every opcode needs exactly one case');
  cases.forEach(m => eq(A.OP[m[2]], Number(m[1]), 'case ' + m[1] + ' is labelled ' + m[2]));
});

check('machine: pausing and resuming gives the same answer', () => {
  const r = A.front('let fib = fn(n) => if n < 2 then n else fib(n-1) + fib(n-2)\nfib(15)');
  const m = A.machine(r.compiled);
  let slices = 0;
  while (!m.state.halted) { m.exec(m.state.steps + 97); slices++; }
  assert(slices > 50, 'should have paused many times');
  eq(A.show(m.state.value), '610');
});

check('machine: replay is deterministic', () => {
  const r = A.front(EXAMPLES.find(e => e.id === 'closures').code);
  const a = A.machine(r.compiled); a.exec(1234);
  const b = A.machine(r.compiled); b.exec(600); b.exec(1234);
  const strip = s => JSON.stringify(s, (k, v) => (k === 'fn' ? undefined : v));
  eq(strip(a.snapshot()), strip(b.snapshot()));
});

check('machine: a tail call replaces its caller\'s frame', () => {
  const r = A.front('let outer = fn(a) => { let inner = fn(b) => a * b\n inner(7) }\nouter(6)');
  const m = A.machine(r.compiled);
  let maxDepth = 0;
  while (!m.state.halted) { m.exec(m.state.steps + 1); maxDepth = Math.max(maxDepth, m.snapshot().depth); }
  eq(maxDepth, 2, 'outer should have been replaced by outer.inner');
  eq(A.show(m.state.value), '42');
});

check('machine: snapshots expose frames, locals and captures', () => {
  /* "+ 0" keeps inner(7) out of tail position, so outer's frame survives */
  const r = A.front('let outer = fn(a) => { let inner = fn(b) => a * b\n inner(7) + 0 }\nouter(6)');
  const m = A.machine(r.compiled);
  let snap = null;
  while (!m.state.halted) {
    m.exec(m.state.steps + 1);
    const s = m.snapshot();
    if (s.frames.length && s.frames[s.frames.length - 1].name === 'outer.inner') { snap = s; break; }
  }
  assert(snap, 'never entered outer.inner');
  eq(snap.frames.map(f => f.name), ['main', 'outer', 'outer.inner']);
  eq(snap.locals[0], { name: 'b', value: '7', live: true });
  eq(snap.upvals[0], { name: 'a', value: '6' });
});

check('machine: the depth profile tells recursion from iteration', () => {
  const deep = ok('let fib = fn(n) => if n < 2 then n else fib(n-1) + fib(n-2)\nfib(16)', { profile: true });
  const flat = ok('let go = fn(n) => if n == 0 then 0 else go(n - 1)\ngo(20000)', { profile: true });
  eq(Math.max(...deep.profile.data), 17, 'fib(16) should reach depth 17');
  eq(Math.max(...flat.profile.data), 2, 'a tail loop should never pass depth 2');
});

check('machine: the profile stays bounded on long runs', () => {
  const r = ok('let go = fn(n) => if n == 0 then 0 else go(n - 1)\ngo(300000)', { profile: true });
  assert(r.profile.data.length <= 32768, 'profile grew to ' + r.profile.data.length);
  assert(r.profile.stride > 1, 'long runs should decimate');
  const covered = r.profile.data.length * r.profile.stride;
  assert(covered >= r.steps && covered < r.steps + 2 * r.profile.stride, 'buckets must cover every step');
});

check('disassembler: every function decodes exactly, and the corners are exercised', () => {
  const r = ok([
    'let xs = [1, 2, 3]',
    'let f = fn(a) => fn(b) => if a > b && true then str(a) ++ "!" == "" else false',
    'let h = fn(p, q) => !p || -q > 0',
    'let go = fn(n) => if n <= 0 then "done" else go(n - 1)',
    'print(str(h(f(2)(1), 3)) ++ str(xs[0] != 9) ++ go(3))',
  ].join('\n'));
  const seen = new Set();
  for (const fn of r.compiled.functions) {
    const rows = A.disassemble(fn);
    const last = rows[rows.length - 1];
    eq(last.at + 1 + last.args.length, fn.code.length, 'listing for "' + fn.name + '" desynced');
    rows.forEach(row => seen.add(row.op));
  }
  ['JMPF', 'JMPT_KEEP', 'JMPF_KEEP', 'NEG', 'NOT', 'INDEX', 'CONCAT', 'LIST',
   'CLOSURE', 'LOADUP', 'TAILCALL', 'NEWGLOBAL', 'EQ', 'NEQ'].forEach(op =>
    assert(seen.has(op), 'sample never emitted ' + op));
});

/* ─────────────── every example must behave as advertised ─────────────── */

check('examples: each compiles, type-checks and runs (or fails where it should)', () => {
  for (const ex of EXAMPLES) {
    const r = A.pipeline(ex.code);
    if (ex.expectError) {
      assert(!r.ok, '"' + ex.title + '" was supposed to fail but ran');
      eq(r.error.stage, ex.expectError, '"' + ex.title + '" failed at the wrong stage');
      continue;
    }
    if (!r.ok) throw new Error('"' + ex.title + '" [' + r.error.stage + '] ' + r.error.msg + ' (line ' + r.error.line + ')');
    assert(r.out.length > 0, '"' + ex.title + '" printed nothing');
  }
});

check('examples: mandelbrot draws a recognisable set', () => {
  const art = ok(EXAMPLES.find(e => e.id === 'mandelbrot').code).out.join('\n');
  const rows = art.split('\n');
  assert(rows.length >= 30, 'too few rows');
  assert(rows.some(r => /@{20,}/.test(r)), 'no solid interior');
  assert(/ {10,}/.test(art), 'no escape region');
});

check('examples: the caught mistake points at the offending argument', () => {
  const ex = EXAMPLES.find(e => e.id === 'typeerror');
  const e = A.pipeline(ex.code).error;
  eq(ex.code.slice(e.start, e.end), '[1, 2, 3]');
});

/* ────────────────────────── report ─────────────────────────── */

const rule = '─'.repeat(60);
console.log(rule);
failures.forEach(f => console.log('  FAIL  ' + f + '\n'));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log(rule);
process.exit(fail ? 1 : 0);
