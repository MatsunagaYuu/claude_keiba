# 競馬指数計算システム 仕様書

## 処理パイプライン

```
[scraper.js] + [runner.js]    レース結果スクレイピング
       |
  race_result/*.csv
       |
[build_base_times.js]          基準タイム生成（芝+ダート）
       |
  base_times.json
       |
[build_baba_diff.js]           内製馬場差算出（芝+ダート、レース別）
       |
  baba_diff.json               ← external_baba_diff.json と同形式
       |
[calc_index.js]                指数算出（芝+ダート）
  ├─ 通常: external_baba_diff.json（外部馬場差）使用 → race_index/*.csv
  └─ --naisei: baba_diff.json（内製馬場差）使用 → race_index_naisei/*.csv
       |
[build_viewer_data.js]         ビューアデータ生成
       |
  docs/data_YYYY.json + meta.json

[scrape_shutuba.js]            出馬表スクレイピング
       |
  shutuba/*.json
       |
[build_shutuba_data.js]        出馬表ビューアデータ生成
       |
  docs/shutuba_YYYYMMDD.json + shutuba_meta.json

[scrape_calendar.js]           開催カレンダー取得
       |
  kaisai_calendar.json

[compare_baba_diff.js]         内製 vs 外部 馬場差比較レポート
[compare_index.js]             内製 vs 外部 指数比較レポート
```

---

## 1. scraper.js — レース結果スクレイピング

### 概要
db.netkeiba.com からレース結果を取得し、CSVに出力する。

### 入出力
- **入力**: `https://db.netkeiba.com/race/{raceId}/` (EUC-JP)
- **出力**: `./race_result/result_{raceId}.csv`

### 取得データ
- レース情報: 競馬場名, 開催, 開催日, クラス, 芝/ダート, 距離, 天候, 馬場
- 馬情報: 着順, 枠番, 馬番, 馬名, 性齢, 斤量, 騎手, タイム, 着差, 通過, 上がり, 人気, 単勝オッズ

### 使い方
```bash
node scraper.js 202305040911
```

---

## 2. runner.js — スクレイピングループ実行

### 概要
指定した年・競馬場の全レースを順次スクレイピングする。

### 定数
- `DELAY_MS = 2000` — リクエスト間隔（2秒）

### 競馬場コード
| コード | 競馬場 | コード | 競馬場 |
|--------|--------|--------|--------|
| 01 | 札幌 | 06 | 中山 |
| 02 | 函館 | 07 | 中京 |
| 03 | 福島 | 08 | 京都 |
| 04 | 新潟 | 09 | 阪神 |
| 05 | 東京 | 10 | 小倉 |

### レースID体系
```
YYYYVVKKDDNN
YYYY = 年, VV = 競馬場コード, KK = 開催(01-06), DD = 日次(01-12), NN = R番号(01-12)
```

### 使い方
```bash
node runner.js 2026 05              # 2026年東京 全開催
node runner.js 2026 05 1 1          # 2026年東京 第1回のみ
node runner.js 2026 05 1 1 4 4      # 2026年東京 第1回4日目のみ
```

---

## 3. build_base_times.js — 基準タイム生成

### 概要
全レース結果から**良馬場**のデータのみを抽出し、(芝/ダート, 競馬場, 距離, クラス)ごとの基準タイムを算出する。

### 入出力
- **入力**: `./race_result/*.csv`
- **出力**: `./base_times.json`

### フィルタ条件
- **芝+ダート両方を処理**（`TARGET_SURFACES = ["芝", "ダート"]`）
- 良馬場のみ
- 障害レースは除外

### クラス分類
| レース条件 | カテゴリ | 基準指数 |
|------------|----------|----------|
| 新馬, 未勝利 | 未勝利 | 280 |
| 1勝, 500万下 | 1勝クラス | 300 |
| 2勝, 1000万下 | 2勝クラス | 305 |
| 3勝, 1600万下 | 3勝クラス | 310 |
| オープン, G1-G3, リステッド | OP | 315 |

