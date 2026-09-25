// dsh-script-lint 判据自测。
//
// 语料不是编的：头号夹具就是 build.sh 第 170 行**修之前**的真实内容 ——
// 那行害得脚本无报错地静默退出（exit 1），当时排查了很久。
// 这套"把踩过的坑固化成夹具"的做法，就是第二条视频里说的"攒案例"。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  lint,
  lintShell,
  lintPowerShell,
  shellOptions,
  findErrexitTraps,
  findUnquotedRecursiveGrep,
  bareVarToken,
  splitTopLevel,
  extractSubstitution,
  tokenizeShell,
  stripComment,
  firstWord,
  extOf,
  render,
} from '../src/rules.mjs'

const codes = (src) => lintShell(src).map((p) => p.code)
const has = (src, code) => codes(src).includes(code)

// ── 真实历史 bug：build.sh 第 170 行 ─────────────────────────

const BUGGY_L170 = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  `other="$(ls -1 dsh-planning-skills-v*.zip 2>/dev/null | grep -v "^$ZIP_NAME$" | wc -l | tr -d ' ')"`,
].join('\n')

const FIXED_L170 = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  `other="$(ls -1 dsh-planning-skills-v*.zip 2>/dev/null | grep -v "^$ZIP_NAME$" | wc -l | tr -d ' ' || true)"`,
].join('\n')

test('真实 bug：修复前的 build.sh 第 170 行必须被拦住', () => {
  const problems = lintShell(BUGGY_L170)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].code, 'SHELL_ERREXIT_TRAP')
  assert.equal(problems[0].line, 3, '行号必须指向赋值那一行')
})

test('真实 bug：修复后（末尾 || true）必须放行', () => {
  assert.deepEqual(lintShell(FIXED_L170), [])
})

test('真实代码：build.sh 里其余几行都不能误报', () => {
  const clean = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"`,
    `OLD_VER="$(tr -d '[:space:]' < "$SRC_DIR/VERSION")"`,
    'sz="$(wc -c < "$f" | tr -d \' \')"',
    `COUNT="$(unzip -Z1 "$ZIP_NAME" | grep -cv '/$' || true)"`,
    'T="$(mktemp -d)"',
    'SIZE="$(du -h "$ZIP_NAME" | cut -f1)"',
    'n="$(skill_name "$f")"',
    `if [ "$(head -c 3 "$STAGE/$f" | xxd -p)" != "efbbbf" ]; then`,
    '  echo x',
    'fi',
  ].join('\n')
  assert.deepEqual(lintShell(clean), [])
})

// ── shellOptions ─────────────────────────────────────────────

test('识别 set -euo pipefail / set -eu / set -o', () => {
  assert.deepEqual(shellOptions('set -euo pipefail'), { errexit: true, pipefail: true })
  assert.deepEqual(shellOptions('set -eu'), { errexit: true, pipefail: false })
  assert.deepEqual(shellOptions('set -u'), { errexit: false, pipefail: false })
  assert.deepEqual(shellOptions('set -o errexit\nset -o pipefail'), {
    errexit: true,
    pipefail: true,
  })
})

// ── 判据 1：脆弱命令 + 位置 + pipefail 的交互 ─────────────────

test('set -e 下 x=$(grep) 是陷阱', () => {
  assert.ok(has('set -e\nx=$(grep foo bar)', 'SHELL_ERREXIT_TRAP'))
})

test('没有 set -e 就不是陷阱', () => {
  assert.deepEqual(lintShell('x=$(grep foo bar)'), [])
})

test('grep 在管道中间：没有 pipefail 无害，有 pipefail 致命', () => {
  const body = 'x=$(ls *.md | grep -v skip | wc -l)'
  assert.deepEqual(lintShell('set -e\n' + body), [], 'wc 是最后一段，它的退出码才是关键')
  assert.ok(has('set -euo pipefail\n' + body, 'SHELL_ERREXIT_TRAP'))
})

test('grep 是管道最后一段时，没有 pipefail 也致命', () => {
  assert.ok(has('set -e\nx=$(ls *.md | grep foo)', 'SHELL_ERREXIT_TRAP'))
})

test('diff / cmp / ls / find 同样算脆弱', () => {
  assert.ok(has('set -e\nx=$(diff a b)', 'SHELL_ERREXIT_TRAP'))
  assert.ok(has('set -e\nx=$(cmp a b)', 'SHELL_ERREXIT_TRAP'))
  assert.ok(has('set -e\nx=$(ls *.md)', 'SHELL_ERREXIT_TRAP'))
  assert.ok(has('set -e\nx=$(find . -name x)', 'SHELL_ERREXIT_TRAP'))
})

test('无害的命令不能误报', () => {
  const clean = 'set -euo pipefail\nx=$(cat f)\ny=$(mktemp -d)\nz=$(pwd)\nw=$(date +%s)'
  assert.deepEqual(lintShell(clean), [])
})

