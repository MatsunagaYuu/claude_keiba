# 競走馬指数プロジェクト

JRAの競馬レースデータをスクレイピングし、独自の総合指数・能力指数を算出してビューアで閲覧するシステム。

## プロジェクト構成

```
├── scripts/              # 現行スクリプト（node scripts/xxx.js で実行）
│   ├── calc_index.js         # 指数算出（メイン）
│   ├── build_base_times.js   # 基準タイム生成 → base_times.json
│   ├── build_baba_diff_v2.js # 内製馬場差生成 → baba_diff.json（馬効果×日効果×レース効果のALS同時分解）
│   ├── build_baba_diff.js    # 旧内製馬場差（v1、未使用。v2に置換済み）
│   ├── build_viewer_data.js  # ビューアデータ生成 → docs/data_YYYY.json
│   ├── build_shutuba_data.js # 出馬表データ生成 → docs/shutuba_YYYYMMDD.json
│   ├── build_venue_calibration.js # 会場×路面×距離帯補正の推定 → venue_calibration.json
│   ├── verify_venue_calibration.js # 補正の検証（±120日窓・分割標本）
│   ├── horse_history.js      # 馬別過去走確認CLI
│   ├── scraper.js            # レース結果スクレイパー（puppeteer）
│   ├── scrape_calendar.js    # 開催カレンダー取得（netkeibaスクレイピング版・本採用）
│   ├── build_calendar_from_db.js # 開催カレンダー生成（DB版、DB廃止済みで非稼働・切り戻し用に温存）
│   ├── scrape_external_baba.js # 外部馬場差取得（ittai.net、切り戻し用に温存）
│   ├── scrape_result_by_date.js # 日付指定レース結果取得
│   ├── scrape_shutuba.js     # 出馬表取得
│   ├── get_next_dates.js     # 次回開催日取得
│   ├── nar_scraper.js        # NARレース結果スクレイパー（UTF-8/EUC-JP自動判別。NAR_ACTIVE_CODES で対象会場管理）
│   ├── scrape_nar_result_by_date.js # NAR日付指定一括取得（race_list駆動・対象会場のみ・非開催日は自動スキップ）
│   ├── build_nar_base_times.js # NAR基準タイム生成 → nar_base_times.json（会場×路面×距離・良馬場基準）
│   ├── build_nar_baba_diff.js  # NAR内製馬場差 → nar_baba_diff.json（ALS・日×会場×路面ノード・--append対応）
│   ├── calc_nar_index.js     # NAR指数算出 → nar_race_index/（総合指数のみ。会場間の絶対比較は未キャリブレーション）
│   ├── scrape_nar_shutuba.js # NAR出馬表取得（対象会場を日付一括）
│   ├── build_nar_shutuba_data.js # NAR出馬表Discord用（実験・非稼働）
│   └── old/                  # 分析・実験用（未使用）
├── docs/                 # GitHub Pages公開ディレクトリ
│   ├── index.html            # ビューアSPA（単一HTML）
│   ├── data_YYYY.json        # 年別レースデータ
│   ├── shutuba_YYYYMMDD.json # 日別出馬表データ
│   └── meta.json / shutuba_meta.json
├── race_result/          # スクレイピング済みレース結果CSV
├── race_index/           # 指数算出済みCSV（calc_index.js出力）
├── shutuba/              # スクレイピング済み出馬表CSV
├── nar_race_result/      # NAR（門別）レース結果CSV（git管理外）
├── nar_race_index/       # NAR指数算出済みCSV（git管理外）
├── nar_base_times.json   # NAR基準タイム（距離別）
├── nar_baba_diff.json    # NAR内製馬場差（ALS版・JRA baba_diff.json と同形式）
├── base_times.json       # 基準タイム（16クラス×会場×距離）
├── venue_calibration.json # 会場×路面×距離帯×期間の指数補正offset
├── baba_diff.json        # 内製馬場差（2014-、日×会場×路面＋レース別。本採用中）
├── external_baba_diff.json # 外部馬場差データ（ittai.net、切り戻し用に温存）
├── kaisai_calendar.json  # 開催カレンダー
├── batch_result.sh       # レース結果バッチ（結果取得→指数→デプロイ）
├── batch_shutuba.sh      # 出馬表バッチ（出馬表取得→デプロイ）
├── batch_nar.sh          # NARバッチ（結果+馬場差+指数+出馬表→デプロイ、1本で完結）
└── deploy.sh             # docs/をgit push（GitHub Pages）
```

## バッチ運用

