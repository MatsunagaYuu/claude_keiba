#!/bin/bash
# 日次バッチ: JRA結果 → JRA出馬表 → NAR（結果+出馬表）→ デプロイ
# launchd から無人実行される想定。
#
# Usage: ./batch_daily.sh [--shutuba]
#   引数なし  : 全工程（JRA結果 + JRA出馬表 + NAR + デプロイ）
#   --shutuba : JRA出馬表とデプロイのみ（金土の追加実行用）
#
# 設計方針:
#  - 個別バッチが1つ失敗しても後続は続行する（set -e にしない）。
#    NARが非開催、netkeibaが出馬表未公開、といった「空振り」は日常的に起きるため。
#  - デプロイは最後に1回だけ。個別バッチには SKIP_DEPLOY=1 を渡す
#    （build_viewer_data.js は7万ファイルを走査するので3回流すと無駄が大きい）。
#  - 多重起動を防ぐ。前回が長引いている最中に次が起動するとgitが競合する。
#  - caffeinate は plist ではなくここで呼ぶ。plist の ProgramArguments に
#    caffeinate を置くと実行主体が変わり、macOSのプライバシー保護で
#    ~/Documents にアクセスできなくなる（Operation not permitted）。
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

MODE="${1:-full}"

LOCKDIR="/tmp/batch_daily.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "[$(date '+%F %T')] 前回の実行が継続中のためスキップ"
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# 実行中だけスリープを抑止する（自プロセス終了で caffeinate も終わる）
caffeinate -i -s -w $$ &

echo "=============================================="
echo " 日次バッチ開始 $(date '+%F %T') mode=$MODE"
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

# JRA出馬表の実行可否。水曜はnetkeibaの無料プランだと出馬表が未確定で、
# 取得すると劣化したデータ（枠順・騎手なし等）で上書きしてしまうため実行しない
DOW=$(date +%u)   # 1=月 ... 7=日
run_jra_shutuba() {
  if [ "$DOW" = "3" ]; then
    echo ""
    echo "---------- JRA出馬表 ----------"
    echo "[SKIP] 水曜は出馬表が未確定のため実行しない"
    return
  fi
  run_step "JRA出馬表" ./batch_shutuba.sh
}

# --shutuba: JRA出馬表とデプロイだけ実行して終了（金土の追加実行用）
if [ "$MODE" = "--shutuba" ]; then
  run_jra_shutuba
  echo ""
  echo "---------- デプロイ ----------"
  if ./deploy.sh; then echo "[OK] デプロイ"; else echo "[NG] デプロイ"; FAILED="$FAILED デプロイ"; fi
  echo ""
  echo "=============================================="
  if [ -n "$FAILED" ]; then echo " 完了（失敗あり):$FAILED  $(date '+%F %T')"; exit 1; fi
  echo " 完了 $(date '+%F %T')"
  echo "=============================================="
  exit 0
fi

# 1. JRA結果。get_next_dates.js --last が返す直近開催日を処理する。
#    未処理の日がある時だけ実行する（毎日流すと同じ日を --append し直して
#    「過去日は凍結」の方針を崩すため）
LAST_DATES=$(node scripts/get_next_dates.js --last 2>/dev/null | tr '\n' ' ' | xargs || true)
# JRAのrace_idは開催回/日目ベースで日付を含まないため、生成済みビューアデータ
# (docs/data_YYYY.json の日付フィールド) で処理済みか判定する
NEED_RESULT=$(node -e "
  const fs=require('fs');
  const dates='$LAST_DATES'.split(/\s+/).filter(Boolean);
  const need=[];
  for(const d of dates){
    const f='docs/data_'+d.slice(0,4)+'.json';
    let done=false;
    if(fs.existsSync(f)) done=JSON.parse(fs.readFileSync(f,'utf-8')).some(r=>r[11]===d);
    if(!done) need.push(d);
  }
  console.log(need.join(' '));
" 2>/dev/null || echo "")
if [ -n "$NEED_RESULT" ]; then
  run_step "JRA結果 ($NEED_RESULT)" ./batch_result.sh $NEED_RESULT
else
  echo ""
  echo "---------- JRA結果 ----------"
  echo "[SKIP] 直近開催日 ($LAST_DATES) は処理済み"
fi

# 2. JRA出馬表（水曜はスキップ）
run_jra_shutuba

# 3. NAR。結果は数日前まで、出馬表は数日先まで見る。
#    非開催日・結果未確定日は batch_nar.sh 側で自動スキップされる
NAR_DATES=$(node -e "
  const d=new Date();
  const out=[];
  for(let i=-3;i<=3;i++){
    const t=new Date(d.getTime()+i*86400000);
    out.push(t.getFullYear()+String(t.getMonth()+1).padStart(2,'0')+String(t.getDate()).padStart(2,'0'));
  }
  console.log(out.join(' '));
")
run_step "NAR ($NAR_DATES)" ./batch_nar.sh $NAR_DATES

# 4. デプロイ（ここで初めて build_viewer_data.js とpushを実行）
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
