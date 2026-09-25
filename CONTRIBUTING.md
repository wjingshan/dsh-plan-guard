# 贡献指南

这个仓库的目标读者不只是使用者，还有**想改它的人**。所以这份文档的重点是：让你在不问任何人的情况下，加一条判据、改一条判据、或者把它接到你自己的仓库上。

先读 [`docs/background.md`](docs/background.md) 了解「为什么这么做」，再读本文了解「怎么做」。

---

## 一、仓库的形状

```
skills/        ① 提示词工件：三个规划 skill（不写代码，只有 markdown）
plugins/       ② 代码：两个 DSH 插件（挂 DSH 的拦截缝）
```

两半的耦合度是**零**：`skills/` 不依赖 `plugins/`，反之亦然。你可以只装 skills、只装 plugins、或者只 fork 其中一个插件。

每个插件内部都是同一种两段式结构，**这是本仓库最重要的约定**：

```
plugins/dsh-<名字>/
├── src/
│   ├── rules.mjs / lint.mjs   判据本体：纯函数、零依赖、零 I/O
│   └── index.mjs              缝接线：挂到 DSH 事件、读文件、报日志
├── test/                      只测判据本体，不测缝接线
├── package.json               ESM，main → src/index.mjs
└── cordis.patch.yml           bundle 声明（别人用它安装）
```

**为什么必须分**：测量错了和判据错了要能分别审计，互不掩盖。这句话不是口号，具体表现在：

- 判据是纯函数 → 一条真实事故可以**原样**贴进测试当夹具，不需要搭任何环境
- 判据零 I/O → 你自己在 Node REPL 里 import 就能试，不用起 DSH
- 缝接线薄到一眼看完 → 出问题时能立刻判断「是判据判错了」还是「是没挂上」

如果你要加功能，**先问它属于哪一半**。绝大多数需求属于判据那一半。

---

## 二、一条判据的生命周期

模型调 `write` 写一个文件时，发生这些事：

```
模型 → write(file_path, content)
  │
  ├─ tools/pre-execute  ← 缝 1：内容还没落盘
  │     ├─ exec.name 是 write 吗？不是 → next()
  │     ├─ 路径归我管吗（扩展名 / 文件名）？不是 → next()
  │     ├─ resolveConfig → 拿到配置
  │     ├─ lint({filePath, content}) → 判据跑一遍
  │     └─ 有问题 → return { kind: 'deny', reason: render(...) }
  │                                     ↑ 坏文件**根本不产生**
  │
  ├─ 工具真的执行（落盘）
  │
  └─ tools/post-execute  ← 缝 2：已经落盘了
        ├─ 从磁盘复读全文
        ├─ lint 再跑一遍
        └─ 有问题 → return { kind: 'block', feedback: [...] }
                                        ↑ 只报告，**撤销不了**
```

`edit` 只能走缝 2 —— 它的入参是 `{old_string, new_string}`，新的全文在调用前**不存在**，没法预判。

`deny` 和 `block` 都是 DSH 原生返回类型（`PreToolDecision` / `PostToolDecision`），它们会被渲染成模型看到的工具错误，所以 `render()` 的输出质量直接决定模型能不能自己改对。

**这条链上的任何一环都不需要你发明协议** —— 全是 DSH 已经提供的。

---

## 三、怎么加一条判据（完整例子）

假设你要加一条：**`rm -rf "$DIR"/` 而 `$DIR` 没判空 —— 变量为空时会变成 `rm -rf /`**。

### 1. 先想清楚代码名

判据码是全大写下划线，格式 `<领域>_<问题>`。这里用 `SHELL_RM_UNGUARDED`。

代码名会出现在模型的反馈里，所以它得**一眼看懂是什么问题**，不是缩写谜题。

### 2. 注册它

`plugins/dsh-script-lint/src/rules.mjs`：

```js
export const RULE_CODES = [
  'SHELL_ERREXIT_TRAP',
  'SHELL_GREP_UNQUOTED_PATH',
  'SHELL_RM_UNGUARDED',        // ← 加这里
  'PS1_NO_BOM',
]
```

加在这里有两个作用：`disabledRules` 认识它；测试里那条「RULE_CODES 和实际能报出来的码一致」会逼你把它真的接上（见第 4 步）。

### 3. 写检测函数

同一个文件，**纯函数**，返回结构化数据而不是拼好的句子 —— 拼句子是 `lintShell` 的事：

```js
/** 找出没判空的破坏性 rm。 */
export function findUnguardedRm(text) {
  const out = []
  const lines = text.split('\n')
  for (let idx = 0; idx < lines.length; idx++) {
    const code = stripComment(lines[idx])
    const toks = tokenizeShell(code)
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].text !== 'rm') continue
      // …识别 -rf 与目标 token，判断目标是不是 "$VAR"/ 这种形态…
      // 命中就 out.push({ line: idx + 1, variable: name })
    }
  }
  return out
}
```

复用已有的 `stripComment` / `tokenizeShell` —— 它们已经处理了引号、注释、转义这些烦人细节。**不要**新写一个正则去啃 shell 语法。

