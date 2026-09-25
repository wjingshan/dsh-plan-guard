// dsh-script-lint —— 判据本体：纯函数、零依赖、可单独测试。
//
// 刻意与"缝"（src/index.mjs）分离：测量错了、判据错了，可以分别审计，互不掩盖。
// 这套分层学自 dsh-design-audit 自述的"测量与判据分离"。
//
// 三条判据都不是凭空想的，全都来自本机真实踩过的坑：
//   SHELL_ERREXIT_TRAP        —— build.sh 第 170 行，`grep -v` 无匹配返回 1 + pipefail + set -e
//                                  → 赋值语句静默终止脚本（无任何报错）
//   SHELL_GREP_UNQUOTED_PATH  —— `grep -rn ... $D` 且 $D 为空 → 把整个 workspace 递归搜了一遍
//   PS1_NO_BOM                —— 无 BOM 的 UTF-8 .ps1 在 PowerShell 5.1 下中文变乱码

// ── 认识的扩展名 ──────────────────────────────────────────────
export const SHELL_EXTS = ['.sh', '.bash', '.zsh', '.ksh']
export const PS_EXTS = ['.ps1', '.psm1']

/**
 * 在"没匹配 / 没差异 / 条件为假"时返回非零的命令。
 * 它们是 set -e 下最常见的静默杀手 —— 尤其在 command substitution 的赋值里：
 * 赋值语句的退出码就是命令替换的退出码，于是整段脚本无声无息地死掉。
 */
export const FRAGILE = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'diff', 'cmp',
  'test', '[',
  'ls', 'find',
])

/** 作为 `|| X` 的右半边时，这些命令确实把失败吞掉了。 */
export const SAFE_TAIL = new Set(['true', ':', 'echo', 'printf', 'exit', 'return'])

/** 会吃掉下一个 token 作为取值的 grep 选项。 */
const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '--regexp', '--file', '--include', '--exclude',
  '--include-dir', '--exclude-dir', '--exclude-from',
])

// ── 小工具 ───────────────────────────────────────────────────

export function extOf(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') n++
  }
  return n
}

/** 取一段命令的第一个词（跳过前置的 ! 和 sudo/env 之类的前缀）。 */
export function firstWord(cmd) {
  const t = String(cmd)
    .trim()
    .replace(/^!\s*/, '')
    .replace(/^(?:sudo|command|exec|env|time|nice)\s+/, '')
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_.-]*|\[)/)
  return m ? m[1] : ''
}

/**
 * 按顶层分隔符切分 shell 片段。引号内、`$( )` 内的分隔符一律不算。
 * seps 要按"先长后短"给（例如 ['||', '&&'] 而不是 ['|', '&']）。
 */
export function splitTopLevel(text, seps) {
  const parts = []
  let start = 0
  let i = 0
  let sq = false
  let dq = false
  let depth = 0

  while (i < text.length) {
    const c = text[i]

    if (sq) {
      if (c === "'") sq = false
      i++
      continue
    }

    if (dq) {
      if (c === '\\') { i += 2; continue }
      if (c === '"') { dq = false; i++; continue }
      if (c === '$' && text[i + 1] === '(') { depth++; i += 2; continue }
      if (c === ')' && depth > 0) { depth--; i++; continue }
      i++
      continue
    }

    if (c === '\\') { i += 2; continue }
    if (c === "'") { sq = true; i++; continue }
    if (c === '"') { dq = true; i++; continue }
    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === '$' && text[i + 1] === '(') { depth++; i += 2; continue }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') { if (depth > 0) depth--; i++; continue }

    if (depth === 0) {
      let hit = null
      for (const s of seps) {
        if (text.startsWith(s, i)) { hit = s; break }
      }
      if (hit) {
        parts.push({ text: text.slice(start, i), sep: hit })
        i += hit.length
        start = i
        continue
      }
    }
    i++
  }

  parts.push({ text: text.slice(start), sep: null })
  return parts
}

/** 从 `${` 或 `$` 处开始，抠出配对的 `$( ... )` 内容。openIdx 指向 `$`。 */
export function extractSubstitution(text, openIdx) {
  if (text[openIdx] !== '$' || text[openIdx + 1] !== '(') return null
  let i = openIdx + 2
  let depth = 1
  let sq = false
  let dq = false
  const start = i

  while (i < text.length) {
    const c = text[i]
    if (sq) { if (c === "'") sq = false; i++; continue }
    if (dq) {
      if (c === '\\') { i += 2; continue }
      if (c === '"') { dq = false; i++; continue }
      i++
      continue
    }
    if (c === '\\') { i += 2; continue }
    if (c === "'") { sq = true; i++; continue }
    if (c === '"') { dq = true; i++; continue }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') {
      depth--
      if (depth === 0) return { body: text.slice(start, i), end: i }
      i++
      continue
    }
    i++
  }
  return null
}

