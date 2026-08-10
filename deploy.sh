#!/bin/bash
# ビューアデータをGitHub Pagesにデプロイ
# Usage: ./deploy.sh [--build]
#   通常: 各バッチが生成済みの docs/ をコミットしてpushするだけ
#   --build: docs/ を全件再生成してからデプロイ（全期間の作り直しが必要なとき用）
#
# 注意: 以前はここで無条件に全件再生成していたが、バッチ側の絞り込み
#   （build_viewer_data.js --year / build_shutuba_data.js --date）を打ち消し、
#   過去日の出馬表JSONまで毎回書き換えてリポジトリを肥大化させていた。
#   JSONは1行のため1バイトの変化でもファイル全体が新しいblobとして積まれる。
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# batch_daily.sh から呼ばれる個別バッチ用。データ生成だけ各バッチにやらせ、
# 重い build_viewer_data.js と push は日次バッチの最後に1回だけ実行する
if [ "${SKIP_DEPLOY:-}" = "1" ]; then
  echo "=== デプロイはスキップ（日次バッチが最後にまとめて実行） ==="
  exit 0
fi

echo "=== ビューアデータビルド ==="
# baba_diff.json は内製v2で管理（batch_result.sh が --append で更新）。ここで再生成しないこと
# build_shutuba_data.js は開催済みの日をスキップするので、全件走らせても
# 過去日のJSONは書き換わらない（--build 指定時のみ --all で強制再生成）
node scripts/build_viewer_data.js
if [ "$1" = "--build" ]; then
  node scripts/build_shutuba_data.js --all
else
  node scripts/build_shutuba_data.js
fi
echo ""

TARGETS="docs/ baba_diff.json venue_calibration.json external_baba_diff.json kaisai_calendar.json"

echo "=== Git push ==="
git add $TARGETS
git status --short $TARGETS

# 変更がなければ終了
if git diff --cached --quiet; then
  echo "変更なし"
  exit 0
fi

git commit -m "ビューアデータ更新 $(date +%Y%m%d)"
git push origin HEAD:main || (git fetch origin main && git rebase --autostash origin/main && git push origin HEAD:main)

echo ""
echo "=== デプロイ完了 ==="
