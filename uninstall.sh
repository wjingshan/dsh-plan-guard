#!/usr/bin/env bash
#
# 卸载三个规划 skill（macOS / Linux）。
#
#   bash uninstall.sh
#
# 只删这三个名字，不动 $DSH_HOME/skills 下的其他任何内容。
set -euo pipefail

SKILLS=(grilling brainstorming explore)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEST="$DSH_HOME/skills"

echo "目标 : $DEST"
echo

if [ ! -d "$DEST" ]; then
  echo "· $DEST 不存在，无需卸载。"
  exit 0
fi

for d in "${SKILLS[@]}"; do
  if [ -d "$DEST/$d" ]; then
    rm -rf "$DEST/$d"
    echo "✓ 已移除 $d"
  else
    echo "· $d 未安装，跳过"
  fi
done

echo
echo "完成。留下的 .bak-<时间戳> 备份目录（如果有）不会自动删除，需要时手动清理。"
