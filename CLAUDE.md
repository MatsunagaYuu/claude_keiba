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
│   ├── build_calendar_from_db.js # 開催カレンダー生成（DB版、推奨）
│   ├── scrape_calendar.js    # 開催カレンダー取得（スクレイピング版、非推奨）
│   ├── scrape_external_baba.js # 外部馬場差取得（ittai.net、切り戻し用に温存）
│   ├── scrape_result_by_date.js # 日付指定レース結果取得
│   ├── scrape_shutuba.js     # 出馬表取得
│   ├── get_next_dates.js     # 次回開催日取得
│   └── old/                  # 分析・実験用（未使用）
├── docs/                 # GitHub Pages公開ディレクトリ
│   ├── index.html            # ビューアSPA（単一HTML）
│   ├── data_YYYY.json        # 年別レースデータ
│   ├── shutuba_YYYYMMDD.json # 日別出馬表データ
│   └── meta.json / shutuba_meta.json
├── race_result/          # スクレイピング済みレース結果CSV
├── race_index/           # 指数算出済みCSV（calc_index.js出力）
├── shutuba/              # スクレイピング済み出馬表CSV
├── base_times.json       # 基準タイム（16クラス×会場×距離）
├── venue_calibration.json # 会場×路面×距離帯×期間の指数補正offset
├── baba_diff.json        # 内製馬場差（2014-、日×会場×路面＋レース別。本採用中）
├── external_baba_diff.json # 外部馬場差データ（ittai.net、切り戻し用に温存）
├── kaisai_calendar.json  # 開催カレンダー
├── batch_result.sh       # レース結果バッチ（結果取得→指数→デプロイ）
├── batch_shutuba.sh      # 出馬表バッチ（出馬表取得→デプロイ）
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

# 開催カレンダー更新（DB版、スクレイピング不要）
node scripts/build_calendar_from_db.js          # 全期間
node scripts/build_calendar_from_db.js 2026     # 指定年のみ
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
- 結果バッチのGitHub Actions（batch_result.yml）はスケジュール無効化済み。race_result/ がgit管理外のためActions上では基準タイム・馬場差を正しく計算できない。結果バッチはローカル ./batch_result.sh で運用

## 開発ルール

- プログラム修正前に変更点をユーザーに報告し、承認を得ること
- プログラム修正は必ず全体のコードを読んでから行うこと