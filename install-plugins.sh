#!/usr/bin/env bash
#
# 把两个断言插件装进 DSH profile（macOS / Linux）。
#
#   bash install-plugins.sh
#
# 为什么要「复制进 node_modules + 改 patch」：
#   DSH 的插件是从 <profile>/node_modules 解析的，所以包必须真的躺在那里。
#   用复制而不是软链：这一版插件零运行时依赖，软链技术上也能解析；真正的区别是 pnpm ——
#   手动放进 node_modules/ 的包不是 pnpm 管理的，将来 pnpm 操作可能把它清掉。
#   想要长期稳定可更新，用 `dsh plugin add` 的 bundle 安装（见 README）。
#
# 可以用 DSH_PROFILE 指定 profile 名（默认 web）。
set -euo pipefail

PLUGINS=(dsh-skill-lint dsh-script-lint)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${DSH_PROFILE:-web}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"
PATCH="$PROFILE/cordis.patch.yml"
MODULES="$PROFILE/node_modules"

if [ ! -d "$PROFILE" ]; then
  echo "✗ 找不到 profile: $PROFILE" >&2
  echo "  如果 profile 名不是 web，用 DSH_PROFILE=<名字> 重跑。" >&2
  exit 1
fi

echo "profile : $PROFILE"
echo "patch   : $PATCH"
echo

# ── 1. 备份 patch ────────────────────────────────────────────
STAMP="$(date +%Y%m%d%H%M%S)"
cp "$PATCH" "$PATCH.bak-$STAMP"
echo "✓ 已备份 $PATCH.bak-$STAMP"

# ── 2. 复制插件 ──────────────────────────────────────────────
mkdir -p "$MODULES"
for p in "${PLUGINS[@]}"; do
  src="$HERE/plugins/$p"
  if [ ! -f "$src/package.json" ]; then
    echo "✗ 缺少 $src/package.json" >&2
    exit 1
  fi
  rm -rf "$MODULES/$p"
  cp -R "$src" "$MODULES/$p"
  echo "✓ 已安装 $p"
done

# ── 3. 追加 patch 条目（已有就跳过，保持幂等）─────────────────
for p in "${PLUGINS[@]}"; do
  if grep -q "name: '$p'" "$PATCH"; then
    echo "· $p 的 patch 条目已存在，跳过"
    continue
  fi
  cat >> "$PATCH" <<YAML

- insert:
    - id: ${p#dsh-}
      name: '$p'
YAML
  echo "✓ 已写入 $p 的 patch 条目"
done

# ── 4. 自检：从 profile 真的能 import 吗 ─────────────────────
echo
echo "自检："
ok=1
for p in "${PLUGINS[@]}"; do
  if (cd "$PROFILE" && node --input-type=module -e "await import('$p')" >/dev/null 2>&1); then
    echo "  ✓ $p 可从 profile 解析"
  else
    echo "  ✗ $p 解析失败 —— 检查 $MODULES/$p 是否完整"
    ok=0
  fi
done

echo
if [ "$ok" -eq 1 ]; then
  echo "安装完成。profile 的 patchReload 是 live，无需重启即可生效。"
  echo "验证：随便写一个 .sh 或 SKILL.md，断言会当场拦下踩过的坑。"
else
  echo "有插件未通过自检。" >&2
  exit 1
fi
