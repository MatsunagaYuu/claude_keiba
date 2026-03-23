#!/bin/bash
# レース結果バッチ: 結果取得 → カレンダー更新 → 基準タイム → 馬場差 → 指数 → ビューア → デプロイ
# Usage: ./batch_result.sh [日付...]
#   引数なし: 直近の過去開催日をカレンダーから自動特定
#   引数あり: 指定日付の結果を取得
#   例: ./batch_result.sh 20260228 20260301
set -e
cd "$(dirname "$0")"

YEAR=$(date +%Y)

if [ $# -gt 0 ]; then
  DATES="$@"
else
  echo "=== 直近の過去開催日を自動特定 ==="
  DATES=$(node scripts/get_next_dates.js --last)
  if [ -z "$DATES" ]; then
    echo "ERROR: 過去開催日が見つかりません"
    exit 1
  fi
  echo "対象日: $DATES"
fi

echo ""
echo "=== レース結果取得 ==="
for DATE in $DATES; do
  node scripts/scrape_result_by_date.js "$DATE"
done

echo ""
echo "=== カレンダー更新 ==="
node scripts/scrape_calendar.js "$YEAR"

echo ""
echo "=== 基準タイム再計算 ==="
node scripts/build_base_times.js

echo ""
echo "=== 馬場差再計算 ==="
node scripts/build_baba_diff.js

echo ""
echo "=== 外部馬場差取得 ==="
node scripts/scrape_external_baba.js "$YEAR"

echo ""
echo "=== 指数算出 ==="
node scripts/calc_index.js

echo ""
echo "=== ビューアデータ更新 ==="
node scripts/build_viewer_data.js

echo ""
echo "=== デプロイ ==="
./deploy.sh

echo ""
echo "=== レース結果バッチ完了 ==="
