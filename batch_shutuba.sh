#!/bin/bash
# 出馬表バッチ: スクレイピング → ビューアデータ生成 → デプロイ
# Usage: ./batch_shutuba.sh [日付...]
#   引数なし: 次の開催日をカレンダーから自動特定
#   引数あり: 指定日付の出馬表を取得
#   例: ./batch_shutuba.sh 20260307 20260308
set -e
cd "$(dirname "$0")"

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
echo "=== ビューアデータ生成 ==="
node scripts/build_shutuba_data.js

echo ""
echo "=== デプロイ ==="
./deploy.sh

echo ""
echo "=== 出馬表バッチ完了 ==="
