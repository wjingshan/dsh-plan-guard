# dsh-plan-guard

中文 | [English](README.en.md)

给 DSH 用的**规划 skill + 写时断言插件**：前者让模型在动手前把问题想清楚，后者在模型把踩过的坑再踩一遍时当场拦住。**两半都不建通用体系 —— 只固化真实发生过的事。**

> 这个仓库不是从零设计的。它是两台视频的落地产物：一台讲「写代码之前怎么想清楚」（Grilling / Brainstorming / Explore 三种规划框架），一台讲「写完怎么知道没坏」（把判断对不对从肉眼变成自动断言）。看完之后的结论是：**第一条视频的落点是提示词工件，加 skill 就够；第二条视频的落点是工程架构，加 skill 解决不了 —— 得挂到 DSH 的拦截缝上。** 这个仓库把两句话各做出了实物。

---

## 两半是什么

| | 规划（`skills/`） | 断言（`plugins/`） |
|---|---|---|
| 解决的问题 | 动手之前问题没想清楚 | 动手之后悄悄改坏了 |
| 形态 | 提示词工件（SKILL.md） | DSH 插件（挂 `tools/pre-execute` / `tools/post-execute`） |
| 生效时机 | 你或模型主动加载 | 每次写文件时自动 |
| 可移植性 | **开放 Agent Skills 格式，Claude Code 等也能直接用** | DSH 专有 |

一句话：**skills 管「想」，plugins 管「别改坏」。**

---

## 目录结构

```
dsh-plan-guard/
├── skills/                        ① 规划：三个 skill
│   ├── grilling/                  SKILL.md + references/question-bank.md
│   ├── brainstorming/             SKILL.md + references/design-doc-template.md
│   └── explore/                   SKILL.md + references/ascii-diagrams.md
├── plugins/                       ② 断言：两个 DSH 插件
│   ├── dsh-skill-lint/            写 SKILL.md 时的三条断言
│   └── dsh-script-lint/           写 shell / PowerShell 时的三条断言
├── docs/background.md             来龙去脉 + 每条设计决定为什么这么做
├── install.sh / install.ps1       装 skills
├── uninstall.sh / uninstall.ps1   卸 skills
└── install-plugins.sh             装两个插件进 profile
```

---

## 安装

### 规划 skill

**macOS / Linux**

```bash
git clone https://github.com/wjingshan/dsh-plan-guard.git
cd dsh-plan-guard
bash install.sh
```

**Windows**