/** 粗略但引号感知的 token 化。quoted 表示这个 token 里出现过引号。 */
export function tokenizeShell(s) {
  const toks = []
  let i = 0
  let cur = ''
  let quoted = false
  let started = false

  const push = () => {
    if (started) {
      toks.push({ text: cur, quoted })
      cur = ''
      quoted = false
      started = false
    }
  }

  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { push(); i++; continue }
    if (c === "'" || c === '"') {
      quoted = true
      started = true
      const end = s.indexOf(c, i + 1)
      cur += s.slice(i + 1, end === -1 ? s.length : end)
      i = end === -1 ? s.length : end + 1
      continue
    }
    if (c === '\\') {
      started = true
      cur += s[i + 1] ?? ''
      i += 2
      continue
    }
    started = true
    cur += c
    i++
  }
  push()
  return toks
}

/** 去掉行尾注释，引号内的 # 不算。 */
export function stripComment(line) {
  let sq = false
  let dq = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (sq) { if (c === "'") sq = false; continue }
    if (dq) {
      if (c === '\\') { i++; continue }
      if (c === '"') dq = false
      continue
    }
    if (c === '\\') { i++; continue }
    if (c === "'") { sq = true; continue }
    if (c === '"') { dq = true; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

// ── 判据 0：这个脚本开了 set -e / pipefail 吗 ─────────────────

export function shellOptions(text) {
  const opts = { errexit: false, pipefail: false }
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (s.startsWith('#')) continue
    const m = s.match(/^set\s+(.*)$/)
    if (!m) continue
    const rest = m[1]
    const short = rest.match(/^-[A-Za-z]+/)
    if (short && short[0].slice(1).includes('e')) opts.errexit = true
    if (/\bpipefail\b/.test(rest)) opts.pipefail = true
    if (/-o\s+errexit\b/.test(rest)) opts.errexit = true
    if (/-o\s+pipefail\b/.test(rest)) opts.pipefail = true
  }
  return opts
}

// ── 判据 1：set -e 下的赋值型命令替换 ────────────────────────

// 锚点覆盖"命令位置"：行首、换行、分号、`{`（一行函数体）、`&`（&& 链）。
// 故意**不含** `|` —— 管道里的赋值跑在子 shell，失败只杀子 shell，不杀整个脚本。
// 行首分隔符单独捕获（m[1]），这样能算出赋值真正在第几行 —— 直接拿 m.index 会少算一行。
const ASSIGN_RE =
  /(^|[\n;&{])([ \t]*)(?:export[ \t]+|declare(?:[ \t]+-[-A-Za-z]+)*[ \t]+|local[ \t]+|readonly[ \t]+|typeset(?:[ \t]+-[-A-Za-z]+)*[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"?\$\()/g

/**
 * 找出"赋值 + 命令替换 + 脆弱命令"的组合，并判断在当前 shell 选项下是否致命。
 *
 * bash 语义（这是本判据的全部依据）：
 *   - `x=$(...)` 的退出码就是命令替换的退出码 → set -e 下失败会终止脚本
 *   - `echo $(...)` / `[ -n "$(...)" ]` / `for f in $(...)` 不会 → 不报
 *   - pipefail 打开时，管道里**任何**一段失败都算失败 → 中间的 grep 也致命
 *   - pipefail 关闭时，只有**最后**一段的退出码算数 → 中间的 grep 无害
 */
export function findErrexitTraps(text) {
  const opts = shellOptions(text)
  if (!opts.errexit) return []

  const out = []
  const re = new RegExp(ASSIGN_RE.source, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    const varName = m[3]
    const line = lineOf(text, m.index + m[1].length + m[2].length)
    const dollarIdx = m.index + m[0].length - 2
    const sub = extractSubstitution(text, dollarIdx)
    if (!sub) continue
    if (isPipelineStage(text, sub.end)) continue
    const bad = fragileStages(sub.body, opts)
    if (bad.length === 0) continue
    out.push({
      code: 'SHELL_ERREXIT_TRAP',
      line,
      varName,
      stage: bad[0].text.trim(),
      stages: bad.map((b) => b.text.trim()),
      pipefail: opts.pipefail,
    })
  }
  return out
}

/**
 * 赋值是不是管道的左侧（`x=$(...) | cmd`）？
 * 是的话它在子 shell 里跑，失败只杀子 shell，set -e 不会因此终止整个脚本 —— 不该报。
 * 注意这跟 `cmd | { x=$(...); }` 是两回事：后者整个复合命令返回非零，是致命的。
 */
function isPipelineStage(text, afterIdx) {
  let i = afterIdx + 1
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return text[i] === '|' && text[i + 1] !== '|'
}

function fragileStages(body, opts) {
  const clauses = splitTopLevel(body, ['||', '&&'])
  const last = clauses[clauses.length - 1].text.trim()
  // `... || true` / `... || echo 0` 这类收尾是真的把失败吞掉了
  if (clauses.length > 1 && SAFE_TAIL.has(firstWord(last))) return []

  const stages = splitTopLevel(last, ['|'])
  const fragile = stages.filter((s) => FRAGILE.has(firstWord(s.text)))
  if (fragile.length === 0) return []
  if (opts.pipefail) return fragile

  const lastStage = stages[stages.length - 1]
  return FRAGILE.has(firstWord(lastStage.text)) ? [lastStage] : []
}

// ── 判据 2：递归 grep 的裸变量路径 ───────────────────────────

/** 若 token 是个"没加引号、也没判空"的变量引用，返回变量名，否则 null。 */
export function bareVarToken(tok) {
  if (tok.quoted) return null
  const s = tok.text
  const braced = s.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(:[?=+-][^}]*)?\}/)
  if (braced) return braced[2] ? null : braced[1] // ${D:?} 已经判空了，放过
  const plain = s.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/)
  return plain ? plain[1] : null
}