```bash
# 出馬表更新（金曜）
./batch_shutuba.sh              # 次開催日を自動特定
./batch_shutuba.sh 20260307     # 日付指定

# レース結果更新（月曜）
./batch_result.sh               # 直近開催日を自動特定
./batch_result.sh 20260301      # 日付指定

# 内製馬場差（通常は batch_result.sh が自動で --append する）
node scripts/build_baba_diff_v2.js --race-effect --out baba_diff.json  # 全期間一括再構築
node scripts/build_baba_diff_v2.js --append 20260704 20260705          # 指定日のみ追記（過去凍結）
# 注意: 一括再構築後は進行中半期の日が0に潰れるため、直近開催日を --append で上書きすること

# 外部馬場差の更新（切り戻し時のみ）
node scripts/scrape_external_baba.js 2026

# 開催カレンダー更新（本採用：netkeibaスクレイピング版）
# 通常は batch_shutuba.sh が実行時に自動で当年を更新するため手動実行は不要
node scripts/scrape_calendar.js 2026            # 指定年のみ（推奨）
node scripts/scrape_calendar.js                 # 全期間（初回・大幅な再構築用）

# NAR更新フロー（手動）
# 対応会場: 門別・盛岡・水沢・浦和・船橋・大井・川崎（nar_scraper.js の NAR_ACTIVE_CODES で管理）
# 結果は2023/4以降を取得済み。日付を渡せば開催のある対象会場だけ自動で取得される
./batch_nar.sh 20260727 20260728 20260729  # 結果+馬場差+指数+出馬表→デプロイを1本で実行
# 結果が未取得の未来日（出馬表のみ公開）を混ぜても安全（馬場差・指数の更新は自動スキップ）

# 個別に叩きたい場合（batch_nar.shの中身）:
# 結果側:
node scripts/scrape_nar_result_by_date.js 20260714,20260715,20260716  # 結果取得
node scripts/build_nar_baba_diff.js --append 20260714 20260715 20260716  # 馬場差追記（過去凍結）
node scripts/calc_nar_index.js                  # 指数再計算（全件・数秒で完了）
node scripts/build_viewer_data.js --year 2026   # ビューアデータ更新（NAR各場も合流される）
./deploy.sh
# 出馬表側:
node scripts/scrape_nar_shutuba.js 20260714     # 出馬表取得（1日ずつ）
node scripts/build_shutuba_data.js --date 20260714 20260715  # JRA/NARとも同じ出力に合流
./deploy.sh
# 馬場差の全期間一括再構築（node scripts/build_nar_baba_diff.js）後は、JRA同様に
# 進行中半期の日が馬効果不足で歪むため、直近開催日を --append で上書きすること
```

## 指数計算の概要（calc_index.js）

- **キャリブレーション**: イクイノックス 2023天皇賞秋 = 336（factor=6.667, 2000m基準）
- **距離スケーリング**: `factor = 6.667 * (2000 / dist)`（線形）
- **16クラス区分**: 2歳新馬〜4歳以上OP（芝/ダート別にアンカー指数）
- **馬場差**: `--naisei` で内製 baba_diff.json 使用（本採用中、バッチは --naisei 付き）。フラグ無しで外部 external_baba_diff.json（切り戻し用）。内製版は「タイム偏差 ≈ 馬効果＋日効果＋レース効果」のALS同時分解で推定（指数を入力に使わないため指数のブレが伝播しない）。週次は `--append`（対象日から遡る180日窓）で追記し過去日は凍結
- **馬場差なし**: 参考値フラグ（参考=1）を付与
- **切り戻し手順**: batch_result.sh の内製馬場差ステップを外部取得に戻し、calc_index から --naisei を外し、venue_calibration.json をgit履歴の外部時代の版に戻してフル再計算
- **基準タイム**: base_times.json（年齢クラス×会場×距離、build_base_times.jsで生成）
- **BTフォールバック**: サンプル不足時に3歳以上/4歳以上の同グレードにフォールバック。アンカー指数もフォールバック先に合わせる
- **会場キャリブレーション**: venue_calibration.json の offset（会場×路面×距離帯×期間）を総合/能力指数から減算。同一馬±120日ペアのネットワーク最小二乗で推定（build_venue_calibration.js）。ファイル無し or `--no-calib` で無効（完全可逆）。再推定時は `--no-calib --outdir` で素の指数を作ってから行う

## データフロー

```
scraper.js → race_result/*.csv
  ↓
build_base_times.js → base_times.json
build_baba_diff_v2.js → baba_diff.json（内製馬場差）
  ↓
calc_index.js --naisei → race_index/*.csv（総合指数・上がり指数・能力指数）
  ↓
build_viewer_data.js → docs/data_YYYY.json
build_shutuba_data.js → docs/shutuba_YYYYMMDD.json
  ↓
deploy.sh → GitHub Pages
```

## 注意事項

- スクリプトはプロジェクトルートから `node scripts/xxx.js` で実行
- シェルスクリプト（batch_*.sh, deploy.sh）は `cd "$(dirname "$0")"` で自動的にプロジェクトルートに移動
- ビューアは単一HTMLファイル（docs/index.html）。外部ライブラリなし
- race_result/ と race_index/ はgit管理外（.gitignore）
- external_baba_diff.json は ittai.net からスクレイピング（切り戻し用に温存、更新停止）
- baba_diff.json は内製馬場差（2026-07-08本採用）。過去日は凍結、週次バッチが --append で追記
- GitHub Actionsは全て廃止（スケジュール無効化済み・手動dispatchのみ残置）。バッチは全てローカル運用に一本化
  - batch_result.yml: race_result/ がgit管理外のためActions上では基準タイム・馬場差を正しく計算できない → ローカル ./batch_result.sh で運用
  - batch_shutuba.yml: Actionsスケジュールとローカル ./batch_shutuba.sh が両方 main に push すると実行タイミングが重なり競合する（2026-07-09に発生）→ ローカル ./batch_shutuba.sh で運用

## 開発ルール

- プログラム修正前に変更点をユーザーに報告し、承認を得ること
- プログラム修正は必ず全体のコードを読んでから行うこと