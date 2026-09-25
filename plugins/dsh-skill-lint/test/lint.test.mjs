/**
 * 判据本体的自测。跑 `npm test`（node --test）即可。
 *
 * 这个文件本身也是那套想法的一次小型示范：把「SKILL.md 写对了没有」这件
 * 靠肉眼看的事，变成一组确定性的、可重复的断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SIZE_LIMIT,
  codePointLength,
  lint,
  render,
  scalar,
  skillTarget,
  splitFrontmatter,
} from '../src/lint.mjs'

/** 拼一份 SKILL.md；frontmatter 只给键值行。 */
function skillFile(frontmatterLines, body = '# 标题\n\n正文。\n') {
  return ['---', ...frontmatterLines, '---', '', body].join('\n')
}

const GOOD = skillFile(['name: grilling', 'description: 用连续追问压测一份计划'])

const codes = (problems) => problems.map((p) => p.code)

// ── 判据：通过的情况 ──────────────────────────────────────────────

test('干净的 SKILL.md 零问题', () => {
  assert.deepEqual(lint({ content: GOOD, skillName: 'grilling' }), [])
})

test('省略 skillName 时跳过一致性检查', () => {
  assert.deepEqual(lint({ content: GOOD }), [])
})

test('布尔键用 DSH 接受的各种写法都放行', () => {
  for (const v of ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', 'TRUE']) {
    const content = skillFile(['name: grilling', 'description: 说明', `user-invocable: ${v}`])
    assert.deepEqual(lint({ content, skillName: 'grilling' }), [], `user-invocable: ${v} 应该放行`)
  }
})

test('带引号的值和行尾注释都能解析', () => {
  const content = skillFile(['name: "grilling"', "description: '说明文字'  # 注释"])
  assert.deepEqual(lint({ content, skillName: 'grilling' }), [])
})

// ── 判据：frontmatter 本身 ────────────────────────────────────────

test('没有 frontmatter → FM_INVALID', () => {
  assert.deepEqual(codes(lint({ content: '# 光秃秃的标题', skillName: 'grilling' })), ['FM_INVALID'])
})

test('frontmatter 未闭合 → FM_INVALID', () => {
  assert.deepEqual(codes(lint({ content: '---\nname: grilling\n\n# 正文', skillName: 'grilling' })), ['FM_INVALID'])
})

// ── 判据：name ────────────────────────────────────────────────────

test('缺 name → NAME_MISSING', () => {
  const content = skillFile(['description: 说明'])
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('NAME_MISSING'))
})

test('name 与目录名不一致 → NAME_MISMATCH（build.sh 拦过的同一个坑）', () => {
  const content = skillFile(['name: grill-me', 'description: 说明'])
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('NAME_MISMATCH'))
})

test('name 非 kebab-case → NAME_NOT_KEBAB', () => {
  for (const bad of ['Grill_Me', 'GrillMe', 'grill me', 'grill--me', '-grill']) {
    const content = skillFile([`name: ${bad}`, 'description: 说明'])
    assert.ok(codes(lint({ content, skillName: bad })).includes('NAME_NOT_KEBAB'), `${bad} 应该被判非法`)
  }
})

// ── 判据：description / 布尔键 ────────────────────────────────────

test('缺 description → DESC_MISSING', () => {
  const content = skillFile(['name: grilling'])
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('DESC_MISSING'))
})

test('description 为空 → DESC_MISSING', () => {
  const content = skillFile(['name: grilling', 'description:'])
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('DESC_MISSING'))
})

test('布尔键写了非布尔值 → BOOL_INVALID', () => {
  const content = skillFile(['name: grilling', 'description: 说明', 'user-invocable: maybe'])
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('BOOL_INVALID'))
})

// ── 判据：体积 ────────────────────────────────────────────────────

test('按码点算长度，不按字节也不按 UTF-16 码元', () => {
  assert.equal(codePointLength('中文'), 2)
  assert.equal(codePointLength('🙂'), 1) // 代理对算 1
})

test('正文超限 → SIZE_OVER', () => {
  const content = skillFile(['name: grilling', 'description: 说明'], '中'.repeat(DEFAULT_SIZE_LIMIT))
  assert.ok(codes(lint({ content, skillName: 'grilling' })).includes('SIZE_OVER'))
})

test('刚好低于上限不报', () => {
  const head = skillFile(['name: grilling', 'description: 说明'], '')
  const pad = DEFAULT_SIZE_LIMIT - codePointLength(head) - 1
  const content = skillFile(['name: grilling', 'description: 说明'], '中'.repeat(pad))
  assert.equal(codePointLength(content), DEFAULT_SIZE_LIMIT - 1)
  assert.deepEqual(lint({ content, skillName: 'grilling' }), [])
})

test('sizeLimit 可配置', () => {
  const content = skillFile(['name: grilling', 'description: 说明'], '中'.repeat(50))
  assert.deepEqual(lint({ content, skillName: 'grilling', sizeLimit: 1000 }), [])
  assert.ok(codes(lint({ content, skillName: 'grilling', sizeLimit: 10 })).includes('SIZE_OVER'))
})

// ── 判据：路径识别 ────────────────────────────────────────────────

test('目录包形态认父目录名', () => {
  const t = skillTarget('/Users/x/.dsh/skills/grilling/SKILL.md')
  assert.deepEqual(t, { path: '/Users/x/.dsh/skills/grilling/SKILL.md', skillName: 'grilling' })
})

test('平铺形态认文件主干名', () => {
  const t = skillTarget('/Users/x/.dsh/skills/explore.md')
  assert.equal(t.skillName, 'explore')
})

test('普通 .md 不算 skill', () => {
  assert.equal(skillTarget('/tmp/notes.md'), null)
  assert.equal(skillTarget('/tmp/README.md'), null)
})

test('roots 白名单之外的 SKILL.md 不查', () => {
  const roots = ['/Users/x/.dsh/skills']
  assert.equal(skillTarget('/tmp/whatever/SKILL.md', roots), null)
  assert.ok(skillTarget('/Users/x/.dsh/skills/grilling/SKILL.md', roots))
})

test('路径为空/非字符串 → null', () => {
  assert.equal(skillTarget(''), null)
  assert.equal(skillTarget(undefined), null)
  assert.equal(skillTarget(42), null)
})

// ── 工具函数 ──────────────────────────────────────────────────────

test('splitFrontmatter 只认首行的定界符', () => {
  assert.ok(splitFrontmatter(GOOD).raw)
  assert.ok(splitFrontmatter('\n---\nname: x\n---\n').error, '前导空行应该让 frontmatter 失效')
})

test('scalar 取不到就返回 undefined', () => {
  assert.equal(scalar('name: x', 'nope'), undefined)
})

test('render 带路径、判据码和行动指引', () => {
  const target = { path: '/tmp/skills/x/SKILL.md', skillName: 'x' }
  const text = render(target, lint({ content: '# 无 frontmatter', skillName: 'x' }))
  assert.ok(text.includes('/tmp/skills/x/SKILL.md'))
  assert.ok(text.includes('[FM_INVALID]'))
  assert.ok(text.includes('不会生效'))
})
