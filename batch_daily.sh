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
# 生成済みビューアデータ(docs/data_YYYY.json)の日付フィールドで判定する。
#
# 判定は「日付」ではなく「予定された各会場のレースが取り込めているか」を数で見る。
#
# 経緯1: data_YYYY.json はNARの結果も同じ日付フィールドで合流してくるので、日付の有無だけで
#   見ると、前日分を毎朝取り込む keiba-nar のせいでJRA結果が丸ごとスキップされる
#   （2026-08-15/16 で発生。土曜にNAR開催があると必ず踏む）→ 会場単位に変更した。
# 経緯2: 会場が1つでも取り込めていれば「処理済み」と見なしていたため、
#   36レース中8レースしか無い状態を検出できなかった（2026-09-05/06。netkeibaが
#   クラスを全角表記に変えて指数算出が大半を取りこぼした）→ レース数まで見るようにした。
#
# 期待レース数は取得済みの race_result/ の本数から出す。指数化されないレース
# （障害競走）は差し引く。まだ取得していない日は race_result が無いので当然「要処理」。
# なお開催中止で結果が永遠に来ない日は毎回対象になるが、--last は直近の週末グループしか
# 返さないので次の開催で自然に対象外になる。
jra_result() {
  local last need
  last=$(node scripts/get_next_dates.js --last 2>/dev/null | tr '\n' ' ' | xargs || true)
  need=$(node -e "
    const fs=require('fs');
    const VC={札幌:'01',函館:'02',福島:'03',新潟:'04',東京:'05',中山:'06',中京:'07',京都:'08',阪神:'09',小倉:'10'};
    const p2=n=>String(n).padStart(2,'0');
    const dates='$last'.split(/\s+/).filter(Boolean);
    const cal=JSON.parse(fs.readFileSync('kaisai_calendar.json','utf-8'));
    const planned={};
    for(const e of cal) planned[e.date]=e.venues;
    const need=[];
    for(const d of dates){
      const f='docs/data_'+d.slice(0,4)+'.json';
      const have={};
      if(fs.existsSync(f)){
        for(const r of JSON.parse(fs.readFileSync(f,'utf-8'))) if(r[11]===d) have[r[2]]=(have[r[2]]||0)+1;
      }
      const want=planned[d]||[];
      if(!want.length){ if(!Object.keys(have).length) need.push(d); continue; }
      let short=false;
      for(const v of want){
        const code=VC[v.venue];
        if(!code){ if(!have[v.venue]) short=true; continue; }
        // 取得済みの結果CSVのうち、指数対象（障害を除く）の本数を期待値とする
        let expect=0;
        for(let r=1;r<=12;r++){
          const rf='race_result/result_'+d.slice(0,4)+code+p2(v.kaisai)+p2(v.day)+p2(r)+'.csv';
          if(!fs.existsSync(rf)) continue;
          const head=fs.readFileSync(rf,'utf-8').split('\n').slice(0,2).join('\n');
          if(!head.includes('障害')) expect++;
        }
        if(expect===0){ short=true; continue; }      // 未取得
        if((have[v.venue]||0) < expect) short=true;  // 取り込み漏れ
      }
      if(short) need.push(d);
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
