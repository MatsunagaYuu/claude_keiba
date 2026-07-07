#!/bin/bash
# ビューアデータをビルドしてGitHub Pagesにデプロイ
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

echo "=== ビューアデータビルド ==="
# 注意: baba_diff.json は内製v2で管理（batch_result.sh が --append で更新）。ここで再生成しないこと
node scripts/build_viewer_data.js
node scripts/build_shutuba_data.js
cp base_times.json docs/

echo ""
echo "=== Git push ==="
git add docs/ baba_diff.json venue_calibration.json external_baba_diff.json kaisai_calendar.json base_times.json
git status --short docs/ baba_diff.json venue_calibration.json external_baba_diff.json kaisai_calendar.json base_times.json

# 変更がなければ終了
if git diff --cached --quiet; then
  echo "変更なし"
  exit 0
fi

git commit -m "ビューアデータ更新 $(date +%Y%m%d)"
git push origin HEAD:main || (git fetch origin main && git rebase --autostash origin/main && git push origin HEAD:main)

echo ""
echo "=== デプロイ完了 ==="