export function findUnquotedRecursiveGrep(text) {
  const out = []
  const lines = text.split('\n')

  for (let idx = 0; idx < lines.length; idx++) {
    const code = stripComment(lines[idx])
    if (!/(^|[^\w])grep\b/.test(code)) continue

    const toks = tokenizeShell(code)
    for (let i = 0; i < toks.length; i++) {
      if (!/(^|\/)grep$/.test(toks[i].text)) continue

      let recursive = false
      let patternSeen = false
      let explicitPattern = false
      const paths = []

      let j = i + 1
      while (j < toks.length) {
        const t = toks[j]
        if (/^[;|&()<>]$/.test(t.text)) break

        if (!t.quoted && t.text.startsWith('-') && t.text !== '-') {
          if (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(t.text) || t.text === '--recursive') {
            recursive = true
          }
          if (GREP_VALUE_FLAGS.has(t.text)) {
            if (t.text.startsWith('-e') || t.text === '-e' || t.text === '-f' ||
                t.text === '--regexp' || t.text === '--file') {
              explicitPattern = true
            }
            j++ // 吃掉它的取值
          }
          j++
          continue
        }

        if (!patternSeen && !explicitPattern) {
          patternSeen = true
          j++
          continue
        }

        paths.push(t)
        j++
      }

      if (!recursive) continue
      for (const p of paths) {
        const name = bareVarToken(p)
        if (name) out.push({ line: idx + 1, variable: name })
      }
    }
  }
  return out
}

// ── 判据 3：.ps1 的 UTF-8 BOM ────────────────────────────────

export function lintPowerShell(content) {
  const text = String(content)
  const hasNonAscii = /[^\x00-\x7F]/.test(text)
  const hasBom = text.charCodeAt(0) === 0xfeff
  if (hasNonAscii && !hasBom) {
    return [
      {
        code: 'PS1_NO_BOM',
        message:
          '文件含非 ASCII 字符却没有 UTF-8 BOM —— Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 解码，中文全变乱码（踩过）。修法：把 content 的第一个字符设成 \\uFEFF。',
      },
    ]
  }
  return []
}

// ── 汇总 ─────────────────────────────────────────────────────

export function lintShell(text) {
  const src = String(text)
  const problems = []

  for (const t of findErrexitTraps(src)) {
    problems.push({
      code: t.code,
      line: t.line,
      message:
        `第 ${t.line} 行：\`${t.varName}=$( … )\` —— 里面的 \`${t.stages.join('`、`')}\` ` +
        '在没有匹配/条件为假时返回 1，' +
        (t.pipefail
          ? '而 pipefail 让管道里**任何一段**的失败都算整条管道的失败，'
          : '而它是管道的最后一段，') +
        '于是这个赋值的退出码是 1，set -e 会就此终止整个脚本 —— 没有任何报错。' +
        '修法：在 `$()` 末尾加 `|| true`（或 `|| echo 0`），把失败显式吞掉。',
    })
  }

  for (const g of findUnquotedRecursiveGrep(src)) {
    problems.push({
      code: 'SHELL_GREP_UNQUOTED_PATH',
      line: g.line,
      message:
        `第 ${g.line} 行：递归 grep 的路径用了没加引号的 \`$${g.variable}\` —— ` +
        `变量为空时这个操作数会整个消失，grep 会转而去搜别的地方（踩过：把整个 workspace 递归搜了一遍，淹掉了真正的输出）。` +
        `修法：写成 "\${${g.variable}:?}"，让它为空时直接报错退出。`,
    })
  }

  return problems
}

export function lint({ filePath, content }) {
  const ext = extOf(filePath)
  if (SHELL_EXTS.includes(ext)) return lintShell(content)
  if (PS_EXTS.includes(ext)) return lintPowerShell(content)
  return []
}

export function render(filePath, problems) {
  const lines = [`脚本断言未通过：${filePath}`]
  for (const p of problems) lines.push(`  - [${p.code}] ${p.message}`)
  lines.push('')
  lines.push('这几个坑都真实踩过，所以在这里拦住了。改完重写一次 —— 断言通过之前会一直拦。')
  return lines.join('\n')
}