### 算出値
各(芝/ダート, 競馬場, 距離, クラス)について:
- **基準走破秒** = 良馬場の全完走馬の走破タイム **上下10%カット平均**（trimmed mean）
- **基準前半秒** = 良馬場の全完走馬の前半タイム **上下10%カット平均**
- **基準上がり秒** = 良馬場の全完走馬の上がり3Fタイム **上下10%カット平均**

走破タイムの分布は正方向に歪む（大敗馬の遅いタイムが平均を押し上げる、全コースでskewness > 0.5）。
上下10%カット平均により外れ値の影響を緩和する（TRIM_RATE = 0.10）。
- **回帰スロープ** = (芝/ダート, 競馬場, 距離)単位の前半-上がり回帰係数
- **上がり標準偏差** = (芝/ダート, 競馬場, 距離)単位の上がりタイムの標準偏差（コース特性補正に使用）

### CLASS_BASE_INDEX
基準指数は参考値として出力に残すが、calc_index.jsでは使用しない（OP=315アンカーに統一）。

### 回帰スロープの計算
```
slope = Σ((前半_i - 前半平均) × (上がり_i - 上がり平均)) / Σ((前半_i - 前半平均)²)
```
前半が速いほど上がりが遅くなる関係をモデル化（最小二乗法）。

### 出力キー体系
```
${surface}_${venue}_${dist}_${category}
例: 芝_東京_2000_OP, ダート_中山_1800_1勝クラス
```

---

## 4. build_baba_diff.js — 内製馬場差算出

### 概要
全レース結果と自前base_times.jsonを比較し、**レース単位の馬場差を算出**した上で日単位に集約する。
出力形式はexternal_baba_diff.jsonと互換であり、calc_index.jsの馬場差読み込みロジックをそのまま利用可能。

### 入出力
- **入力**: `./race_result/*.csv`, `./base_times.json`, `./kaisai_calendar.json`
- **出力**: `./baba_diff.json`

### クラス分類（16区分、calc_index.jsと同一）
calc_index.jsの`classifyRace()`と同一ロジックを使用。
```
2歳新馬, 2歳未勝利, 2歳1勝, 2歳OP
3歳新馬, 3歳未勝利, 3歳1勝, 3歳OP
3歳以上1勝, 3歳以上2勝, 3歳以上3勝, 3歳以上OP
4歳以上1勝, 4歳以上2勝, 4歳以上3勝, 4歳以上OP
```

### 基準タイム取得（フォールバック付き、calc_index.jsと同一）
1. 直接マッチ（サンプル数≥20）
2. 同等級の古馬クラス（3歳以上/4歳以上）にフォールバック
3. サンプル不足でもデータがあればそのまま使用

### 処理
1. レースごとに各完走馬の偏差を算出:
   ```
   weightAdj = (斤量 - 57) × 0.2 × (距離 / 2000)
   adjSec = 実走破秒 - weightAdj
   rawDev = adjSec - 基準走破秒
   normDev = rawDev × (2000 / 距離)   ← 2000m換算
   ```
2. レース馬場差 = **トリム平均**（上下10%除外、n≥3頭）:
   ```
   raceBabaDiff = trimmedMean(normDev[], 10%)   ← 大敗馬の影響を除去
   ```
3. 距離補正済みレース馬場差（レース別馬場差用）:
   ```
   distCorrectedDiff = raceBabaDiff × (距離 / 2000)
   ```
4. 日ごとに集約:
   ```
   芝馬場差 = mean(芝レースのraceBabaDiff[])         ← 2000m基準
   ダート馬場差 = mean(ダートレースのraceBabaDiff[]) × (基準距離 / 2000)  ← 会場別基準距離ベース
   ```

### ダート基準距離（会場別、calc_index.jsと同一）
| 会場 | 基準距離 | その他 |
|------|---------|--------|
| 東京 | 1600m | 1800m |
| 札幌, 函館, 小倉 | 1700m | |