### 4. 接进 `lintShell`

```js
export function lintShell(text) {
  const src = String(text)
  const problems = []

  for (const t of findErrexitTraps(src)) {
    problems.push({ code: t.code, line: t.line, message: '…' })
  }

  for (const g of findUnquotedRecursiveGrep(src)) {
    problems.push({ code: 'SHELL_GREP_UNQUOTED_PATH', line: g.line, message: '…' })
  }

  for (const r of findUnguardedRm(src)) {                    // ← 加这一块
    problems.push({
      code: 'SHELL_RM_UNGUARDED',
      line: r.line,
      message:
        `第 ${r.line} 行：\`rm -rf "$${r.variable}"/…\` —— ` +
        `\`$${r.variable}\` 为空时这里会变成 \`rm -rf /\`。` +
        `修法：写成 "\${${r.variable}:?}"，为空时直接报错退出。`,
    })
  }

  return problems
}
```

**消息必须能照着改**。三段式最有用：*哪一行 + 为什么错（具体机制）+ 怎么改*。只说「不安全」等于没说。

### 5. 写测试

`plugins/dsh-script-lint/test/rules.test.mjs`。**必须两边都测**：

```js
test('rm -rf "$DIR"/ 不判空 → 拦', () => {
  const found = findUnguardedRm('rm -rf "$DIR"/*')
  assert.equal(found.length, 1)
  assert.equal(found[0].variable, 'DIR')
})

