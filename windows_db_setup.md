# Windows側 DB構築セットアップ手順

## 概要

競走馬指数プロジェクトのデータ拡充のため、TARGET frontier JV + mykeibadb + PostgreSQL を使って
JRA-VANデータのローカルDBを構築する。

- **ツール**: mykeibadb（https://keough.watson.jp/wp/mykeibadb/）
- **DB**: PostgreSQL（Windows上）
- **データソース**: TARGET frontier JV 経由でJRA-VANからデータ出力
- **目的**: 過去レースデータ（2000年代〜）の取得 + レースグレード（G1/G2/G3）情報の保管

---

## 現在のMacプロジェクト構成（参考）

```
Mac（メイン開発機）
├── race_result/*.csv       # netkeibaスクレイピング結果（2018年〜）
│     カラム: 競馬場名,開催,開催日,クラス,芝/ダート,距離,天候,馬場,
│             着順,枠番,馬番,馬名,性齢,斤量,騎手,タイム,着差,通過,上がり,人気,単勝オッズ
├── race_index/*.csv        # 指数算出結果
├── base_times.json         # 基準タイム（16クラス×会場×距離）
├── external_baba_diff.json # 外部馬場差（ittai.net、2018-2026）
└── scripts/calc_index.js  # 指数計算メインスクリプト
```

---

## Windows側でやること

### Step 1: PostgreSQL インストール

- PostgreSQL（最新安定版）をインストール
- DBとユーザーを作成
  ```sql
  CREATE DATABASE keiba;
  CREATE USER keiba_user WITH PASSWORD 'xxxx';
  GRANT ALL PRIVILEGES ON DATABASE keiba TO keiba_user;
  ```

### Step 2: mykeibadb セットアップ

- 公式サイト（https://keough.watson.jp/wp/mykeibadb/）からダウンロード・インストール
- PostgreSQL接続設定を行う
- 初回データ取得（JRA-VAN経由、全期間）→ 数日かかる可能性あり

### Step 3: TARGET frontier JV でデータ出力

- TARGET frontier JV からJRA-VANデータをダウンロード・更新
- mykeibadbがJV-Link経由でPostgreSQLへデータを投入

---

## 取得したいデータ・重要テーブル（mykeibadb）

mykeibadbのテーブル構成を確認しつつ、以下の情報を優先的に把握する。

| 欲しい情報 | 想定テーブル |
|---|---|
| レース基本情報（場・距離・コース・天候・馬場） | レース系テーブル |
| **レースグレード（G1/G2/G3/L/OP）** | レース系テーブル |
| 馬毎結果（着順・タイム・上がり・騎手・斤量） | 成績系テーブル |
| 馬名・馬ID | 馬マスタ |
| 払い戻し（人気・オッズ） | 払戻系テーブル |

---

## MacのCSVフォーマットとの対応（将来的なエクスポート用）

Mac側の `race_result/*.csv` に追加したいカラムは **グレード1列のみ**。

```
競馬場名,開催,開催日,クラス,グレード,芝/ダート,距離,天候,馬場,
着順,枠番,馬番,馬名,性齢,斤量,騎手,タイム,着差,通過,上がり,人気,単勝オッズ
```

グレード値の仕様：
| 値 | 意味 |
|---|---|
| `G1` | GI競走 |
| `G2` | GII競走 |
| `G3` | GIII競走 |
| `L` | リステッド |
| `OP` | 一般オープン |
| `` (空文字) | 条件戦（1勝・2勝・3勝・新馬・未勝利） |

---

## 最初にやること（このWindows環境で）

1. mykeibadbのテーブル定義を確認する（`\dt` や `\d テーブル名` で確認）
2. レースグレードが格納されているカラム・テーブルを特定する
3. Mac側CSVフォーマットに対応するSELECTクエリを作成する
4. 将来的にMac → PostgreSQLへのクエリ、またはCSVエクスポートの仕組みを検討する

---

## 備考

- Mac側の指数計算ロジック（calc_index.js）はCSVベースで動作しており、当面変更しない
- グレード情報はビューア（GitHub Pages）での絞り込み表示に使用予定
- JRA-VANデータは2000年代初頭から取得可能（netkeibaスクレイピングは2018年〜）
- mykeibadbのライセンス・利用規約を確認すること