### 出力形式（external_baba_diff.json互換）
```json
{
  "年": 2026,
  "競馬場": "中山",
  "日付": "2026/01/11",
  "芝馬場差": -0.8,
  "ダート馬場差": 0.1,
  "レース別馬場差": {
    "1": -0.3, "2": -0.9, "5": 0.2, ...
  }
}
```
- `芝馬場差`: 2000m基準の日平均（calc_index.jsが `× (dist / 2000)` で距離補正）
- `ダート馬場差`: 会場別基準距離ベース（calc_index.jsが `× (dist / baseDist)` で距離補正）
- `レース別馬場差`: 距離補正済み（calc_index.jsがそのまま使用）

### 馬場差の解釈
- **負の値** = 速い馬場（基準より速いタイムが出やすい）
- **正の値** = 遅い馬場（基準より遅いタイムが出やすい）

### 使い方
```bash
node build_baba_diff.js
```

---

## 5. calc_index.js — 指数算出

### 概要
基準タイムと馬場差を用いて、各馬に**総合指数**・**上がり指数**・**能力指数**の3種類の指数を付与する。**芝・ダート両方**を処理。

### 入出力
- **入力**: `./race_result/*.csv`, `./base_times.json`, `./external_baba_diff.json`（通常）or `./baba_diff.json`（`--naisei`時）, `./kaisai_calendar.json`
- **出力**: `./race_index/index_{raceId}.csv`（通常）or `./race_index_naisei/index_{raceId}.csv`（`--naisei`時）

### `--naisei` モード
内製馬場差（baba_diff.json）を使用して指数を算出し、`race_index_naisei/` に出力する。
外部馬場差との比較検証用。baba_diff.jsonはexternal_baba_diff.jsonと同形式なので、
馬場差読み込み・適用ロジックは共通。

### 定数

| 定数 | 値 | 導出 |
|------|-----|------|
| CALIBRATION_FACTOR | 6.667 | イクイノックス2023天皇賞秋キャリブレーション |
| CALIBRATION_DIST | 2000 | 基準距離 |
| CLASS_ANCHOR_TURF | 2歳新馬:283 〜 4歳以上OP:315 | 16区分別アンカー指数（芝） |
| CLASS_ANCHOR_DIRT | 2歳新馬:272 〜 4歳以上OP:316 | 16区分別アンカー指数（ダート） |
| MIN_BT_SAMPLES | 20 | 基準タイムの最低サンプル数 |
| BASE_WEIGHT | 57 | 古馬定量 |
| WEIGHT_FACTOR | 0.2 | 業界通説(1kg=0.2秒/2000m) |
| DRAFT_FACTOR | 0.6 | 経験的設定 |
| 絶対評価比率 | 0.5 | 設計判断 |

### 16クラス分類
```
2歳新馬, 2歳未勝利, 2歳1勝, 2歳OP
3歳新馬, 3歳未勝利, 3歳1勝, 3歳OP
3歳以上1勝, 3歳以上2勝, 3歳以上3勝, 3歳以上OP
4歳以上1勝, 4歳以上2勝, 4歳以上3勝, 4歳以上OP
```

### 基準タイム取得（フォールバック付き）
1. 直接マッチ（サンプル数≥20）
2. 同等級の古馬クラス（3歳以上/4歳以上）にフォールバック
3. サンプル不足でもデータがあればそのまま使用
フォールバック時はアンカー指数もフォールバック先クラスに合わせる（BT-アンカー整合性）。

### スケーリング
```
factor = CALIBRATION_FACTOR × (2000 / 距離) = 6.667 × (2000 / dist)
指数 = アンカー指数 + タイム差 × factor
```
イクイノックス2023天皇賞秋（1:55.2, 東京芝2000m 3歳以上OP, 馬場差-2.1秒, 58kg）= 指数336 にキャリブレーション。

