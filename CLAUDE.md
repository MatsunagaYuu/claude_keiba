# 競走馬指数プロジェクト

JRAの競馬レースデータをスクレイピングし、独自の総合指数・能力指数を算出してビューアで閲覧するシステム。

## プロジェクト構成

```
├── scripts/              # 現行スクリプト（node scripts/xxx.js で実行）
│   ├── calc_index.js         # 指数算出（メイン）
│   ├── build_base_times.js   # 基準タイム生成 → base_times.json
│   ├── build_baba_diff.js    # 馬場差生成 → baba_diff.json（現在未使用、外部馬場差に移行）
│   ├── build_viewer_data.js  # ビューアデータ生成 → docs/data_YYYY.json
│   ├── build_shutuba_data.js # 出馬表データ生成 → docs/shutuba_YYYYMMDD.json
│   ├── horse_history.js      # 馬別過去走確認CLI
│   ├── scraper.js            # レース結果スクレイパー（puppeteer）
│   ├── scrape_calendar.js    # 開催カレンダー取得
│   ├── scrape_external_baba.js # 外部馬場差取得（ittai.net）
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
├── external_baba_diff.json # 外部馬場差データ（ittai.net、2018-2026）
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

# 外部馬場差の更新（必要時）
node scripts/scrape_external_baba.js 2026
```

## 指数計算の概要（calc_index.js）

- **キャリブレーション**: イクイノックス 2023天皇賞秋 = 336（factor=6.667, 2000m基準）
- **距離スケーリング**: `factor = 6.667 * (2000 / dist)`（線形）
- **16クラス区分**: 2歳新馬〜4歳以上OP（芝/ダート別にアンカー指数）
- **外部馬場差**: external_baba_diff.json使用（USE_EXT_BABA=true）
- **馬場差なし**: 参考値フラグ（参考=1）を付与
- **基準タイム**: base_times.json（年齢クラス×会場×距離、build_base_times.jsで生成）
- **BTフォールバック**: サンプル不足時に3歳以上/4歳以上の同グレードにフォールバック。アンカー指数もフォールバック先に合わせる

## データフロー

```
scraper.js → race_result/*.csv
  ↓
build_base_times.js → base_times.json
  ↓
calc_index.js → race_index/*.csv（総合指数・上がり指数・能力指数）
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
- external_baba_diff.json は ittai.net からスクレイピング。2018-2026年分取得済み
- baba_diff.json（自前馬場差）は現在空。外部データ排除時に自前導出予定
