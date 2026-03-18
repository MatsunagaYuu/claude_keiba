#!/bin/bash
# 欠損データ一括取得
# 2018-2019: 札幌,函館,福島,新潟,中京,京都,阪神,小倉
# 2020-2021: 同上（京都は改修で開催なし）

cd /Users/matsunagayu/Documents/my-project

VENUES_WITH_KYOTO="01 02 03 04 07 08 09 10"
VENUES_NO_KYOTO="01 02 03 04 07 09 10"

echo "=== 欠損データ取得開始: $(date) ==="

for YEAR in 2018 2019; do
  for V in $VENUES_WITH_KYOTO; do
    echo ""
    echo ">>> $YEAR venue=$V 開始: $(date)"
    node runner.js $YEAR $V
    echo ">>> $YEAR venue=$V 完了: $(date)"
  done
done

for YEAR in 2020 2021; do
  for V in $VENUES_NO_KYOTO; do
    echo ""
    echo ">>> $YEAR venue=$V 開始: $(date)"
    node runner.js $YEAR $V
    echo ">>> $YEAR venue=$V 完了: $(date)"
  done
done

echo ""
echo "=== 全取得完了: $(date) ==="