### 5.1 総合指数
走破タイムと斤量から算出する指数。
```
基準タイム = getBaseTimes()で取得（16クラス分類、フォールバックあり）
アンカー指数 = getClassAnchor(surface, matchedClass)  ← フォールバック先に合わせる

馬場差の適用:
  レース別馬場差 > ダート距離別馬場差 > 全体馬場差(距離補正) の優先順で取得
  芝: 芝馬場差 × (dist / 2000)
  ダート: ダート馬場差 × (dist / baseDist)   ← baseDist=会場別基準距離

補正基準タイム = 基準走破秒 + 馬場差
斤量補正 = (斤量 - 57) × 0.2 × (距離 / 2000)
タイム差 = 補正基準タイム - 実走破秒 + 斤量補正
factor = 6.667 × (2000 / 距離)

総合指数 = round(アンカー指数 + タイム差 × factor)
```

### 5.2 上がり指数
絶対評価30% + 相対評価70%のブレンド。コース特性補正を適用。秒単位で算出し、能力指数で合算後に線形変換。

**相対評価（ペース・脚溜め考慮）:**
```
アンカー基準の前半/上がりを使用:
  補正前半基準 = アンカー基準前半秒 + 馬場差 × 0.6
  補正上がり基準 = アンカー基準上がり秒 + 馬場差 × 0.4

前半差 = 実前半秒 - 補正前半基準
期待上がり = 補正上がり基準 + slope × 前半差

先頭前半 = レース内の最速前半タイム
ポジション差 = 実前半秒 - 先頭前半
脚溜めペナルティ = ポジション差 × 0.6
補正上がり = 実上がり秒 + 脚溜めペナルティ

相対評価(秒) = 期待上がり - 補正上がり
```

**絶対評価（上がりタイムそのものの価値）:**
```
絶対評価(秒) = 補正上がり基準 - 実上がり秒
```
超スロー追い込みで32秒台を出した馬: 相対評価は低いが、絶対評価で一定のプラスが得られる。

**コース特性補正:**
上がりの標準偏差が小さいコース = 差がつきにくい = コースが厳しい → 同じ上がり差をより高く評価。
```
全コース平均stddev = 全エントリの上がり標準偏差の平均
courseFactor = 全コース平均stddev / 当該コースのstddev
  中山2000芝 stddev小 → courseFactor > 1.0 → 上がり指数増幅
  東京2000芝 stddev大 → courseFactor < 1.0 → 上がり指数減衰
```

**ブレンド（実距離の秒差）:**
```
上がり生値(秒) = (絶対評価 × 0.5 + 相対評価 × 0.5) × courseFactor
```

**上がり指数の表示値:**
能力指数と総合指数の差分として定義。正なら「走破タイム以上に末脚で加点」、負なら「走破タイム以上に末脚で減点」。

### 5.3 能力指数
秒差ベースで合算してからスケール。上がり重みは芝/ダート×距離×等級で動的に決定。
```
agariWeight = getAgariWeight(surface, dist, ageClass)
  芝: 1200m=0.20 → 1800m=0.70 → 2400m+=0.80（距離テーブル）
  ダート: 芝の0.7倍
  等級補正: OP=-0.10, 3勝=-0.05, 2勝=0, 1勝=+0.05, 新馬未勝利=+0.05

合算秒差 = タイム差 + 上がり生値 × agariWeight
能力指数 = round(アンカー指数 + 合算秒差 × factor)

上がり指数(表示) = 能力指数 - 総合指数
```

### 使い方
```bash
node calc_index.js                    # 全レース処理（外部馬場差）
node calc_index.js 202305040911       # 特定レースのみ
node calc_index.js --naisei           # 全レース処理（内製馬場差 → race_index_naisei/）
```

---

## 6. build_viewer_data.js — ビューアデータ生成

### 概要
race_indexのCSVを年ごとのJSONに変換し、GitHub Pagesビューア用データを生成する。

### 入出力
- **入力**: `./race_index/index_*.csv`, `./kaisai_calendar.json`, `./external_baba_diff.json`
- **出力**: `./docs/data_{year}.json`, `./docs/meta.json`

