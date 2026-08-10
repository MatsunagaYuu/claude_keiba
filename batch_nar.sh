#!/bin/bash
# 地方競馬（NAR）バッチ: 結果取得 → 馬場差追記 → 指数 → 出馬表取得 → ビューア更新 → デプロイ
# 対象会場は scripts/nar_scraper.js の NAR_ACTIVE_CODES で管理（現在: 門別・盛岡・水沢・浦和・船橋・大井・川崎）
# Usage: ./batch_nar.sh YYYYMMDD [YYYYMMDD ...]
#   指定日付それぞれについて「結果」と「出馬表」の両方を試みる。
#   対象会場の開催がない日・まだ結果が出ていない日（出馬表のみ公開）は自動でスキップされる。
#   例: ./batch_nar.sh 20260727 20260728 20260729
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if [ $# -eq 0 ]; then
  echo "Usage: ./batch_nar.sh YYYYMMDD [YYYYMMDD ...]"
  echo "  例: ./batch_nar.sh 20260727 20260728 20260729"
  exit 1
fi
DATES="$@"

# 未来日の結果は存在しないので取りに行かない。
# 日次バッチは数日先まで渡してくる（出馬表のため）ので、ここで弾かないと
# 1日あたり十数レース分の無駄なリクエストと "No data found" ログが出る
PAST_DATES=$(node -e "
  const now = new Date();
  const today = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  console.log(process.argv.slice(1).filter(d => d <= today).join(' '));
" $DATES)

if [ -n "$PAST_DATES" ]; then
  echo "=== 結果取得 (対象日: $PAST_DATES) ==="
  node scripts/scrape_nar_result_by_date.js "$(echo $PAST_DATES | tr ' ' ',')"
else
  echo "=== 結果取得: 対象日なし（未来日のみ） ==="
fi

# --append は対象日に観測が無いとエラー終了する（結果未取得の未来日を含む場合があるため）。
# 実際に結果CSVが存在する日付だけに絞って渡す。race_id形式 {YYYY}{code}{MMDD}{RR}
RESULT_DATES=$(node -e "
const fs = require('fs');
const dates = process.argv.slice(1);
const have = new Set(fs.readdirSync('nar_race_result').filter(f => f.endsWith('.csv'))
  .map(f => { const rid = f.replace('result_', '').replace('.csv', ''); return rid.slice(0, 4) + rid.slice(6, 10); }));
console.log(dates.filter(d => have.has(d)).join(' '));
" $DATES)

if [ -n "$RESULT_DATES" ]; then
  echo ""
  echo "=== 内製馬場差 追記 (結果ありの日: $RESULT_DATES) ==="
  node scripts/build_nar_baba_diff.js --append $RESULT_DATES

  echo ""
  echo "=== 指数算出（全件再計算） ==="
  node scripts/calc_nar_index.js
else
  echo ""
  echo "=== 結果データなし（未来日のみ）。馬場差・指数の更新をスキップ ==="
fi

echo ""
echo "=== 出馬表取得 (対象日: $DATES) ==="
for DATE in $DATES; do
  node scripts/scrape_nar_shutuba.js "$DATE"
done

echo ""
echo "=== ビューアデータ更新 ==="
node scripts/build_viewer_data.js
node scripts/build_shutuba_data.js --date $DATES

echo ""
echo "=== デプロイ ==="
./deploy.sh

echo ""
echo "=== NARバッチ完了 ==="
