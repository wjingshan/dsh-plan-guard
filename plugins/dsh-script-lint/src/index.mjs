// dsh-script-lint —— 缝接线。
//
// 判据全在 src/rules.mjs；这里只负责把判据挂到 DSH 的两条缝上，不掺任何判断。
//
// 这个插件是**零运行时依赖**的：cordis 在插件没有 `Config` 导出时会把原始 config
// **直接透传**给 `apply`（见 cordis 的 `resolveConfig`），所以规范化自己手写就行。
// 换来的是复制、软链、pnpm 安装行为完全一致 —— 不会出现「解析不到某个
// @deepseek-ai/* 包」这种跟环境绑定的故障。

import { readFile } from 'node:fs/promises'
import { lint, render, resolveConfig, SHELL_EXTS, PS_EXTS } from './rules.mjs'

/** Cordis 插件名，用于加载器诊断。 */
export const name = 'script-lint'

/** 本插件读的是工具注册表服务：需要 `tools` 才能收到 tools/* 事件。 */
export const inject = ['tools']

const HANDLED = [...SHELL_EXTS, ...PS_EXTS]

function isTarget(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false
  const lower = filePath.toLowerCase()
  return HANDLED.some((e) => lower.endsWith(e))
}

/**
 * 注册两条断言缝。配置字段见 {@link resolveConfig}（`disabledRules`）。
 *
 * @param ctx - 插件上下文；注册随它的生命周期回收。
 * @param config - patch 条目里的 config，可为空。
 */
export function apply(ctx, config = {}) {
  const { disabledRules, problems } = resolveConfig(config)
  for (const p of problems) ctx.logger?.warn?.(`[script-lint] ${p}`)

  const check = (filePath, content) => lint({ filePath, content, disabledRules })

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
