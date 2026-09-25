#!/usr/bin/env bash
#
# 更新已安装的 skill / 插件到仓库的当前版本。
#
#   ./update.sh              拉取最新 + 重装装过的 + 校验
#   ./update.sh --no-pull    跳过 git pull（已经自己拉过了）
#   ./update.sh --check      只跑 git fetch 看有没有新提交，不做任何改动
#
# 为什么不能只 `git pull`：安装是把文件复制进 node_modules / skills 的，
# 拉下来的新代码不会自动替换装上去的旧副本。这个脚本补上那一步。
#
# 退出码：0 = 成功（或已是最新）；1 = 有步骤失败。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS=(grilling brainstorming explore)
PLUGINS=(dsh-skill-lint dsh-script-lint)

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${DSH_PROFILE:-web}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"

PULL=1
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)  PULL=0 ;;
    --check)    CHECK_ONLY=1 ;;
    -h|--help)  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（-h 看用法）" >&2; exit 2 ;;
  esac
done

cd "$HERE"

# ── 1. 拉取 ──────────────────────────────────────────────────
if [ "$PULL" -eq 1 ]; then
  if [ ! -d .git ]; then
    echo "· 这里不是 git 检出（可能是解压出来的），跳过 git pull"
  else
    echo "拉取最新："
    git fetch --quiet origin
    behind="$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)"
    if [ "$behind" = "0" ]; then
      echo "  · 已是最新（与上游一致）"
    else
      echo "  · 上游有 $behind 个新提交"
    fi

    if [ "$CHECK_ONLY" -eq 1 ]; then
      echo
      echo "（--check：只看不做）"
      exit 0
    fi

    git merge --ff-only --quiet '@{upstream}'
    echo "  ✓ 已快进到 $(git log --oneline -1)"
  fi
elif [ "$CHECK_ONLY" -eq 1 ]; then
  echo "（--check 需要 git pull 才能比对，这里看到的是本地状态）"
fi

# ── 2. 重装「已经装过」的 skill ───────────────────────────────
echo
echo "规划 skill："
reinstalled=0
for d in "${SKILLS[@]}"; do
  dst="$DSH_HOME/skills/$d"
  if [ ! -d "$dst" ]; then
    echo "  · $d 未安装，跳过（想装就跑 install.sh）"
    continue
  fi
  rm -rf "$dst"
  cp -R "$HERE/skills/$d" "$dst"
  echo "  ✓ $d 已更新"
  reinstalled=$((reinstalled + 1))
done
[ "$reinstalled" -eq 0 ] && echo "  · 一个都没装过"

# ── 3. 重装「手动复制」的插件；bundle 安装的交给 dsh plugin ────
echo
echo "断言插件："
manual=0
bundled=0
for p in "${PLUGINS[@]}"; do
  dst="$PROFILE/node_modules/$p"
  if [ ! -e "$dst" ]; then
    echo "  · $p 未安装，跳过（想装就跑 install-plugins.sh）"
    continue
  fi

  if [ -L "$dst" ]; then
    # pnpm 管理的（由 dsh plugin add 装的）：git 依赖在 lockfile 里钉了 commit，
    # 重新 add 一次才会重新解析。这里不替你猜 spec，只把该跑的命令打出来。
    bundled=$((bundled + 1))
    echo "  · $p 是 bundle 安装（pnpm 管理），不在这里覆盖"
    echo "      更新：dsh plugin --profile $PROFILE_NAME add 'github:wjingshan/dsh-plan-guard#path:/plugins/$p'"
    continue
  fi

  rm -rf "$dst"
  cp -R "$HERE/plugins/$p" "$dst"
  echo "  ✓ $p 已更新（手动复制）"
  manual=$((manual + 1))
done

# ── 4. 校验 ──────────────────────────────────────────────────
echo
echo "校验："
if bash "$HERE/verify.sh" --quiet; then
  echo "  ✓ 安装与仓库一致"
else
  echo "  ✗ 见上面的 ✗ 行"
  exit 1
fi

echo
echo "完成。profile 的 patchReload 是 live，不用重启；"
echo "skill 目录也是被监听的，下一个对话步骤就会用上新版本。"