```powershell
git clone https://github.com/wjingshan/dsh-plan-guard.git
cd dsh-plan-guard
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

装到 `$DSH_HOME/skills`（默认 `~/.dsh/skills`），这是 DSH 的**用户级** skill 根，对所有项目生效。
装完**不需要重启** —— DSH 监听这些目录，新 skill 下一个对话步骤就出现在目录里。

想只给某个项目用：把 `skills/` 下的目录复制到 `<项目根>/.dsh/skills/`（优先级更高，会盖住全局）。

### 断言插件

**macOS / Linux**

```bash
bash install-plugins.sh
```

它做两件事：把两个包复制进 `<profile>/node_modules/`，再往 `<profile>/cordis.patch.yml` 追加 `insert` 条目。
**用复制而不是软链** —— Node 默认按 realpath 解析模块（`preserveSymlinks: false`），软链进来的插件会从源码目录去找 `@deepseek-ai/schemastery`，那里没有 `node_modules`。

**Windows** —— 同样两件事，手动做：

```powershell
$Profile = "$env:USERPROFILE\.dsh\profiles\web"   # profile 名按你的实际情况改
Copy-Item .\plugins\dsh-skill-lint  "$Profile\node_modules\" -Recurse
Copy-Item .\plugins\dsh-script-lint "$Profile\node_modules\" -Recurse
# 然后往 $Profile\cordis.patch.yml 末尾追加：
#   - insert:
#       - id: skill-lint
#         name: 'dsh-skill-lint'
#   - insert:
#       - id: script-lint
#         name: 'dsh-script-lint'
```

profile 的 `patchReload` 是 `live`，改完即生效，不用重启。

---

## 三个规划 skill

| skill | 比喻 | 干什么 | 什么时候用 |
|---|---|---|---|
| **grilling** | 咄咄逼人的面试官 | 一次只问一个问题，沿设计树追问到底，不接受「差不多」 | 你已有初步想法，想快速找出漏洞 |
| **brainstorming** | 严格的项目经理 | 九步流程，强制产出设计文档 + 自审查 | 项目要上线、多人协作、决策要可追溯 |
| **explore** | 好奇的思维伙伴 | 先读代码、比较选项、画 ASCII 图，默认**不产出任何工件** | 面对一团乱麻的旧系统，不知道从哪下手 |

装完可以直接 `/grilling`、`/brainstorming`、`/explore`，也可以说「帮我拷问一下这个方案」让模型自己加载。

**grilling** 的收尾是硬要求：必须用不超过 5 行复述「已达成的关键决策 + 理由」。
**brainstorming** 有一份 12 节的设计文档模板和四组自审查清单（完整性 / 一致性 / 歧义 / 风险）。
**explore** 有六类 ASCII 图模板 —— 结构图、时序图、状态机、数据流、决策树、对比图 —— 以及「什么时候不该画图」。

---

## 两个断言插件

### dsh-skill-lint —— 写 SKILL.md 时

DSH 的 skill 加载器有两个**沉默**的失败模式：失败了，但你看不出来。

| 判据码 | 拦什么 |
|---|---|
| `FM_INVALID` | 第一行不是 `---`，或 frontmatter 没有收尾的 `---` |
| `NAME_MISSING` | 缺 `name` |
| `NAME_NOT_KEBAB` | `name` 不是 kebab-case |
| `NAME_MISMATCH` | `name` 与所在目录名不一致 |
| `DESC_MISSING` | 缺 `description` 或它为空 |
| `BOOL_INVALID` | `disable-model-invocation` / `user-invocable` 写了非布尔值 |
| `SIZE_OVER` | 正文码点数 ≥ `sizeLimit`（默认 8192，对齐 `dsh-compaction-tool-result-pruner` 的 `thresholdChars`） |

前六条任意一条成立，DSH 都会**静默丢弃整个 skill** —— 模型端分不清「这个 skill 不存在」和「这个 skill 写错了」，日志里只留一条 warning。

### dsh-script-lint —— 写 shell / PowerShell 时

三条判据全部来自真实事故，不是编的：

| 判据码 | 拦什么 | 来自哪次事故 |
|---|---|---|
| `SHELL_ERREXIT_TRAP` | `set -e` 下 `x=$(... grep ...)` 失败会**无声终止整个脚本** | 一个打包脚本无任何报错地 exit 1，排查很久 |
| `SHELL_GREP_UNQUOTED_PATH` | 递归 `grep` 用了没加引号的 `$VAR` | `grep -rn ... $D` 且 `$D` 为空 → 把整个 workspace 递归搜了一遍 |
| `PS1_NO_BOM` | `.ps1` 含中文却没有 UTF-8 BOM | PowerShell 5.1 按 ANSI 解码，中文全乱码 |

`SHELL_ERREXIT_TRAP` 是这里最费心的一条，因为它编码的是 bash 语义 —— **位置和 shell 选项都会改变结论**：

| 写法 | `set -e` 下 | |
|---|---|---|
| `x=$(grep a f)` | `$()` 退出码**就是**赋值的退出码 | ❌ |
| `echo $(grep a f)` / `[ -n "$(…)" ]` / `for f in $(…)` | 不影响外层退出码 | ✅ |
| `x=$(ls \| grep v \| wc -l)` 无 `pipefail` | 只有最后一段作数 | ✅ |
| 同上 **有 `pipefail`** | **任何**一段失败都算 | ❌ |
| `x=$(grep a f \|\| true)` | 显式吞掉了失败 | ✅ |
| `x=$(grep a f) \| cat` | 跑在子 shell，杀不了整个脚本 | ✅ |
| `cat f \| { x=$(grep a f); }` | 复合命令返回非零，**照样致命** | ❌ |

所以它报的错会**点名管道里所有脆弱段**，不只第一段 —— 只说第一段会让人去修错行。

---

## 三条设计决定

**1. 判据与缝分离。** 每个插件的 `src/` 都分成两半：纯函数判据（`lint.mjs` / `rules.mjs`，零依赖、可单独测试）和缝接线（`index.mjs`，只负责挂到 DSH 事件上）。测量错了、判据错了可以分别审计，互不掩盖。这套分层学自 `dsh-design-audit` 自述的「测量与判据分离」。

**2. 两条缝语义不同 —— 这是设计要点，不是实现细节。**

- `write` 走 `tools/pre-execute` → `deny`：内容还没落盘，坏文件**根本不产生**。
- `edit` 只能走 `tools/post-execute` → `block`：`edit` 的入参是 `{old_string, new_string}`，新的全文在调用前**不存在**，无法预判，只能事后复读磁盘报告。而它**撤销不了**已经写下去的东西。

我们**故意不撤销**。一个声称「我帮你回滚了」但其实没回滚的断言，比明说「文件已改坏」危险得多。

**3. 宁可多报，但判据做窄。** 漏报是沉默的，多报至少看得见 —— 所以默认不限制路径，任何 `SKILL.md` 都查。但多报到让人关掉插件，就等于没有，所以每条判据只报高置信度的形态，并且都拿现有真实脚本验过零误报。

---

## 自测

```bash
# skill 断言：24 条
node --test plugins/dsh-skill-lint/test/*.test.mjs

# shell 断言：39 条
node --test plugins/dsh-script-lint/test/*.test.mjs
```

`dsh-script-lint` 的头号测试夹具就是那次真实事故的代码 —— **修之前必须被拦住，加了 `|| true` 之后必须放行**。另有一条测试把现有全部脚本当「必须零误报」夹具。

---

## 已知边界

说清楚，别指望它更多：

1. **只拦 DSH 的 `write` / `edit` 工具。** 用 `cp`、编辑器、或任何 shell 命令直接写文件**完全绕过**。它保护的是「模型在写文件的时候」，不是「任何东西进这个目录的时候」。
2. **不是 bash 解析器。** 逐行 + 引号感知扫描，`eval`、`${!x}` 这类动态构造看不出来。
3. **两个插件都挂 `tools/pre-execute`，瀑布里第一个 `deny` 会短路** —— 一个文件同时踩两边的坑时，一次只见一条报告，改完再写才见另一条。
4. **这不是回归测试体系。** 没有用例库、没有 scoreboard、没有 flag 开/关对比、没有覆盖度。断言只保证「不重复踩同一个坑」，不保证「这次改动没弄坏别的」。

第 4 条是刻意的：那套东西（非确定性、成本、LLM 裁判的信噪比）比这个难一个数量级，规模不到就别上。

---

## 出处

两个视频，都值得看：

- 「你的AI编程总是翻车？因为你少做了一步：设计隔离 | 拆解 Grill-me，Superpowers，Openspec 的第一步」—— 规划那一半的来源
- 「我做 AI Agent 一年，90% 在做表面功夫——直到我换了思路」—— 断言那一半的来源

这个仓库没有抄它们的实现，是把它们的问题意识落到了 DSH 上。

## 许可

MIT
