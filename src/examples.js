'use strict';
/* Programs that each put a different part of the machine under load. */

const EXAMPLES = [

{
  id: 'mandelbrot',
  title: 'Mandelbrot',
  blurb: '2.688 laços de escape, desenhados com caracteres.',
  focus: 'output',
  code: `# O conjunto de Mandelbrot, renderizado por tempo de escape.
# Cada pixel é um laço com recursão de cauda; cada linha é um map.

let maxIter = 60
let rampa = " .:-=+*#%"

let escape = fn(cx, cy) => {
  let passo = fn(zx, zy, i) =>
    if i >= maxIter then maxIter
    else {
      let xx = zx * zx
      let yy = zy * zy
      if xx + yy > 4 then i
      else passo(xx - yy + cx, 2 * zx * zy + cy, i + 1)
    }
  passo(0, 0, 0)
}

let tom = fn(n) =>
  if n >= maxIter then "@"
  else charAt(rampa, floor(n * 9 / maxIter))

let linha = fn(y) =>
  join(map(fn(x) => tom(escape(x / 32 - 2.15, y / 14 - 1.1)), range(0, 84)), "")

print(join(map(linha, range(0, 32)), "\\n"))`
},

{
  id: 'types',
  title: 'Inferência',
  blurb: 'Nenhuma anotação de tipo. Abra o painel Tipos.',
  focus: 'types',
  code: `# Aurora não tem sintaxe de tipos. Cada tipo abaixo foi
# reconstruído por unificação — veja o painel Tipos, ou passe
# o mouse sobre qualquer expressão.

let duasVezes = fn(f, x) => f(f(x))
let inverte   = fn(f) => fn(a, b) => f(b, a)
let aplica    = fn(f, xs) => map(f, xs)

# Uma única definição de duasVezes, usada em três tipos diferentes.
# Isso é polimorfismo de let: a definição é generalizada, e cada
# uso instancia variáveis de tipo novas.

print("com um Num   -> " ++ str(duasVezes(fn(n) => n * 3, 2)))
print("com uma Str  -> " ++ duasVezes(fn(s) => s ++ "!", "uau"))
print("com uma List -> " ++ str(duasVezes(fn(xs) => push(xs, len(xs)), [])))

let menos = fn(a, b) => a - b
let aoContrario = inverte(menos)
print("10 - 3 = " ++ str(menos(10, 3)) ++ ", invertido = " ++ str(aoContrario(10, 3)))

aplica`
},

{
  id: 'closures',
  title: 'Closures',
  blurb: 'Três níveis de captura, resolvidos na compilação.',
  focus: 'bytecode',
  code: `# Uma closure é uma função mais as células que ela capturou.
# O compilador resolve cada captura estaticamente — procure
# CLOSURE ... captura e LOADUP no painel Bytecode.

let pa = fn(inicio) => fn(razao) => fn(n) => inicio + razao * n

let deDez    = pa(10)
let deTres   = deDez(3)
let deMenos5 = deDez(-5)

print("início 10, razão  3 -> " ++ str(map(deTres,   range(0, 9))))
print("início 10, razão -5 -> " ++ str(map(deMenos5, range(0, 9))))

# compoe fabrica funções novas a partir de outras,
# sem nunca mencionar um tipo concreto.
let compoe = fn(f, g) => fn(x) => f(g(x))
let inc = fn(x) => x + 1
let dobro = fn(x) => x * 2

print("inc . dobro -> " ++ str(map(compoe(inc, dobro), range(0, 9))))
print("dobro . inc -> " ++ str(map(compoe(dobro, inc), range(0, 9))))
compoe`
},

{
  id: 'quicksort',
  title: 'Quicksort',
  blurb: 'Particiona com filter, recursa, concatena.',
  focus: 'ast',
  code: `# Quicksort, do jeito que aparece no livro.

let ordena = fn(xs) =>
  if len(xs) <= 1 then xs
  else {
    let pivo = xs[0]
    let resto = slice(xs, 1, len(xs))
    let menores = filter(fn(x) => x < pivo, resto)
    let maiores = filter(fn(x) => x >= pivo, resto)
    concat(concat(ordena(menores), [pivo]), ordena(maiores))
  }

# Um gerador de Lehmer, pequeno o bastante para ser exato num double.
let ruido = fn(n) => (n * 75 + 74) % 65537
let serie = fold(fn(acc, _) => push(acc, ruido(acc[len(acc) - 1])), [7], range(0, 23))
let baralho = map(fn(n) => n % 100, serie)

print("antes    -> " ++ join(map(str, baralho), " "))
print("depois   -> " ++ join(map(str, ordena(baralho)), " "))
print("estável? -> " ++ str(ordena(baralho) == ordena(ordena(baralho))))`
},

{
  id: 'tailcalls',
  title: 'Chamadas de cauda',
  blurb: '300 mil chamadas de profundidade, pilha constante.',
  focus: 'vm',
  code: `# soma chama a si mesma como a última coisa que faz. O compilador
# emite TAILCALL e a máquina reaproveita a frame em vez de empilhar
# outra — a profundidade fica parada. Veja o gráfico na aba Máquina.

let soma = fn(n, acc) => if n == 0 then acc else soma(n - 1, acc + n)
print("1 + 2 + ... + 300000 = " ++ str(soma(300000, 0)))

# Collatz: quantos passos até cada número chegar a 1?
let collatz = fn(n, passos) =>
  if n == 1 then passos
  else if n % 2 == 0 then collatz(n / 2, passos + 1)
  else collatz(3 * n + 1, passos + 1)

# melhor é um par [início, comprimento], carregado pelo fold.
let maisLonga = fold(
  fn(melhor, n) => let c = collatz(n, 0) in if c > melhor[1] then [n, c] else melhor,
  [1, 0],
  range(1, 3000))

print("a cadeia de Collatz mais longa abaixo de 3000 começa em " ++ str(maisLonga[0]))
print("e leva " ++ str(maisLonga[1]) ++ " passos até chegar a 1")`
},

{
  id: 'primes',
  title: 'Primos',
  blurb: 'Divisão por tentativa, só pelos primos já achados.',
  focus: 'output',
  code: `# O fold carrega a lista crescente de primos como acumulador,
# então cada candidato só é dividido pelos primos anteriores.

let ehPrimo = fn(conhecidos, n) => {
  let testa = fn(i) =>
    if i >= len(conhecidos) then true
    else {
      let p = conhecidos[i]
      if p * p > n then true
      else if n % p == 0 then false
      else testa(i + 1)
    }
  testa(0)
}

let primos = fold(
  fn(acc, n) => if ehPrimo(acc, n) then push(acc, n) else acc,
  [],
  range(2, 500))

print(str(len(primos)) ++ " primos abaixo de 500")
print(join(map(str, primos), " "))

let gemeos = filter(fn(p) => ehPrimo(primos, p + 2), primos)
print("primos gêmeos (o menor do par): " ++ join(map(str, slice(gemeos, 0, 14)), " "))`
},

{
  id: 'typeerror',
  title: 'Erro de tipo',
  blurb: 'Rejeitado antes de uma única instrução rodar.',
  focus: 'types',
  expectError: 'type',
  code: `# tamanhos mede cada Str de uma lista.
let tamanhos = fn(xs) => map(size, xs)

print(str(tamanhos(["ok", "tudo", "aurora"])))

# A linha abaixo pede o tamanho de números.
# A inferência unifica [Str] com [Num], falha e aponta para cá —
# a máquina nem é ligada, então nem a linha acima chegou a rodar.

print(str(tamanhos([1, 2, 3])))`
},

];

if (typeof module !== 'undefined' && module.exports) module.exports = EXAMPLES;