### データ形式
配列形式でキー名を省略し、ファイルサイズを削減。
```
Race: [raceId, year, venue, kaisai, day, class, surface, dist, weather, condition, horses[], date, raceNum, babaSpeed]
Horse: [rank, gate, num, name, age, weight, jockey, time, margin, passing, last3f, pop, odds, totalIdx, last3fIdx, abilityIdx]
```

### 馬場速度の取得
external_baba_diff.jsonから芝/ダート別に馬場速度を取得:
```
key = ${surface}_${日付}_${競馬場}
```
レース別馬場差 > ダート距離別馬場差 > 全体馬場差(距離補正) の優先順で表示。

### 使い方
```bash
node build_viewer_data.js
```

---

## 7. scrape_shutuba.js — 出馬表スクレイピング

### 概要
netkeiba.comの出馬表ページからレース出走馬データを取得し、JSONに出力する。

### 入出力
- **入力**: `https://race.netkeiba.com/top/race_list.html?kaisai_date=YYYYMMDD`（レース一覧）、`https://race.netkeiba.com/shutuba.html?race_id=XXXX`（個別出馬表）
- **出力**: `./shutuba/shutuba_YYYYMMDD.json`

### 取得データ
- レース情報: raceId, raceName, venue, raceNum, courseType, distance, condition
- 馬情報: number(馬番), gate(枠番), name(馬名), jockey(騎手), weight(斤量), odds, popularity

### 枠番・馬番の取得
netkeiba HTMLは枠番にクラス名 `Waku1`, `Waku2` ... を使用するため、属性セレクタで取得:
```
td[class*='Waku']   → 枠番
td[class*='Umaban'] → 馬番
```

### 使い方
```bash
node scrape_shutuba.js 20260222
```

---

## 8. build_shutuba_data.js — 出馬表ビューアデータ生成

### 概要
出馬表JSONとrace_indexデータを統合し、各馬の過去5走の指数履歴を付加したビューアデータを生成する。

### 入出力
- **入力**: `./shutuba/shutuba_YYYYMMDD.json`, `./race_index/index_*.csv`
- **出力**: `./docs/shutuba_YYYYMMDD.json`, `./docs/shutuba_meta.json`

### データ形式
配列形式でキー名を省略し、ファイルサイズを削減。
```
ShutubaRace: [raceId, venue, raceNum, raceName, courseType, distance, condition, horses[]]
ShutubaHorse: [number, gate, name, jockey, weight, odds, popularity, pastRaces[]]
PastRace: [raceId, date, venue, dist, surface, class, rank, totalIdx, abilityIdx]
```

### 使い方
```bash
node build_shutuba_data.js
```

---

## 9. scrape_calendar.js — 開催カレンダー取得

### 概要
JRAの開催カレンダーから、日付と開催情報（競馬場・回・日次）の対応マップを生成する。

### 入出力
- **入力**: `https://race.netkeiba.com/top/calendar.html`
- **出力**: `./kaisai_calendar.json`

### 用途
build_viewer_data.jsが日付逆引き（開催+日次 → YYYYMMDD）に使用する。

---

## 10. scrape_baba.js — JRA馬場状態PDF取得

### 概要
JRA公式サイトの馬場状態PDFからクッション値・含水率を取得する。
分析の結果、クッション値/含水率は走破タイムとの相関が低く(R²=1.3%)、指数計算には使用していない。

### 入出力
- **入力**: `https://jra.jp/keiba/baba/archive/{year}pdf/{venue}{kai}.pdf`
- **出力**: `./baba_data.json`

### 使い方
```bash
node scrape_baba.js              # 2019-2025
node scrape_baba.js 2023 2024    # 年範囲指定
```

---

## 11. deploy.sh — デプロイスクリプト

### 概要
ビューアデータをビルドし、GitHub Pagesにデプロイする。

### 処理内容
```bash
node build_baba_diff.js        # 馬場差更新
node build_viewer_data.js      # 結果データ更新
node build_shutuba_data.js     # 出馬表データ更新
cp base_times.json docs/       # 基準タイムコピー
git add docs/ && git commit && git push
```

