const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result_fromDB");
const OUTPUT_FILE = path.join(__dirname, "..", "base_times.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");

// 対象: 芝・ダート両方（障害は除外）
const TARGET_SURFACES = ["芝", "ダート"];

// 外部馬場差のダート基準距離（会場別）
const DIRT_BASE_DIST = {
  東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700,
};
const DIRT_DEFAULT_DIST = 1800;

// 馬場差の前半/上がり配分
const BABA_EARLY_RATIO = 0.6;
const BABA_LAST3F_RATIO = 0.4;

// クラス名 → 年齢クラス別カテゴリマッピング
function classifyRace(className) {
  if (!className) return null;
  if (className.includes("障害")) return null;

  // 年齢プレフィックスを判定
  let age;
  if (className.includes("2歳")) age = "2歳";
  else if (className.includes("4歳以上")) age = "4歳以上";
  else if (className.includes("3歳以上")) age = "3歳以上";
  else if (className.includes("3歳")) age = "3歳";
  else age = "3歳以上"; // デフォルト（リステッド等）

  // 等級を判定
  if (className.includes("新馬")) return `${age}新馬`;
  if (className.includes("未勝利")) return `${age}未勝利`;
  if (className.includes("1勝") || className.includes("500万下")) return `${age}1勝`;
  if (className.includes("2勝") || className.includes("1000万下")) return `${age}2勝`;
  if (className.includes("3勝") || className.includes("1600万下")) return `${age}3勝`;
  if (className.includes("オープン") || className.includes("OP")) return `${age}OP`;
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return `${age}OP`;
  return null;
}

// クラスごとの基準指数（芝/ダート × 年齢クラス別）
const CLASS_BASE_INDEX_TURF = {
  "2歳新馬": 282, "2歳未勝利": 285, "2歳1勝": 290, "2歳OP": 295,
  "3歳新馬": 288, "3歳未勝利": 291, "3歳1勝": 295, "3歳OP": 304,
  "3歳以上1勝": 299, "3歳以上2勝": 304, "3歳以上3勝": 308, "3歳以上OP": 312,
  "4歳以上1勝": 299, "4歳以上2勝": 304, "4歳以上3勝": 308, "4歳以上OP": 312,
};
const CLASS_BASE_INDEX_DIRT = {
  "2歳新馬": 274, "2歳未勝利": 274, "2歳1勝": 280, "2歳OP": 285,
  "3歳新馬": 277, "3歳未勝利": 280, "3歳1勝": 286, "3歳OP": 303,
  "3歳以上1勝": 293, "3歳以上2勝": 302, "3歳以上3勝": 308, "3歳以上OP": 315,
  "4歳以上1勝": 293, "4歳以上2勝": 302, "4歳以上3勝": 308, "4歳以上OP": 315,
};

// タイム文字列(M:SS.S) → 秒数
function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

// 秒数 → M:SS.S 表示
function secondsToTime(sec) {
  return Math.floor(sec / 60) + ":" + (sec % 60).toFixed(1).padStart(4, "0");
}

// CSVパース（簡易）
function parseCSV(content) {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const row = {};
    headers.forEach((h, idx) => (row[h] = vals[idx] || ""));
    rows.push(row);
  }
  return rows;
}

