# 更新日志

两个插件各自有独立版本号（见各自的 `package.json`）；仓库层级用 tag 标记发布。
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

**改完判据请顺手在这里加一条。** 使用者需要知道「我装的那版有没有这条判据」。

---

## [0.2.0] — 2026-09-26

### 改变（不兼容）

- **两个插件现在零运行时依赖。** 去掉了 `@deepseek-ai/schemastery`，`Config` 导出换成手写的
  `resolveConfig()`。依据是 cordis 的 `resolveConfig`：插件没有 `Config` 导出时，原始 config
  **直接透传**给 `apply`。
  - 好处：复制、软链、pnpm 三种安装方式行为完全一致；不再有「解析不到 `@deepseek-ai/schemastery`」
    这类跟环境绑定的故障。
  - 影响：配置**不再有 schema 校验**。`resolveConfig` 会校验类型、填默认值、把问题回报给
    `ctx.logger`，坏值回退到默认而不是抛错 —— 配置写错不该让整个插件加载失败。
  - 判据行为**没有任何变化**。升级不影响拦截结果。
- 安装文档重写为两条路径：**bundle 安装（推荐，pnpm 管理）** 与 **复制安装（回退，离线可用）**。
  原先「必须复制、软链会失败」的说法随零依赖改动而失效，已更正。
- `install-plugins.sh` 的注释随之更新。

### 新增

- **`CONTRIBUTING.md`** —— 面向改代码的人：仓库形状、一条判据的完整生命周期、
  **一步步加一条判据的完整例子**、判据必须满足的四条约束、本地软链调试法。
- **`verify.sh`** —— 检查「装上去的」和「仓库里的」是否一致。这是原先完全缺失的一环：
  安装是复制文件，`git pull` 之后装上去的还是旧版，而**没有任何东西会告诉你**，这个脚本就是那个东西。
  还能识别手动复制 / pnpm 管理两种装法，并在 patch 有条目但包不存在时报警（那会让 DSH 加载失败）。
- **`update.sh`** —— 拉取 + 只重装已经装过的 + 校验。bundle 安装的插件会打印出对应的
  `dsh plugin add` 命令而不是替你猜 spec。
- **`CHANGELOG.md`** —— 本文件。

### 修正

- **README 原先推荐的 `dsh plugin --profile web add <spec>` 装不上。** 实测发现 CLI 的 `plugin`
  子命令只是把参数**原样转发给 pnpm**，**不登记 `dsh.profile.bundles`** —— 包会装上，但 bundle 的
  patch 不生效，插件根本不会加载（缝是死的）。正确入口是 **`plugin_manager` 工具的 `install_bundle`**，
  它做三件事：pnpm 安装 + bundle 登记 + 加载校验。中英 README 都已改正。
- **`verify.sh` 判断「是否 bundle 安装」的依据错了。** 原先看 `node_modules/<name>` 是不是软链，
  但 profile 可能配了 hoisted linking —— 那种情况下 pnpm 装的包也是**真目录**，和手动复制从形态上
  无法区分，于是 bundle 安装会被误报成「patch 里没有条目，不会被加载」。
  现在改为读 `package.json` 的 `dsh.profile.bundles` 登记 —— 那才是权威依据。

### 测试

- skill-lint：24 → **28** 条（新增 `resolveConfig` 的默认值/坏值/未知键覆盖）
- script-lint：39 → **46** 条（新增 `resolveConfig`、`disabledRules` 过滤生效、
  以及一条「`RULE_CODES` 与实际能报出来的码一致」的一致性守卫）

---

## [0.1.0] — 2026-09-26

首个版本。

### 规划 skill

三个规划框架，开放 Agent Skills 格式（`SKILL.md` + YAML frontmatter）：

- **grilling** —— 对抗式一对一追问。一次只问一个问题，沿设计树下行，不接受含糊回答。
  收尾硬要求：不超过 5 行复述已达成的关键决策。附 `references/question-bank.md`
  （8 个分支的具体问句 + 把含糊回答逼到具体的追问话术对照表）。
- **brainstorming** —— 九步流程，强制产出设计文档。附 `references/design-doc-template.md`
  （12 节模板 + 完整性/一致性/歧义/风险四组自审查清单）。
- **explore** —— 先读代码、比选项、画 ASCII 图，默认不产出任何工件。
  附 `references/ascii-diagrams.md`（结构图/时序图/状态机/数据流/决策树/对比图六类模板）。

### 断言插件

- **dsh-skill-lint** —— 写 `SKILL.md` 时的七条判据。前六条任意一条成立，DSH 都会**静默丢弃
  整个 skill**，模型端分不清「不存在」和「写错了」。
- **dsh-script-lint** —— 写 shell / PowerShell 时的三条判据，全部来自真实事故：
  `SHELL_ERREXIT_TRAP`（`set -e` 下的命令替换陷阱）、`SHELL_GREP_UNQUOTED_PATH`
  （递归 grep 的裸变量）、`PS1_NO_BOM`（缺 BOM 的 `.ps1`）。

两个插件都不挂 `tools/pre-execute` 之外的东西：

- `write` → `pre-execute` → `deny`：坏文件**根本不产生**
- `edit` → `post-execute` → `block`：只能事后报告，**撤销不了**（`edit` 的新全文在调用前不存在）

### 已知边界（首发即声明）

只拦 DSH 的 `write` / `edit`；不是 bash 解析器；两个插件都挂 `pre-execute` 而第一个 `deny`
会短路；**这不是回归测试体系** —— 断言只保证不重复踩同一个坑，不保证改动没弄坏别的。
