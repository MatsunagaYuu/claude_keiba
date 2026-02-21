#!/bin/bash
# ビューアデータをビルドしてGitHub Pagesにデプロイ
set -e
cd "$(dirname "$0")"

echo "=== ビューアデータビルド ==="
node build_baba_diff.js
node build_viewer_data.js
node build_shutuba_data.js

echo ""
echo "=== Git push ==="
git add docs/
git status --short docs/

# 変更がなければ終了
if git diff --cached --quiet; then
  echo "変更なし"
  exit 0
fi

git commit -m "ビューアデータ更新 $(date +%Y%m%d)"
git push

echo ""
echo "=== デプロイ完了 ==="
