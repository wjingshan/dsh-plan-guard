# dsh-skill-lint

SKILL.md 的**确定性断言**。把「这个 skill 装上去其实不生效」从一次靠肉眼的事后排查，
变成一次当场就会失败的写入。

---

## 它拦的是什么

DSH 的 skill 加载器有两个**沉默**的失败模式 —— 失败了，但你看不出来：

| 失败模式 | 后果 |
|---|---|
| frontmatter 缺 `name` / `description`、`name` 与目录名不一致、布尔键写了非法值 | 整个 skill 被**静默丢弃**。模型端分不清「这个 skill 不存在」和「这个 skill 写错了」，日志里只留一条 warning |
| 正文 ≥ 8192 字符 | 模型通过 `skill` 工具读到的是**被截断**的版本，且没有任何提示 |

两者都是确定性的、可判定的 —— 正好属于「断言」这一层该管的事，不该交给模型的注意力，
也不该靠人记得。

---

## 它怎么拦

挂在两条 DSH 原生缝上，对应断言的两种时机：

| 缝 | 时机 | 对 `write` | 对 `edit` |
|---|---|---|---|
| `tools/pre-execute` | **落盘前** | ✅ `content` 已知，校验不过直接 `deny` —— **坏文件根本不落地** | ❌ 新内容无法预知（它是 old/new 替换） |
| `tools/post-execute` | 落盘后 | 兜底 | ✅ 从磁盘复读后校验，不过则 `block` 并把修正意见回喂模型 |

`block` 之后模型会拿到一段可照着改的反馈，下一轮自己修 —— 断言通过之前会一直拦。这就
是那条闭环：**断言失败 → 反馈 → 改 → 再断言**。

两条缝都是 DSH 原生的、带类型的 waterfall 中间件（`PreToolDecision` / `PostToolDecision`），
不依赖任何自造协议。

---

## 判据

| code | 判据 |
|---|---|
| `FM_INVALID` | 文件第一行不是 `---`，或 frontmatter 没有收尾的 `---` |
| `NAME_MISSING` | frontmatter 缺 `name` |
| `NAME_NOT_KEBAB` | `name` 不是 kebab-case（只允许小写字母、数字，单词间单个连字符） |
| `NAME_MISMATCH` | `name` 与所在目录名不一致 |
| `DESC_MISSING` | frontmatter 缺 `description`，或它为空 |
| `BOOL_INVALID` | `disable-model-invocation` / `user-invocable` 写了非布尔值 |
| `SIZE_OVER` | 正文码点数 ≥ `sizeLimit` |

判据只做**确定性**判定：每条都能指出一个具体的、DSH 会静默吞掉的错误。不做文笔评价、
不做结构建议 —— 那些该由模型读，不该由断言管。

判据本体在 [`src/lint.mjs`](src/lint.mjs)，**零依赖纯函数**；挂在缝上的接线在
[`src/index.mjs`](src/index.mjs)。刻意分开：测量错和判据错可以分别审计，互不掩盖。
想改判据只需要读一个文件，想改挂载方式只需要读另一个。

---

## 判据自测

```bash
npm test        # node --test test/*.test.mjs
```

24 条断言，覆盖每条判据的通过与失败两侧、路径识别的三种形态、以及码点计数的边界。

---

## 安装

> ⚠️ **这条路不持久。** 手动复制进 `node_modules/` 的包不是包管理器管理的，profile 上的一次
> `pnpm install`（可能由别的插件触发）就会把它当"多余的包"清掉，`cordis.patch.yml` 里的
> `insert` 条目也可能被随之重写。**实测发生过：两个插件静默失效，没有任何提示。**
> 长期使用请走主 README 的「路线 A：bundle 安装」。


### 路线 A：塞进 profile（本地开发用这个）

```bash
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
cp -R dsh-skill-lint "$PROFILE/node_modules/"
```

然后往 `"$PROFILE/cordis.patch.yml"` 末尾追加：

```yaml
- insert:
    - id: skill-lint
      name: 'dsh-skill-lint'
```

profile 是 `patchReload: live`，保存后即生效，不需要重启。

**为什么用复制而不是软链**：这一版插件是**零运行时依赖**的（只用 `node:` 内置模块），所以软链在技术上也能解析 —— 早先那条"软链会找不到 `@deepseek-ai/schemastery`"的限制已经不存在了。
真正的取舍变成了 pnpm：手动复制或软链进 `node_modules/` 的包**不是 pnpm 管理的**，将来对 profile 跑 `pnpm install` 或任何 `dsh plugin` 操作时，它可能被当成"多余的包"清掉。想要长期稳定、可更新，用 **bundle 安装**（见主 README 的「安装」一节）。

### 路线 B：当 bundle 正式安装

包内已经带了 `cordis.patch.yml` 和 `package.json` 的 `dsh.bundle.patch` 声明，所以
只要包能被 profile 解析，把它加进 profile `package.json` 的 `dsh.profile.bundles` 即可。

---

## 配置

```yaml
- insert:
    - id: skill-lint
      name: 'dsh-skill-lint'
      config:
        sizeLimit: 8192        # 正文码点上限
        roots: []              # 只检查这些 skill 根底下的文件；留空 = 不限制路径
```

`roots` 默认留空是**故意的**：任何位置名叫 `SKILL.md` 的文件都查。断言宁可多报，也不要
因为路径没猜对而漏报 —— 漏报是沉默的，多报至少看得见。

---

## 已知边界

- **`block` 不会撤销已经落盘的写入。** 它让模型*知道*并去修，而不是让坏文件消失。想要
  「坏文件根本不落地」的效果，只有 `write` 能做到（走 `pre-execute` 的 `deny`）。
- 只查 frontmatter 与体积，**不查正文内容是否合理**。那是模型该读的，不是断言该管的。
- 体积判定用**码点**数，与 `dsh-compaction-tool-result-pruner` 的 `thresholdChars` 同口径。
  注意这和「字节数」不同：中文一个字算 1，不是 3。（`build.sh` 里那条 8192 字节守卫因此
  比这个更严 —— 它量的是字节。）
- 触发时机是**工具调用**，不是文件系统。绕过 `write` / `edit` 直接改盘（`bash` 里 `echo >`
  之类）不会经过断言。
- 判定用的是朴素的 frontmatter 标量解析，不是完整 YAML。对 DSH 会读的那几个顶层标量足够，
  对嵌套结构不适用。
