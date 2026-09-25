# dsh-script-lint

DSH 插件：在 `write` / `edit` 的缝上拦住**已经真实踩过**的 shell / PowerShell 坑。

和 `dsh-skill-lint` 是同一个思路的第二件 —— 不建通用回归体系，只把踩过的坑固化成断言。

---

## 三条判据（都不是凭空想的）

| 判据码 | 拦什么 | 来自哪次真实事故 |
|---|---|---|
| `SHELL_ERREXIT_TRAP` | `set -e` 下 `x=$(... grep ...)` 失败会**无声终止整个脚本** | `build.sh` 第 170 行：脚本无任何报错地 exit 1，排查了很久 |
| `SHELL_GREP_UNQUOTED_PATH` | 递归 `grep` 用了没加引号的 `$VAR` | `grep -rn ... $D` 且 `$D` 为空 → 把整个 workspace 递归搜了一遍 |
| `PS1_NO_BOM` | `.ps1` 含中文却没有 UTF-8 BOM | 无 BOM 的 UTF-8 在 PowerShell 5.1 下按 ANSI 解码，中文全乱码 |

---

## 为什么 `SHELL_ERREXIT_TRAP` 的判断这么绕

这条判据编码的是几条 bash 语义，**位置和 shell 选项都会改变结论**：

| 写法 | `set -e` 下 | 结论 |
|---|---|---|
| `x=$(grep a f)` | `$()` 的退出码**就是**赋值的退出码 | ❌ 致命 |
| `echo $(grep a f)` | 命令替换的失败**不影响**外层命令的退出码 | ✅ 安全 |
| `if grep -q a f; then` | 条件位置的失败**本来**就是预期 | ✅ 安全 |
| `[ -n "$(grep a f)" ]` | 同上，`[` 的退出码才作数 | ✅ 安全 |
| `for f in $(ls *.md)` | 不参与退出码 | ✅ 安全 |
| `x=$(ls *.md \| grep v \| wc -l)` **无 pipefail** | 只有最后一段（`wc`）作数 | ✅ 安全 |
| 同上 **有 pipefail** | **任何**一段失败都算失败 | ❌ 致命 |
| `x=$(ls *.md \| grep v)` **无 pipefail** | `grep` 是最后一段 | ❌ 致命 |
| `x=$(grep a f \|\| true)` | 显式吞掉了失败 | ✅ 安全 |
| `x=$(grep a f) \| cat` | 跑在子 shell，杀不了整个脚本 | ✅ 安全 |
| `cat f \| { x=$(grep a f); }` | 整个复合命令返回非零，**照样致命** | ❌ 致命 |

所以判据不是"看见 grep 就报"，而是：**先看有没有 `set -e`，再看命令替换在什么位置，最后按 pipefail 的有无决定是"任意一段"还是"最后一段"。**

反过来，只要赋值末尾有 `|| true` / `|| echo 0` / `|| :`，就认定失败被吞掉了，放行。

---

## 两条缝的行为差异（和 dsh-skill-lint 一样）

- **`write` → `tools/pre-execute` → `deny`**：内容还没落盘，坏文件**根本不产生**。
- **`edit` → `tools/post-execute` → `block`**：`edit` 的新全文在调用前不存在，无法预判，只能事后复读磁盘报告。**它撤销不了已经写下去的东西。**

⚠️ 两个插件都挂 `tools/pre-execute`，而瀑布里**第一个 `deny` 会短路**。所以如果一个文件同时踩了两边的坑，一次只会看到一条报告，改完再写才会看到另一条。

---

## 已知边界（重要）

1. **只管 DSH 的 `write` / `edit` 工具。** 用 `cp`、编辑器或任何 shell 命令直接写文件，**完全绕过**。
2. **多行脚本只做逐行 + 引号感知的扫描**，不是真正的 bash 解析器。`eval`、变量间接引用（`$(( ))`、`${!x}`）这类动态构造看不出来。
3. **`|` 右侧以外的管道位置**按上表处理；`lastpipe` 之类改变子 shell 语义的选项不考虑。
4. **宁可多报，漏报是沉默的** —— 但多报到让人关掉插件，就等于没有。所以判据刻意做窄：只报高置信度的形态。

---

## 安装

```bash
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"

cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)"
cp -R dsh-script-lint "$PROFILE/node_modules/"

# 往 $PROFILE/cordis.patch.yml 末尾追加：
#   - insert:
#       - id: script-lint
#         name: 'dsh-script-lint'
```

**为什么用 `cp` 而不是 `ln -s`**：Node 默认按 realpath 解析模块（`preserveSymlinks: false`），symlink 进来的插件会从源目录去找依赖，找不到。

profile 的 `patchReload: live` 让新插件**无需重启**即可生效。

卸载：删掉 `node_modules/dsh-script-lint`，再删掉 `cordis.patch.yml` 里那三行。

---

## 配置

某条判据嫌吵，可以单独关掉，不必卸载整个插件：

```yaml
- insert:
    - id: script-lint
      name: 'dsh-script-lint'
      config:
        disabledRules: ['PS1_NO_BOM']   # 留空 = 三条全开
```

报错信息会**点名管道里所有脆弱段**（不只第一段）—— 因为 `pipefail` 下任何一段失败都算失败，只说第一段会让人去修错行。

## 自测

```bash
node --test test/*.test.mjs
```

38 条断言。头号夹具是 `build.sh` 第 170 行**修之前**的真实内容 —— 那行必须被拦住，加了 `|| true` 之后必须放行。

另外单独验过：当前 `build.sh`、`install.sh`、`uninstall.sh`、`install.ps1` **零误报**。

---

## 结构

```
src/rules.mjs       判据本体：纯函数、零依赖、可单独测试
src/index.mjs       缝接线：把判据挂上 pre-execute / post-execute，不掺判断
test/rules.test.mjs 38 条断言
```

判据与缝刻意分离 —— 测量错了、判据错了可以分别审计，互不掩盖。这套分层学自 `dsh-design-audit` 自述的"测量与判据分离"。
