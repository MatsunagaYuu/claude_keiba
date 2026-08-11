#!/bin/bash
# バッチ実行のエントリポイント。launchd から無人実行される想定。
#
# Usage: ./batch_daily.sh <mode>
#   --jra-shutuba : JRA出馬表 + デプロイ        （月17:00 / 木17:00 / 金10:30 / 土10:30）
#   --jra-result  : JRA結果 + JRA出馬表 + デプロイ（月17:00）
#   --nar         : NAR結果 + NAR出馬表 + デプロイ（毎日 9:00）
#
# 設計方針:
#  - 個別バッチが1つ失敗しても後続は続行する（set -e にしない）。
#    NAR非開催、netkeibaの出馬表未公開といった「空振り」は日常的に起きるため。
#  - デプロイは最後に1回だけ。個別バッチには SKIP_DEPLOY=1 を渡す
#    （build_viewer_data.js は7万ファイルを走査するので複数回流すと無駄が大きい）。
#  - 多重起動を防ぐ。前回が長引いている最中に次が起動するとgitが競合する。
#    3モードで同じロックを共有する。
#  - caffeinate は plist ではなくここで呼ぶ。plist の ProgramArguments に
#    caffeinate を置くと実行主体が変わり、macOSのプライバシー保護で
#    ~/Documents にアクセスできなくなる（Operation not permitted）。
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

MODE="${1:-}"
case "$MODE" in
  --jra-shutuba|--jra-result|--nar) ;;
  *) echo "Usage: $0 --jra-shutuba | --jra-result | --nar"; exit 1 ;;
esac

LOCKDIR="/tmp/batch_daily.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "[$(date '+%F %T')] 前回の実行が継続中のためスキップ ($MODE)"
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# 実行中だけスリープを抑止する（自プロセス終了で caffeinate も終わる）
caffeinate -i -s -w $$ &

echo "=============================================="
echo " バッチ開始 $(date '+%F %T')  mode=$MODE"
echo "=============================================="

FAILED=""
run_step() {
  local label="$1"; shift
  echo ""
  echo "---------- $label ----------"
  if SKIP_DEPLOY=1 "$@"; then
    echo "[OK] $label"
  else
    echo "[NG] $label (exit=$?)"
    FAILED="$FAILED $label"
  fi
}

# --- JRA出馬表 ---
# 水曜はnetkeibaの無料プランだと出馬表が未確定で、取得すると劣化したデータで
# 上書きしてしまう。スケジュール上は水曜に起動しないが、手動実行の保険として残す
jra_shutuba() {
  if [ "$(date +%u)" = "3" ]; then
    echo ""
    echo "---------- JRA出馬表 ----------"
    echo "[SKIP] 水曜は出馬表が未確定のため実行しない"
    return
  fi
  run_step "JRA出馬表" ./batch_shutuba.sh
}

# --- JRA結果 ---
# 直近開催日のうち未処理のものだけ実行する。毎回流すと同じ日を --append し直して
# 「過去日は凍結」の方針を崩すため。JRAのrace_idは開催回/日目ベースで日付を持たないので、
# 生成済みビューアデータ(docs/data_YYYY.json)の日付フィールドで判定する
jra_result() {
  local last need
  last=$(node scripts/get_next_dates.js --last 2>/dev/null | tr '\n' ' ' | xargs || true)
  need=$(node -e "
    const fs=require('fs');
    const dates='$last'.split(/\s+/).filter(Boolean);
    const need=[];
    for(const d of dates){
      const f='docs/data_'+d.slice(0,4)+'.json';
      let done=false;
      if(fs.existsSync(f)) done=JSON.parse(fs.readFileSync(f,'utf-8')).some(r=>r[11]===d);
      if(!done) need.push(d);
    }
    console.log(need.join(' '));
  " 2>/dev/null || echo "")
  if [ -n "$need" ]; then
    run_step "JRA結果 ($need)" ./batch_result.sh $need
  else
    echo ""
    echo "---------- JRA結果 ----------"
    echo "[SKIP] 直近開催日 ($last) は処理済み"
  fi
}

# --- NAR ---
# 結果は前日分（ナイター開催が21時頃まであるため当日は翌朝に回す）、
# 出馬表は翌日・翌々日。出馬表は取得済みでも再取得する仕様で、
# 出走取消・騎手変更が反映されるので翌々日→翌日の二度取りに意味がある。
# 対象会場が土曜非開催のため日曜の結果取得は通常空振りだが、例外開催があるので起動はする。
nar() {
  local dates
  dates=$(node -e "
    const d=new Date();
    const fmt=t=>t.getFullYear()+String(t.getMonth()+1).padStart(2,'0')+String(t.getDate()).padStart(2,'0');
    const out=[];
    for(const i of [-1,1,2]) out.push(fmt(new Date(d.getTime()+i*86400000)));
    console.log(out.join(' '));
  ")
  run_step "NAR ($dates)" ./batch_nar.sh $dates
}

case "$MODE" in
  --jra-shutuba) jra_shutuba ;;
  --jra-result)  jra_result; jra_shutuba ;;
  --nar)         nar ;;
esac

# デプロイ（ここで初めて build_viewer_data.js とpushを実行）
echo ""
echo "---------- デプロイ ----------"
if ./deploy.sh; then
  echo "[OK] デプロイ"
else
  echo "[NG] デプロイ"
  FAILED="$FAILED デプロイ"
fi

echo ""
echo "=============================================="
if [ -n "$FAILED" ]; then
  echo " 完了（失敗あり):$FAILED  $(date '+%F %T')"
  exit 1
fi
echo " 完了 $(date '+%F %T')"
echo "=============================================="
