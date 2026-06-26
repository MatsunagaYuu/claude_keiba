#!/bin/bash
# レース結果バッチ: スクレイピング → カレンダー更新 → 基準タイム → 外部馬場差 → 指数 → ビューア → デプロイ
# Usage: ./batch_result.sh [YYYYMMDD ...]
#   引数なし: 直近開催日を自動特定（get_next_dates.js --last）
#   引数あり: 指定日付のデータのみ処理（指数・ビューア更新を絞り込み）
#   例: ./batch_result.sh 20260404 20260405
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

YEAR=$(date +%Y)

if [ $# -gt 0 ]; then
  DATES="$@"
else
  echo "=== 直近開催日を自動特定 ==="
  DATES=$(node scripts/get_next_dates.js --last | tr '\n' ' ')
  if [ -z "$DATES" ]; then
    echo "ERROR: 開催日が見つかりません"
    exit 1
  fi
  echo "対象日: $DATES"
fi

# 日付から年を抽出（ユニーク・スペース区切り）
YEARS=$(echo "$DATES" | tr ' ' '\n' | grep -E '^\d{8}$' | cut -c1-4 | sort -u | tr '\n' ' ')
if [ -z "$YEARS" ]; then
  YEARS="$YEAR"
fi

echo ""
echo "=== レース結果スクレイピング ==="
for DATE in $DATES; do
  node scripts/scrape_result_by_date.js "$DATE"
done

echo ""
echo "=== カレンダー更新 ==="
for Y in $YEARS; do
  node scripts/scrape_calendar.js "$Y"
done

echo ""
echo "=== 基準タイム再計算 ==="
node scripts/build_base_times.js

echo ""
echo "=== 外部馬場差取得 ==="
for Y in $YEARS; do
  node scripts/scrape_external_baba.js "$Y"
done

echo ""
echo "=== 指数算出 (対象日: $DATES) ==="
node scripts/calc_index.js --date $DATES

echo ""
echo "=== ビューアデータ更新 (対象年: $YEARS) ==="
node scripts/build_viewer_data.js --year $YEARS

echo ""
echo "=== デプロイ ==="
./deploy.sh

echo ""
echo "=== レース結果バッチ完了 ==="
