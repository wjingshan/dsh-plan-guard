#!/usr/bin/env bash
#
# 检查「装上去的东西」和「仓库里的东西」是否一致。
#
#   ./verify.sh              全量检查（skills + plugins）
#   ./verify.sh --quiet      只输出有问题的行，适合脚本化
#   ./verify.sh --lint-self  只用本仓库自己的脚本跑一遍判据（开发用，不查安装）
#
# 为什么需要它：安装是把文件**复制**进 node_modules / skills 的，所以 `git pull`
# 之后装上去的还是旧版 —— 而没有任何东西会告诉你这件事。这个脚本就是那个东西。
#
# 退出码：0 = 全部一致；1 = 有未安装/过期/冲突；2 = 用法错误。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS=(grilling brainstorming explore)
PLUGINS=(dsh-skill-lint dsh-script-lint)

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${DSH_PROFILE:-web}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"
PATCH="$PROFILE/cordis.patch.yml"

QUIET=0
LINT_SELF=0
for arg in "$@"; do
  case "$arg" in
    --quiet|-q)     QUIET=1 ;;
    --lint-self)    LINT_SELF=1 ;;
    -h|--help)      sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（-h 看用法）" >&2; exit 2 ;;
  esac
done

ISSUES=0
say()  { [ "$QUIET" -eq 1 ] || printf '%s\n' "$1"; }
ok()   { say "  ✓ $1"; }
bad()  { printf '  ✗ %s\n' "$1"; ISSUES=$((ISSUES + 1)); }
note() { say "  · $1"; }

# ── --lint-self：本仓库自己的脚本必须对自己的判据零问题 ──────────
if [ "$LINT_SELF" -eq 1 ]; then
  say "本仓库脚本自检："
  ( cd "$HERE/plugins/dsh-script-lint" && node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { lintShell, lintPowerShell, render } from './src/rules.mjs'
const root = process.argv[1]
const targets = [
  'install.sh', 'uninstall.sh', 'install-plugins.sh', 'verify.sh', 'update.sh',
  'install.ps1', 'uninstall.ps1',
]
let bad = 0
let checked = 0
for (const name of targets) {
  const file = root + '/' + name
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  checked += 1
  const fn = name.endsWith('.ps1') ? lintPowerShell : lintShell
  const problems = fn(text)
  if (problems.length) { bad += problems.length; console.log(render(file, problems)) }
}
console.log(bad === 0 ? '  ✓ ' + checked + ' 个脚本全部零问题' : '  ✗ 共 ' + bad + ' 个问题')
process.exit(bad === 0 ? 0 : 1)
" "$HERE" ) || ISSUES=$((ISSUES + 1))
  echo
  [ "$ISSUES" -eq 0 ] && exit 0 || exit 1
fi

# ── 1. 规划 skill ────────────────────────────────────────────
say "规划 skill（目标：$DSH_HOME/skills）"
for d in "${SKILLS[@]}"; do
  src="$HERE/skills/$d"
  dst="$DSH_HOME/skills/$d"
  if [ ! -d "$dst" ]; then
    note "$d 未安装"
  elif diff -r "$src" "$dst" >/dev/null 2>&1; then
    ok "$d 已安装且与仓库一致"
  else
    bad "$d 已安装但与仓库**不一致** —— 装的是旧版，或本地改过。重跑 install.sh 更新"
  fi
done

# ── 2. 断言插件 ──────────────────────────────────────────────
echo
say "断言插件（profile：$PROFILE）"
if [ ! -d "$PROFILE" ]; then
  bad "找不到 profile 目录 —— 用 DSH_PROFILE=<名字> 指定"
else
  # 判断「是不是 bundle 安装」的依据是 package.json 的登记，**不是** node_modules 的形态：
  # profile 可能配了 hoisted linking，那样 pnpm 装的包也是真目录，跟手动复制长得一样。
  BUNDLES="$(cd "$PROFILE" && node -e "process.stdout.write((require('./package.json').dsh?.profile?.bundles ?? []).join('\n'))" 2>/dev/null || true)"

  for p in "${PLUGINS[@]}"; do
    src="$HERE/plugins/$p"
    dst="$PROFILE/node_modules/$p"

    in_bundles=0
    if printf '%s\n' "$BUNDLES" | grep -qx "$p"; then in_bundles=1; fi

    entry=0
    if [ -f "$PATCH" ] && grep -q "name: '$p'" "$PATCH"; then entry=1; fi

    if [ ! -e "$dst" ]; then
      if [ "$in_bundles" -eq 1 ]; then
        bad "$p：登记为 bundle 了，但 node_modules 里没有包 —— DSH 会加载失败，重跑 install-plugins.sh"
      else
        note "$p 未安装"
      fi
      continue
    fi

    if [ "$in_bundles" -eq 1 ]; then
      kind="bundle（登记在 dsh.profile.bundles）"
    elif [ "$entry" -eq 1 ]; then
      kind="手动复制 + patch 条目"
    else
      bad "$p：包在 node_modules 里，但既没登记为 bundle，patch 里也没有条目 —— 不会被加载"
      continue
    fi

    # 只比对该比的文件：pnpm 安装按 package.json 的 files 字段裁剪，不会有 test/
    differ=0
    for rel in package.json cordis.patch.yml; do
      if ! diff -q "$src/$rel" "$dst/$rel" >/dev/null 2>&1; then differ=1; fi
    done
    if ! diff -r "$src/src" "$dst/src" >/dev/null 2>&1; then differ=1; fi

    if [ "$differ" -eq 0 ]; then
      ok "$p 已安装且与仓库一致（$kind）"
    else
      bad "$p 已安装但与仓库**不一致**（$kind）—— 装的是旧版，或本地改过。见 README 的「更新」一节"
    fi
  done

  # ── 3. 反向检查：手动复制的那条路不持久 ─────────────────────
  echo
  say "持久性检查"
  manual=0
  for p in "${PLUGINS[@]}"; do
    if [ -e "$PROFILE/node_modules/$p" ] && ! printf '%s\n' "$BUNDLES" | grep -qx "$p"; then
      manual=$((manual + 1))
    fi
  done
  if [ "$manual" -gt 0 ]; then
    note "有 $manual 个插件是手动装进 node_modules 的 —— 它们不在 dsh.profile.bundles 里，"
    note "  不是包管理器管理的，将来 pnpm 操作可能把它当多余包清掉（实测发生过）。"
    note "  想长期稳定：用 dsh 的 plugin_manager 工具走 install_bundle，或见 README 路线 A。"
  else
    ok "没有手动安装残留"
  fi
fi

# ── 汇总 ─────────────────────────────────────────────────────
echo
if [ "$ISSUES" -eq 0 ]; then
  echo "全部一致。"
  exit 0
else
  echo "发现 $ISSUES 个问题（上面标 ✗ 的行）。"
  exit 1
fi