function main() {
  const files = fs
    .readdirSync(RACE_RESULT_DIR)
    .filter((f) => f.endsWith(".csv"));
  console.log(`CSV files found: ${files.length}`);

  // 外部馬場差を読み込み: key = "surface_日付_競馬場" → 馬場差（外部基準距離での秒数）
  const extBabaMap = {};
  if (fs.existsSync(EXT_BABA_FILE) && fs.existsSync(CALENDAR_FILE)) {
    const extData = JSON.parse(fs.readFileSync(EXT_BABA_FILE, "utf-8"));
    for (const e of extData) {
      if (e.芝馬場差 !== null) {
        extBabaMap[`芝_${e.日付}_${e.競馬場}`] = e.芝馬場差; // 2000m基準
      }
      if (e.ダート馬場差 !== null) {
        extBabaMap[`ダート_${e.日付}_${e.競馬場}`] = e.ダート馬場差; // 会場別基準距離
      }
    }
    console.log(`External baba_diff loaded: ${Object.keys(extBabaMap).length} entries`);
  }

  // カレンダーから開催→日付の逆引き
  const calDateMap = {};
  if (fs.existsSync(CALENDAR_FILE)) {
    const cal = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
    for (const entry of cal) {
      for (const v of entry.venues) {
        const key = `${entry.date.substring(0,4)}_${v.venue}_${v.kaisai}_${v.day}`;
        calDateMap[key] = `${entry.date.substring(0,4)}/${entry.date.substring(4,6)}/${entry.date.substring(6,8)}`;
      }
    }
  }

  // レース結果を収集: key = "surface_競馬場_距離_クラス"
  // 外部馬場差がある日 → 全馬場状態を使用（標準馬場に補正）
  // 外部馬場差がない日 → 良馬場のみ使用（補正なし）
  const groups = {};
  let skipped = 0;
  let processedRaces = 0;
  let processedHorses = 0;
  let correctedRaces = 0;
  let uncorrectedRaces = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = first["距離"];
    const condition = first["馬場"];
    const className = first["クラス"];
    const kaisai = first["開催"];
    const nichime = first["開催日"];

    if (!TARGET_SURFACES.includes(surface)) continue;

    const category = classifyRace(className);
    if (!category) {
      skipped++;
      continue;
    }

    // 外部馬場差の検索
    const raceId = file.replace("result_", "").replace(".csv", "");
    const year = raceId.substring(0, 4);
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));
    const calKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    const raceDate = calDateMap[calKey];
    const extKey = raceDate ? `${surface}_${raceDate}_${venue}` : null;
    const extBaba = extKey ? extBabaMap[extKey] : undefined;

    if (extBaba !== undefined) {
      // 外部馬場差あり → 全馬場状態OK、標準馬場に補正
      // 外部値を当該距離に変換
      const d = parseInt(dist);
      let babaCorrTotal;
      if (surface === "ダート") {
        const baseDist = DIRT_BASE_DIST[venue] || DIRT_DEFAULT_DIST;
        babaCorrTotal = extBaba * (d / baseDist);
      } else {
        babaCorrTotal = extBaba * (d / 2000);
      }
      const babaCorrEarly = babaCorrTotal * BABA_EARLY_RATIO;
      const babaCorrLast3f = babaCorrTotal * BABA_LAST3F_RATIO;

      const key = `${surface}_${venue}_${dist}_${category}`;
      if (!groups[key]) groups[key] = { surface, early: [], last3f: [] };

      let raceHasData = false;
      for (const row of rows) {
        if (!/^\d+$/.test(row["着順"])) continue;
        const totalSec = timeToSeconds(row["タイム"]);
        const last3f = parseFloat(row["上がり"]);
        if (!totalSec || !last3f || isNaN(last3f)) continue;

        const earlySec = totalSec - last3f;
        // 標準馬場に補正（馬場差を引く: 速い馬場なら馬場差<0 → 補正後は遅くなる）
        groups[key].early.push(earlySec - babaCorrEarly);
        groups[key].last3f.push(last3f - babaCorrLast3f);
        raceHasData = true;
        processedHorses++;
      }
      if (raceHasData) { processedRaces++; correctedRaces++; }
    } else {
      // 外部馬場差なし → 良馬場のみ、補正なし（従来通り）
      if (condition !== "良") continue;

      const key = `${surface}_${venue}_${dist}_${category}`;
      if (!groups[key]) groups[key] = { surface, early: [], last3f: [] };

      let raceHasData = false;
      for (const row of rows) {
        if (!/^\d+$/.test(row["着順"])) continue;
        const totalSec = timeToSeconds(row["タイム"]);
        const last3f = parseFloat(row["上がり"]);
        if (!totalSec || !last3f || isNaN(last3f)) continue;

        const earlySec = totalSec - last3f;
        groups[key].early.push(earlySec);
        groups[key].last3f.push(last3f);
        raceHasData = true;
        processedHorses++;
      }
      if (raceHasData) { processedRaces++; uncorrectedRaces++; }
    }
  }

  console.log(
    `Processed: ${processedRaces} races (corrected: ${correctedRaces}, uncorrected/良: ${uncorrectedRaces}), ${processedHorses} horses, Skipped: ${skipped} (unclassified)`
  );

  // 前半-上がり回帰スロープを (surface, 競馬場, 距離) 単位で算出
  const regressionData = {};
  for (const [key, data] of Object.entries(groups)) {
    const [surface, venue, dist] = key.split("_");
    const rkey = `${surface}_${venue}_${dist}`;
    if (!regressionData[rkey]) regressionData[rkey] = { early: [], last3f: [] };
    for (let i = 0; i < data.early.length; i++) {
      regressionData[rkey].early.push(data.early[i]);
      regressionData[rkey].last3f.push(data.last3f[i]);
    }
  }

  const slopes = {};
  const stddevs = {};
  const regressionR2 = {};
  for (const [rkey, rd] of Object.entries(regressionData)) {
    const n = rd.early.length;
    const meanX = rd.early.reduce((a, b) => a + b, 0) / n;
    const meanY = rd.last3f.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const dx = rd.early[i] - meanX;
      const dy = rd.last3f[i] - meanY;
      num += dx * dy;
      den += dx * dx;
    }
    slopes[rkey] = den !== 0 ? num / den : 0;
    const variance = rd.last3f.reduce((sum, y) => sum + (y - meanY) ** 2, 0) / n;
    stddevs[rkey] = Math.sqrt(variance);
    // R²（決定係数）: スロープの説明力を評価
    const intercept = meanY - slopes[rkey] * meanX;
    const ssTot = rd.last3f.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
    const ssRes = rd.last3f.reduce((sum, y, i) => {
      const predicted = slopes[rkey] * rd.early[i] + intercept;
      return sum + (y - predicted) ** 2;
    }, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    regressionR2[rkey] = r2;
    console.log(`Regression ${rkey}: slope=${slopes[rkey].toFixed(4)}, R²=${r2.toFixed(4)}, stddev=${stddevs[rkey].toFixed(3)} (n=${n})`);
  }

  // 基準タイム算出（良馬場・上下10%カット平均）
  // 走破タイムの分布は正方向に歪む（大敗馬の影響）ため、
  // trimmed meanで外れ値の影響を緩和する
  const TRIM_RATE = 0.10;

  function trimmedMean(vals) {
    const sorted = [...vals].sort((a, b) => a - b);
    const n = sorted.length;
    const lo = Math.ceil(n * TRIM_RATE);
    const hi = Math.floor(n * (1 - TRIM_RATE));
    if (hi <= lo) return vals.reduce((a, b) => a + b, 0) / n;
    const trimmed = sorted.slice(lo, hi);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }

  const baseTimes = {};
  for (const [key, data] of Object.entries(groups)) {
    if (data.early.length === 0) continue;
    const [surface, venue, dist, category] = key.split("_");

    const avgEarly = trimmedMean(data.early);
    const avgLast3f = trimmedMean(data.last3f);
    const avgTotal = avgEarly + avgLast3f;
    const rkey = `${surface}_${venue}_${dist}`;

    baseTimes[key] = {
      "芝/ダート": surface,
      競馬場: venue,
      距離: dist,
      クラス: category,
      基準指数: (surface === "ダート" ? CLASS_BASE_INDEX_DIRT : CLASS_BASE_INDEX_TURF)[category],
      基準前半秒: parseFloat(avgEarly.toFixed(2)),
      基準前半: secondsToTime(avgEarly),
      基準上がり秒: parseFloat(avgLast3f.toFixed(2)),
      基準上がり: avgLast3f.toFixed(1),
      基準走破秒: parseFloat(avgTotal.toFixed(2)),
      基準走破: secondsToTime(avgTotal),
      回帰スロープ: parseFloat(slopes[rkey].toFixed(4)),
      回帰R2: parseFloat((regressionR2[rkey] || 0).toFixed(4)),
      上がり標準偏差: parseFloat((stddevs[rkey] || 0).toFixed(3)),
      サンプル数: data.early.length,
    };
  }

  // ソート
  const sorted = Object.values(baseTimes).sort(
    (a, b) =>
      a["芝/ダート"].localeCompare(b["芝/ダート"]) ||
      a.競馬場.localeCompare(b.競馬場) ||
      parseInt(a.距離) - parseInt(b.距離) ||
      a.クラス.localeCompare(b.クラス)
  );

  for (const surf of TARGET_SURFACES) {
    const surfData = sorted.filter(r => r["芝/ダート"] === surf);
    console.log(`\n=== 基準タイムテーブル（${surf}・標準馬場換算） ===`);
    console.log(
      "競馬場  距離   クラス        基準指数  前半     上がり  走破      サンプル"
    );
    for (const row of surfData) {
      console.log(
        `${row.競馬場.padEnd(4)}  ${row.距離.padStart(4)}m  ${row.クラス.padEnd(10)}  ${String(row.基準指数).padStart(4)}    ${row.基準前半.padStart(7)}  ${row.基準上がり.padStart(5)}   ${row.基準走破.padStart(7)}   ${String(row.サンプル数).padStart(4)}`
      );
    }
    console.log(`${surf}: ${surfData.length} entries`);
  }

  // 出力
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${sorted.length} entries)`);
}

main();