test('判空了就放行', () => {
  assert.deepEqual(findUnguardedRm('rm -rf "${DIR:?}"/*'), [])
  assert.deepEqual(findUnguardedRm('rm -rf /tmp/build/*'), [])   // 字面量路径，正常
})
```

如果你手上有那次事故的**原始代码**，把它原样贴进来当夹具 —— 那是这个仓库最值钱的东西。看 `build.sh` 那条：
真实出过问题的行**必须**被拦住，修好之后**必须**放行。

### 6. 更新 RULE_CODES 一致性测试会自动覆盖

测试里有这么一条：

```js
test('RULE_CODES 和实际能报出来的码一致（防止忘更新）', () => {
  const emitted = new Set()
  for (const p of lintShell('…能触发每条判据的语料…')) emitted.add(p.code)
  …
  assert.deepEqual([...emitted].sort(), [...RULE_CODES].sort())
})
```

它会在两个方向上都失败：注册了代码但没接上、或者接上了没注册。所以你**得往那段语料里补一个能触发新判据的例子**。

### 7. 更新文档

- `plugins/dsh-script-lint/README.md` 的判据表加一行 —— 写清「拦什么」和「来自哪次事故」
- 如果是行为容易误解的（像 `SHELL_ERREXIT_TRAP`），补一节语义对照表

### 8. 跑测试 + 查误报

```bash
node --test plugins/dsh-script-lint/test/*.test.mjs
```

然后**务必**跑一遍现实脚本的误报检查 —— 见下一节。

### 9. 提交

一次提交只加一条判据。提交信息写清「拦什么」和「来自哪次事故」。

---

## 四、判据必须满足的四条约束

这四条不是风格偏好，是这个仓库能用的前提。**违反任何一条的 PR 都会被要求改。**

### 1. 只判定确定性事实

能报的必须是「机器可以确定的事」，例如：

- ✅ 「DSH **会**因为这个 frontmatter 静默丢弃整个 skill」
- ✅ 「`pipefail` + `grep` 在赋值位置**会**终止脚本」
- ❌ 「这个函数太长了」—— 主观
- ❌ 「这个 prompt 写得不好」—— 主观

主观判断交给模型读。断言层一旦开始做审美，它就变成了一个会误报的评审官，而误报会让用户关掉它 —— 那和没有一样。

### 2. 每条判据都要能指向一次真实事故

**没有真实案例就不加。** 这条约束看起来苛刻，但它是这个仓库和「一堆我觉得可能出错的规则」之间的分界线。

理由：每条判据都是一份维护成本 + 一份误报风险。只有真实事故才能证明这份成本值得。凭想象加的规则，三个月后没人知道它为什么存在，也没人敢删。

如果你确实想加一条预防性的，那就在 PR 里说清**具体会怎么出错**，并把它当事故对待。

### 3. 宁可多报，但判据要做窄

矛盾吗？不矛盾：

- **路径匹配要宽**（任何 `SKILL.md` 都查，不限制目录）—— 漏报是沉默的，多报至少看得见
- **触发形态要窄**（只报高置信度的语法形态）—— 多报到让人关掉插件，等于没有

具体做法：不确定的形态**不报**。`SHELL_ERREXIT_TRAP` 特意不报 `echo $(grep …)`，因为那真的安全；特意区分 `x=$(…) | cat`（子 shell，安全）和 `cat | { x=$(…); }`（复合命令，致命）。这些区分让实现变复杂，但它们是**对的**。

### 4. 消息要能照着改

模型看到的只有你拼出来的那段文字。它得能据此行动：

```
第 170 行：`other=$( … )` —— 里面的 `grep -v` 在没有匹配时返回 1，而 pipefail 让管道里
**任何一段**的失败都算整条管道的失败，于是这个赋值的退出码是 1，set -e 会就此终止
整个脚本 —— 没有任何报错。修法：在 `$()` 末尾加 `|| true`（或 `|| echo 0`），把失败显式吞掉。
```

对照着看，它回答了三件事：**哪一行**、**为什么**（具体到 shell 语义，不是一个形容词）、**怎么改**（给可粘贴的写法）。

另外：如果一条判据有多个可疑点，**全部点名**。`pipefail` 下任何一段都可能失败，只说第一段会让人去修错行 —— 这是实测踩过的。

---

## 五、本地开发：改完立刻验证

插件是零依赖的，所以可以**软链**进 profile 开发，改完即生效（profile 的 `patchReload` 是 `live`）：

```bash
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"

# 首次：软链（零依赖，所以能解析）
ln -s "$PWD/plugins/dsh-script-lint" "$PROFILE/node_modules/dsh-script-lint"

# 往 $PROFILE/cordis.patch.yml 追加：
#   - insert:
#       - id: script-lint
#         name: 'dsh-script-lint'
```

之后改 `src/*.mjs` 就重载生效，不用重新复制。

⚠️ 但软链（以及复制）都**不是 pnpm 管理的** —— 对 profile 跑 `pnpm install` 或 `dsh plugin` 操作可能把它清掉。**长期使用请走 bundle 安装**（见 README）。

验证改动是否真的生效，最直接的办法是**故意触发一次**：

```bash
# 写一个带陷阱的 .sh，应该被 deny
cat > /tmp/trap.sh <<'EOF'
set -euo pipefail
n=$(ls *.zip | grep -v keep | wc -l)
EOF
```

如果它没被拦，说明缝没挂上（而不是判据写错了）。

**判据本身**不需要 DSH 就能试：

```bash
cd plugins/dsh-script-lint
node --input-type=module -e "
import { lintShell, render } from './src/rules.mjs'
console.log(render('/x/a.sh', lintShell('set -euo pipefail\nn=\$(grep a f)\n')))
"
```

---

## 六、改完之后必须跑的三件事

```bash
# 1. 全部测试
node --test plugins/dsh-skill-lint/test/*.test.mjs
node --test plugins/dsh-script-lint/test/*.test.mjs

# 2. 现实脚本误报检查 —— 拿仓库自己和你自己的脚本当夹具
#    （改判据最容易在这里翻车：测试全过，但一上真实代码就满屏误报）
./verify.sh --lint-self

# 3. 如果动过安装脚本：自己跑一遍自己的 linter
#    本仓库的 5 个脚本必须对自己的判据零问题
```

第 2 条最重要。**测试全过不等于判据可用** —— 测试是你挑的语料，误报出现在你没挑的地方。所以养成习惯：手边任何真实脚本都拿来跑一遍。

`install.sh` / `uninstall.sh` / `install-plugins.sh` / `*.ps1` 这五个文件本身就是判据的**演练场**：它们必须对自己的判据零问题。写过一份不带 BOM 的 `.ps1` 的话，`PS1_NO_BOM` 会当场拦下你 —— 这是有意的。

---

## 七、改文档

文档和代码一样会被 review：

- **README 是给使用者的**，别把实现细节倒进去。安装、配置、边界、排障四件事说清就够。
- **`docs/background.md` 是给"想知道为什么"的人的** —— 每条设计决定背后的**取舍**。包括你**放弃了什么**：那部分通常比做出来的部分更有信息量。
- **本文是给改代码的人的。**
- **中英双份要保持同步**。改了一份就改另一份；对不上的时候以中文为准，但别让它长期对不上。
- 别写「显然」「简单」「只需」这类词。踩过坑的人知道它们都不显然。

---

## 八、提交什么、不提交什么

**欢迎**：

- 新判据 —— 带真实事故
- 修正判据的误报 / 漏报（附上触发的代码）
- 更准确的报错消息
- 文档改进，尤其是指出文档写错的地方

**先开 issue 讨论**：

- 新增一个插件（而不是给现有插件加判据）
- 改变判据的返回类型 / 缝的挂法
- 引入任何运行时依赖

**不会接受**：

- 主观判断类的检查（见约束 1）
- 没有真实案例的预防性判据（见约束 2）
- 把判据和缝混在一个文件里的重构
- 为了覆盖更多形态而牺牲精度的改动

---

## 九、一个提醒

这个仓库**故意不建通用体系**。它没有用例库、没有 scoreboard、没有 flag 对比、没有覆盖度统计。

所以如果有人提议「不如加个回归测试框架」——先读 [`docs/background.md`](docs/background.md) 第四节「主动放弃的东西」。不是做不到，是**不该在这个规模上做**。

判据这一层能给你的保证只有一句话：**不重复踩同一个坑**。它不保证「这次改动没弄坏别的」。认清这个边界，比扩功能重要。
