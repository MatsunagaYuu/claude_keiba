#!/bin/bash
# 出馬表バッチ: スクレイピング → ビューアデータ生成 → デプロイ
# Usage: ./batch_shutuba.sh [日付...]
#   引数なし: 次の開催日をカレンダーから自動特定
#   引数あり: 指定日付の出馬表を取得
#   例: ./batch_shutuba.sh 20260307 20260308
set -e
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

echo "=== 開催カレンダー更新（$(date +%Y)年） ==="
# scrape_calendar.js は netkeiba スクレイピング版。DB版(build_calendar_from_db.js)は
# 2026-06 のDB廃止で動作しないためこちらを使用
node scripts/scrape_calendar.js $(date +%Y)

if [ $# -gt 0 ]; then
  DATES="$@"
else
  echo "=== 次の開催日を自動特定 ==="
  DATES=$(node scripts/get_next_dates.js)
  if [ -z "$DATES" ]; then
    echo "ERROR: 開催日が見つかりません"
    exit 1
  fi
  echo "対象日: $DATES"
fi

echo ""
echo "=== 出馬表取得 ==="
for DATE in $DATES; do
  node scripts/scrape_shutuba.js "$DATE"
done

echo ""
# batch_daily.sh から呼ばれる時（SKIP_DEPLOY=1）は、最後の deploy.sh が
# 同じビルドを実行するのでここではスキップする（二重実行の防止）
if [ "${SKIP_DEPLOY:-}" = "1" ]; then
  echo "=== ビューアデータ生成・デプロイは日次バッチ側でまとめて実行 ==="
else
  echo "=== ビューアデータ生成 (対象日: $DATES) ==="
  node scripts/build_shutuba_data.js --date $DATES

  echo ""
  echo "=== デプロイ ==="
  ./deploy.sh
fi

echo ""
echo "=== 出馬表バッチ完了 ==="
