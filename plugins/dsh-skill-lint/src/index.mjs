/**
 * dsh-skill-lint —— 把「SKILL.md 写坏了」变成一次可拦截的失败。
 *
 * 挂两条原生缝，对应断言的两种时机：
 *
 *   tools/pre-execute  ── write 的 content 在**落盘前**就可见。
 *                         校验不过直接 deny，坏文件根本不落地。
 *
 *   tools/post-execute ── edit 的新内容无法预知（它是 old/new 字符串替换），
 *                         只能落盘后从磁盘复验；不过则 block，把修正意见回喂模型，
 *                         模型下一轮自己改到通过为止。
 *
 * 两条缝都是 DSH 原生的、带类型的 waterfall 中间件 —— 这套东西不依赖任何自造协议。
 *
 * 判据全在 ./lint.mjs，本文件只负责接线与配置。
 *
 * @module dsh-skill-lint
 */
import { readFile } from 'node:fs/promises'
import { lint, render, resolveConfig, skillTarget } from './lint.mjs'

/** Cordis 插件名，用于加载器诊断。 */
export const name = 'skill-lint'

/** 本插件读的是工具注册表服务：需要 `tools` 才能收到 tools/* 事件。 */
export const inject = ['tools']

/**
 * 注册两条断言缝。
 *
 * 配置字段见 {@link resolveConfig}（`sizeLimit` / `roots`）。
 *
 * 这个插件是**零运行时依赖**的：cordis 在插件没有 `Config` 导出时会把原始 config
 * **直接透传**给 `apply`（见 cordis 的 `resolveConfig`），所以规范化自己手写就行。
 * 换来的是复制、软链、pnpm 安装行为完全一致 —— 不会出现「解析不到某个
 * @deepseek-ai/* 包」这种跟环境绑定的故障。
 *
 * @param ctx - 插件上下文；注册随它的生命周期回收。
 * @param config - patch 条目里的 config，可为空。
 */
export function apply(ctx, config = {}) {
  const { sizeLimit, roots, problems } = resolveConfig(config)
  for (const p of problems) ctx.logger?.warn?.(`[skill-lint] ${p}`)

  // 缝 1：写入前拦截。坏文件不落地 —— 这是 write 特有的优势。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write') return next()
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return next()

    const target = skillTarget(args.file_path, roots)
    if (target === null) return next()

    const problems = lint({ content: String(args.content ?? ''), skillName: target.skillName, sizeLimit })
    if (problems.length === 0) return next()

    return { kind: 'deny', reason: render(target, problems) }
  })

  // 缝 2：落盘后复验。edit 走这里；write 也走这里，兜住 pre 没预见的形态
  //（例如未来新增的写入工具，或 pre 阶段 content 尚不完整的情况）。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'write' && exec.name !== 'edit') return decision

    const args = exec.arguments
    if (args === null || typeof args !== 'object') return decision

    const target = skillTarget(args.file_path, roots)
    if (target === null) return decision

    let content
    try {
      content = await readFile(target.path, 'utf8')
    } catch {
      // 文件不存在或读不到 —— 不是本断言的事，别把无关失败算到 skill 头上。
      return decision
    }

    const problems = lint({ content, skillName: target.skillName, sizeLimit })
    if (problems.length === 0) return decision

    return { kind: 'block', feedback: [{ type: 'text', text: render(target, problems) }] }
  })
}