---

## 12. ビューアサイト (docs/index.html)

### 概要
GitHub Pages上で動作するSPA。全データをJSONで取得しクライアント側で描画する。

### タブ構成
1. **結果** — レース結果と指数の一覧・詳細表示
2. **出馬表** — 出馬表の閲覧（日付→競馬場→R番号のメニュー形式）
3. **基準タイム** — 基準タイム一覧（芝/ダート切替・競馬場フィルタ）

### 結果タブ
- 年・競馬場・芝ダート・クラスでフィルタ
- レースカードをクリックで詳細展開（馬名クリックで馬詳細画面）
- 馬詳細画面: 過去走一覧・指数推移チャート・日付リンクからレース詳細に遷移

### 出馬表タブ
- 日付セレクタで日付選択
- 競馬場ごとにR番号ボタンをグリッド表示（クラス名サブテキスト付き）
- R番号タップで出走馬テーブル表示（過去5走の能力指数ミニバーチャート付き）

### 基準タイムタブ
- 芝/ダート切替トグルボタン
- 競馬場フィルタセレクタ
- テーブル: 競馬場, 距離, クラス, 基準指数, 基準走破, 基準前半, 基準上がり, サンプル数

### データ取得
- `docs/meta.json` → 年リスト
- `docs/data_{year}.json` → 年ごとのレースデータ
- `docs/shutuba_meta.json` → 出馬表日付リスト
- `docs/shutuba_YYYYMMDD.json` → 日付ごとの出馬表データ
- `docs/base_times.json` → 基準タイムデータ

---

## 13. 指数の読み方

### 目安
| 指数帯 | レベル |
|--------|--------|
| 345+ | G1級 |
| 330-344 | 重賞級 |
| 315-329 | OP級 |
| 300-314 | 条件戦上位（2勝〜3勝） |
| 285-299 | 条件戦（1勝） |
| 260-284 | 未勝利 |

### 3種類の指数の違い
- **総合指数**: 純粋なタイム評価。着順と完全に一致。
- **上がり指数**: 末脚の質。正なら「ペース・位置取り以上に速い上がり」。
- **能力指数**: 総合評価。着順と逆転可能（「負けて強し」を検出）。

---

## 14. 依存パッケージ
| パッケージ | 用途 |
|------------|------|
| cheerio | HTMLパース（scraper.js, scrape_shutuba.js） |
| pdfjs-dist@3.11.174 | PDFテキスト抽出（scrape_baba.js） |

---

## 15. compare_baba_diff.js — 馬場差比較レポート

### 概要
内製馬場差（baba_diff.json）と外部馬場差（external_baba_diff.json）を比較し、相関係数・RMSE・差の分布等を出力する。

### 入出力
- **入力**: `./baba_diff.json`, `./external_baba_diff.json`
- **出力**: 標準出力（芝/ダート別・レース別の統計レポート）

### 使い方
```bash
node compare_baba_diff.js
```

---

## 16. compare_index.js — 指数比較レポート

### 概要
外部馬場差指数（race_index/）と内製馬場差指数（race_index_naisei/）を馬単位で比較し、差の分布を出力する。

### 入出力
- **入力**: `./race_index/index_*.csv`, `./race_index_naisei/index_*.csv`
- **出力**: 標準出力（総合指数・上がり指数・能力指数の差分統計）

### 使い方
```bash
node compare_index.js
```

---

## 17. データ規模（2026年3月時点）
| 項目 | 件数 |
|------|------|
| レース結果CSV | 27,729件 |
| 指数算出済み（芝+ダート） | 26,411レース |
| 基準タイム | 428エントリ（芝284+ダート144） |
| 外部馬場差データ | ittai.net由来（2019-2026年） |
| 内製馬場差データ | 2,312日×会場レコード（2018-2026年） |
| 対象期間 | 2018-2026年 |
| 対象競馬場 | 全10場 |
