/**
 * SKILL.md 的判据本体 —— 纯函数，零依赖，不知道 cordis 的存在。
 *
 * 刻意与缝合代码（src/index.mjs）分开：测量错和判据错可以分别审计，互不掩盖。
 * 想改判据只需要读这一个文件，想改挂载方式只需要读另一个。
 *
 * DSH 的 skill 加载器有两个**沉默**的失败模式，本模块只负责把它们变成可见的判定：
 *   1. frontmatter 的 name / description / 布尔键写错 → 整个 skill 被静默丢弃。
 *      模型端分不清「这个 skill 不存在」和「这个 skill 写错了」，日志里只留一条 warning。
 *   2. 正文超过工具结果裁剪阈值 → 模型读到的是被截断的版本，且没有提示。
 *
 * @module dsh-skill-lint/lint
 */

/** 默认体积上限，与 dsh-compaction-tool-result-pruner 的 thresholdChars 默认值一致。 */
export const DEFAULT_SIZE_LIMIT = 8192

/** 目录包形式的固定文件名。 */
const SKILL_FILE = 'SKILL.md'

/** DSH 会做布尔解释的 frontmatter 键；写错就丢弃整个 skill。 */
const BOOL_KEYS = ['disable-model-invocation', 'user-invocable']

/** DSH 接受的布尔字面量（YAML bool + yes/no + on/off + 1/0）。 */
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'])

/** 合法的 skill 名：小写字母数字，单词间单个连字符。 */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 按**码点**数长度，与 pruner 的 codePointLength 口径一致（不是字节数，
 * 也不是 UTF-16 码元数）—— 中文一个字符算一个，与模型看到的字符数对齐。
 *
 * @param text - 任意文本。
 * @returns 码点个数。
 */
export function codePointLength(text) {
  return [...text].length
}

/**
 * 切出 frontmatter 区块。只认「文件第一行就是 ---」这一种形式，
 * 与 DSH 的解析口径一致（前导空行会让 frontmatter 失效）。
 *
 * @param text - SKILL.md 全文。
 * @returns 成功时 `{ raw }`（--- 之间的原文，不含定界符），失败时 `{ error }`。
 */
export function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (m) return { raw: m[1] }
  if (/^---[ \t]*\r?\n/.test(text)) {
    return { error: 'frontmatter 没有闭合 —— 开头写了 ---，但找不到收尾的 --- 行' }
  }
  return { error: '文件没有以 frontmatter 开头 —— 第一行必须是 ---' }
}

/**
 * 取一个顶层标量值。故意不做完整 YAML 解析：这里只关心 DSH 自己会读的那几个键，
 * 而它们都是顶层标量。支持引号包裹与行尾 `#` 注释。
 *
 * @param raw - frontmatter 区块原文。
 * @param key - 顶层键名。
 * @returns 值字符串；键不存在时 undefined。
 */
export function scalar(raw, key) {
  const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(raw)
  if (!m) return undefined
  const v = m[1].trim()
  const quoted = v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
  if (quoted) return v.slice(1, -1)
  return v.replace(/[ \t]+#.*$/, '').trim()
}

/**
 * 判断这次写入是否落在某个 skill 上，并推出它**应该**叫什么名字。
 *
 * 两种形态：
 *   - 目录包 `<root>/<name>/SKILL.md` → 期望 name = 父目录名
 *   - 平铺   `<root>/<name>.md`       → 期望 name = 文件主干名
 *
 * 平铺形态只在父目录本身叫 `skills`、或落在配置的 roots 里时才认，
 * 否则任何 `.md` 都会被误判成 skill。
 *
 * @param filePath - 工具调用给出的路径（可能是相对路径）。
 * @param roots - 可选的 skill 根绝对路径白名单；非空时只认这些根底下的文件。
 * @returns 命中时 `{ path, skillName }`，否则 null。
 */
export function skillTarget(filePath, roots = []) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const abs = resolvePath(filePath)
  const parentDir = dirnameOf(abs)
  const base = basenameOf(abs)

  if (roots.length > 0) {
    const normalized = roots.map(resolvePath)
    const under = normalized.some((r) => abs === r || abs.startsWith(r.endsWith('/') ? r : `${r}/`))
    if (!under) return null
  }

  if (base === SKILL_FILE) {
    return { path: abs, skillName: basenameOf(parentDir) }
  }
  if (base.endsWith('.md') && basenameOf(parentDir) === 'skills') {
    return { path: abs, skillName: base.slice(0, -'.md'.length) }
  }
  return null
}