test('|| true / || echo 这类收尾确实算已守卫', () => {
  assert.deepEqual(lintShell('set -euo pipefail\nx=$(grep a f || true)'), [])
  assert.deepEqual(lintShell('set -euo pipefail\nx=$(grep a f || echo 0)'), [])
  assert.deepEqual(lintShell('set -euo pipefail\nx=$(grep a f || :)'), [])
})

test('|| 后面还是脆弱命令 → 仍然算陷阱', () => {
  assert.ok(has('set -euo pipefail\nx=$(grep a f || grep b g)', 'SHELL_ERREXIT_TRAP'))
})

// ── 不该报的位置：命令替换的退出码不是语句退出码 ──────────────

test('if 条件、[ ] 内、echo 参数、for list 都不该报', () => {
  const clean = [
    'set -euo pipefail',
    'if grep -q x f; then echo yes; fi',
    'if [ -n "$(grep x f)" ]; then echo yes; fi',
    'echo "$(grep x f)"',
    'echo $(grep x f)',
    'for f in $(ls *.md); do echo "$f"; done',
  ].join('\n')
  assert.deepEqual(lintShell(clean), [])
})

test('多行命令替换也认得出来', () => {
  const src = ['set -euo pipefail', 'x="$(' , '  cat a', '  | grep -v skip', ')"'].join('\n')
  assert.ok(has(src, 'SHELL_ERREXIT_TRAP'))
})

test('local / export 前缀后的赋值同样检查', () => {
  assert.ok(has('set -e\nf() { local n=$(grep x y); }', 'SHELL_ERREXIT_TRAP'))
  assert.ok(has('set -e\nexport n=$(grep x y)', 'SHELL_ERREXIT_TRAP'))
  assert.ok(has('set -e\nf() {\n  local n=$(grep x y)\n}', 'SHELL_ERREXIT_TRAP'))
})

test('&& 链尾的赋值也算，因为它是这条列表的最后一条命令', () => {
  assert.ok(has('set -e\ntrue && n=$(grep x y)', 'SHELL_ERREXIT_TRAP'))
})

test('报错信息点名管道里所有脆弱段，不只第一段 —— 否则会让人去修错行', () => {
  const [p] = lintShell('set -euo pipefail\nn=$(ls *.zip | grep -v keep | wc -l)')
  assert.match(p.message, /ls \*\.zip/)
  assert.match(p.message, /grep -v keep/)
})

test('赋值在管道左侧（子 shell 里跑）不报 —— 它失败杀不了整个脚本', () => {
  assert.deepEqual(lintShell('set -euo pipefail\nn=$(grep x y) | cat'), [])
})

test('反过来，管道右侧的 { x=$(...) } 要报 —— 整个复合命令返回非零就是致命的', () => {
  assert.ok(has('set -euo pipefail\ncat f | { n=$(grep x y); }', 'SHELL_ERREXIT_TRAP'))
})

// ── 判据 2：递归 grep 的裸变量路径 ───────────────────────────

test('真实 bug：grep -rn "pat" $D 应被拦住', () => {
  const found = findUnquotedRecursiveGrep('grep -rn "description" $D')
  assert.equal(found.length, 1)
  assert.equal(found[0].variable, 'D')
  assert.equal(found[0].line, 1)
})

test('加引号或 ${D:?} 就放行', () => {
  assert.deepEqual(findUnquotedRecursiveGrep('grep -rn "description" "$D"'), [])
  assert.deepEqual(findUnquotedRecursiveGrep('grep -rn "description" ${D:?}'), [])
})

test('非递归的 grep 不管', () => {
  assert.deepEqual(findUnquotedRecursiveGrep('grep -v foo $D'), [])
})

test('pattern 位置上的裸变量不算路径，不报', () => {
  assert.deepEqual(findUnquotedRecursiveGrep('grep -rn $PAT ./src'), [])
  assert.deepEqual(findUnquotedRecursiveGrep('grep -rn "$PAT" ./src'), [])
})

test('长选项带 = 号时不吞下一个 token', () => {
  const found = findUnquotedRecursiveGrep('grep --include=*.md -rn "x" $D')
  assert.equal(found.length, 1)
  assert.equal(found[0].variable, 'D')
})

test('-e 显式给了 pattern 之后，后面的裸变量都算路径', () => {
  const found = findUnquotedRecursiveGrep('grep -rn -e "$PAT" $D')
  assert.equal(found.length, 1)
  assert.equal(found[0].variable, 'D')
})

test('注释里的 grep 不算', () => {
  assert.deepEqual(findUnquotedRecursiveGrep('# grep -rn "x" $D'), [])
  assert.deepEqual(findUnquotedRecursiveGrep('echo hi  # grep -rn "x" $D'), [])
})

