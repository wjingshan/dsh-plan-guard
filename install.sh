#!/usr/bin/env bash
#
# 把三个规划 skill 装到本机 DSH（macOS / Linux）。
#
#   bash install.sh
#
# 装到 $DSH_HOME/skills（DSH_HOME 没设就是 ~/.dsh）—— 这是 DSH 的「用户级」skill 根，
# 优先级 400，对所有项目生效。想只给某个项目用，把 skills/ 下的目录复制到
# <项目根>/.dsh/skills/ 即可（优先级 100，会盖住全局）。
set -euo pipefail

SKILLS=(grilling brainstorming explore)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/skills"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEST="$DSH_HOME/skills"

echo "源目录 : $SRC"
echo "目标   : $DEST"
echo

# ── 先校验包完整 ──────────────────────────────────────────────
missing=0
for d in "${SKILLS[@]}"; do
  if [ ! -f "$SRC/$d/SKILL.md" ]; then
    echo "✗ 缺少 $SRC/$d/SKILL.md" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "包不完整，请重新克隆后再试。" >&2
  exit 1
fi

mkdir -p "$DEST"

# ── 逐个安装（已存在则先备份，不静默覆盖）──────────────────────
for d in "${SKILLS[@]}"; do
  if [ -d "$DEST/$d" ]; then
    backup="$DEST/$d.bak-$(date +%Y%m%d%H%M%S)"
    mv "$DEST/$d" "$backup"
    echo "· $d 已存在，旧版备份为 $(basename "$backup")"
  fi
  cp -R "$SRC/$d" "$DEST/$d"
  echo "✓ 已安装 $d"
done

# ── 装后自检：frontmatter 的 name 必须和目录名一致 ─────────────
# DSH 遇到写错的 frontmatter 会**静默丢弃**整个 skill，模型端分不清
# 「不存在」和「写错了」，所以这里必须自己拦一道。
echo
echo "自检："
ok=1
for d in "${SKILLS[@]}"; do
  f="$DEST/$d/SKILL.md"
  name="$(awk '/^---[[:space:]]*$/{n++; next} n==1 && /^name:/{sub(/^name:[[:space:]]*/,""); gsub(/^["'"'"']|["'"'"']$/,""); print; exit}' "$f")"
  if [ "$name" = "$d" ]; then
    refs=""
    [ -d "$DEST/$d/references" ] && refs=" +references/"
    echo "  ✓ $d  (name 匹配$refs)"
  else
    echo "  ✗ $d  frontmatter name = '$name'，与目录名不一致 —— DSH 会丢弃这个 skill"
    ok=0
  fi
done

echo
if [ "$ok" -eq 1 ]; then
  echo "安装完成。DSH 会自动发现这些 skill（无需重启）："
  echo "  /grilling    /brainstorming    /explore"
  echo
  echo "接下来可以再跑 install-plugins.sh 装上两个断言插件。"
else
  echo "有 skill 未通过自检，详见上面的 ✗ 行。" >&2
  exit 1
fi