// ── 路径小工具：不 import node:path，好让本模块在浏览器/沙箱里也能直接跑 ──

/** 朴素绝对化：已是绝对路径就原样返回，否则当作相对 cwd。 */
function resolvePath(p) {
  if (p.startsWith('/')) return normalizeSlashes(p)
  if (/^[A-Za-z]:[\\/]/.test(p)) return normalizeSlashes(p)
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'
  return normalizeSlashes(`${cwd}/${p}`)
}

function normalizeSlashes(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function basenameOf(p) {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function dirnameOf(p) {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  return p.slice(0, i)
}

/**
 * 全部判据。返回问题列表；空数组 = 通过。
 *
 * 这里**只做确定性判定** —— 每条问题都能指出一个具体的、DSH 会静默吞掉的错误。
 * 不做文笔评价、不做结构建议：那些该由模型读，不该由断言管。
 *
 * @param args.content - SKILL.md 全文。
 * @param args.skillName - 期望的 skill 名（来自路径）；省略则跳过一致性检查。
 * @param args.sizeLimit - 体积上限（码点）。
 * @returns `{ code, message }[]`。
 */
export function lint({ content, skillName, sizeLimit = DEFAULT_SIZE_LIMIT }) {
  const problems = []
  const fm = splitFrontmatter(content)
  if (fm.error) return [{ code: 'FM_INVALID', message: fm.error }]

  const declaredName = scalar(fm.raw, 'name')
  const description = scalar(fm.raw, 'description')

  if (declaredName === undefined || declaredName === '') {
    problems.push({ code: 'NAME_MISSING', message: 'frontmatter 缺少必需的 `name` —— DSH 会静默丢弃这个 skill' })
  } else {
    if (!KEBAB.test(declaredName)) {
      problems.push({
        code: 'NAME_NOT_KEBAB',
        message: `\`name: ${declaredName}\` 不是 kebab-case —— 只允许小写字母、数字，单词之间单个连字符`,
      })
    }
    if (skillName !== undefined && declaredName !== skillName) {
      problems.push({
        code: 'NAME_MISMATCH',
        message: `\`name: ${declaredName}\` 与它所在的目录名 \`${skillName}\` 不一致 —— DSH 会静默丢弃这个 skill`,
      })
    }
  }

  if (description === undefined || description === '') {
    problems.push({ code: 'DESC_MISSING', message: 'frontmatter 缺少必需的 `description` —— DSH 会静默丢弃这个 skill' })
  }

  for (const key of BOOL_KEYS) {
    const value = scalar(fm.raw, key)
    if (value === undefined) continue
    if (!BOOL_VALUES.has(value.toLowerCase())) {
      problems.push({
        code: 'BOOL_INVALID',
        message: `\`${key}: ${value}\` 不是 DSH 认的布尔值 —— 只接受 true/false、yes/no、on/off、1/0，写错会静默丢弃整个 skill`,
      })
    }
  }

  const size = codePointLength(content)
  if (size >= sizeLimit) {
    problems.push({
      code: 'SIZE_OVER',
      message:
        `正文 ${size} 字符 ≥ ${sizeLimit} —— 超过工具结果裁剪阈值，模型通过 skill 工具读到的会是被截断的版本；` +
        '把细节移到 references/ 里按需加载',
    })
  }

  return problems
}

/**
 * 把问题列表渲染成模型能直接照着改的一段话。
 *
 * 面向模型的失败信息有一个额外要求：**要能据此行动**。所以说清是哪一条判据、
 * 期望是什么、以及为什么（否则模型只会把同一个错误再犯一遍）。
 *
 * @param target - `{ path, skillName }`，来自 {@link skillTarget}。
 * @param problems - 来自 {@link lint}。
 * @returns 面向模型的反馈文本。
 */
export function render(target, problems) {
  const lines = problems.map((p) => `  - [${p.code}] ${p.message}`)
  return [
    `SKILL.md 断言未通过：${target.path}`,
    ...lines,
    '',
    '这个文件现在装进 DSH 不会生效（或会被截断）。请修正后重新写入 —— 断言通过之前会一直拦。',
  ].join('\n')
}