test('-R 大写递归也算，--exclude 里的 r 不算递归', () => {
  assert.equal(findUnquotedRecursiveGrep('grep -R "x" $D').length, 1)
  assert.deepEqual(findUnquotedRecursiveGrep('grep -n --exclude="*.rb" "x" ./src'), [])
})

// ── 判据 3：.ps1 的 BOM ──────────────────────────────────────

test('.ps1 含中文但没 BOM → 拦', () => {
  const problems = lintPowerShell('Write-Host "中文"')
  assert.equal(problems.length, 1)
  assert.equal(problems[0].code, 'PS1_NO_BOM')
})

test('.ps1 含中文且有 BOM → 放行', () => {
  assert.deepEqual(lintPowerShell('\uFEFFWrite-Host "中文"'), [])
})

test('.ps1 纯 ASCII 不需要 BOM', () => {
  assert.deepEqual(lintPowerShell('Write-Host "hello"'), [])
})

// ── lint 分发 ────────────────────────────────────────────────

test('按扩展名分发；不认识的后缀一律放行', () => {
  const bad = 'set -euo pipefail\nx=$(grep a f)\n'
  assert.ok(lint({ filePath: '/tmp/a.sh', content: bad }).length > 0)
  assert.ok(lint({ filePath: '/tmp/a.bash', content: bad }).length > 0)
  assert.ok(lint({ filePath: '/tmp/a.PS1', content: 'Write-Host "中文"' }).length > 0)
  assert.deepEqual(lint({ filePath: '/tmp/a.md', content: bad }), [])
  assert.deepEqual(lint({ filePath: '/tmp/a.py', content: bad }), [])
  assert.deepEqual(lint({ filePath: '/tmp/noext', content: bad }), [])
})

test('render 带路径、判据码与行号', () => {
  const out = render('/tmp/a.sh', lintShell(BUGGY_L170))
  assert.match(out, /\/tmp\/a\.sh/)
  assert.match(out, /SHELL_ERREXIT_TRAP/)
  assert.match(out, /第 3 行/)
})

// ── 底层工具 ─────────────────────────────────────────────────

test('splitTopLevel 做引号感知的切分', () => {
  assert.deepEqual(
    splitTopLevel('a | b || c', ['||', '&&']).map((p) => p.text.trim()),
    ['a | b', 'c'],
  )
  assert.deepEqual(
    splitTopLevel('a | "x || y" | b', ['|']).map((p) => p.text.trim()),
    ['a', '"x || y"', 'b'],
  )
  assert.deepEqual(splitTopLevel('a | $(b | c) | d', ['|']).map((p) => p.text.trim()), [
    'a',
    '$(b | c)',
    'd',
  ])
})

test('extractSubstitution 按配对括号抠内容', () => {
  const s = 'x=$(a | grep "$(nested)")'
  const at = s.indexOf('$(')
  assert.equal(extractSubstitution(s, at).body, 'a | grep "$(nested)"')
})

test('tokenizeShell 会标记 token 是否带引号', () => {
  const toks = tokenizeShell('grep -rn "a b" $D')
  assert.deepEqual(
    toks.map((t) => [t.text, t.quoted]),
    [
      ['grep', false],
      ['-rn', false],
      ['a b', true],
      ['$D', false],
    ],
  )
})

test('stripComment 不误伤引号里的 #', () => {
  assert.equal(stripComment('echo "a # b" # real'), 'echo "a # b" ')
  assert.equal(stripComment('# all comment'), '')
  assert.equal(stripComment('echo hi'), 'echo hi')
})

test('bareVarToken 认得 ${D:?} 是已判空的', () => {
  assert.equal(bareVarToken({ text: '$D', quoted: false }), 'D')
  assert.equal(bareVarToken({ text: '${D}', quoted: false }), 'D')
  assert.equal(bareVarToken({ text: '${D:?}', quoted: false }), null)
  assert.equal(bareVarToken({ text: '${D:-fallback}', quoted: false }), null)
  assert.equal(bareVarToken({ text: '$D', quoted: true }), null)
  assert.equal(bareVarToken({ text: './src', quoted: false }), null)
})

test('firstWord / extOf 的边角', () => {
  assert.equal(firstWord('  grep -v x'), 'grep')
  assert.equal(firstWord('! grep x'), 'grep')
  assert.equal(firstWord('sudo ls'), 'ls')
  assert.equal(firstWord(''), '')
  assert.equal(extOf('/a/b/c.sh'), '.sh')
  assert.equal(extOf('C:\\a\\B.PS1'), '.ps1')
  assert.equal(extOf('/a/.bashrc'), '')
})

test('findErrexitTraps 在没有 set -e 时直接返回空', () => {
  assert.deepEqual(findErrexitTraps('x=$(grep a f)'), [])
})
