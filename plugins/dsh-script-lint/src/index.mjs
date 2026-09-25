// dsh-script-lint —— 缝接线。
//
// 判据全在 src/rules.mjs；这里只负责把判据挂到 DSH 的两条缝上，不掺任何判断。

import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { lint, render, SHELL_EXTS, PS_EXTS } from './rules.mjs'

export const name = 'script-lint'
export const inject = ['tools']

export const Config = z.object({
  disabledRules: z
    .array(z.string())
    .default([])
    .description('要关掉的判据码，例如 ["PS1_NO_BOM"]；留空表示三条全开'),
})

const HANDLED = [...SHELL_EXTS, ...PS_EXTS]

function isTarget(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  const lower = filePath.toLowerCase()
  return HANDLED.some((e) => lower.endsWith(e))
}

export function apply(ctx, config = {}) {
  const disabled = new Set(config.disabledRules ?? [])
  const check = (filePath, content) =>
    lint({ filePath, content }).filter((p) => !disabled.has(p.code))

  // 缝 1：write —— 内容还没落盘，可以直接拒绝，坏文件根本不产生。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write') return next()
    const args = exec.arguments ?? {}
    const filePath = args.file_path
    if (!isTarget(filePath)) return next()

    const problems = check(filePath, args.content ?? '')
    if (problems.length === 0) return next()

    return { kind: 'deny', reason: render(filePath, problems) }
  })

  // 缝 2：write/edit 落盘之后复验。
  //   edit 的新全文在调用前不存在，只能走这条；而这条**撤销不了**已经写下去的东西，
  //   所以它只报告。一个声称"我帮你回滚了"但其实没回滚的断言，比明说"已改坏"更危险。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'write' && exec.name !== 'edit') return decision

    const filePath = exec.arguments?.file_path
    if (!isTarget(filePath)) return decision

    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return decision // 读不到就放行，别把无关的失败算到脚本头上
    }

    const problems = check(filePath, text)
    if (problems.length === 0) return decision

    return {
      kind: 'block',
      feedback: [{ type: 'text', text: render(filePath, problems) }],
    }
  })
}
