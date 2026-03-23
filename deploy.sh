#!/bin/bash
# ビューアデータをビルドしてGitHub Pagesにデプロイ
set -e
cd "$(dirname "$0")"

echo "=== ビューアデータビルド ==="
node scripts/build_baba_diff.js
node scripts/build_viewer_data.js
node scripts/build_shutuba_data.js
cp base_times.json docs/

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
git push origin HEAD:main

echo ""
echo "=== デプロイ完了 ==="
