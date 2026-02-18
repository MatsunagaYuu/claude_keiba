const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = "./race_result";
const OUTPUT_FILE = "./base_times.json";

// 対象条件
const TARGET_SURFACE = "芝";

// クラス名 → カテゴリマッピング
function classifyRace(className) {
  if (!className) return null;
  if (className.includes("障害")) return null;
  if (className.includes("新馬")) return "未勝利";
  if (className.includes("未勝利")) return "未勝利";
  if (className.includes("1勝") || className.includes("500万下")) return "1勝クラス";
  if (className.includes("2勝") || className.includes("1000万下")) return "2勝クラス";
  if (className.includes("3勝") || className.includes("1600万下")) return "3勝クラス";
  if (className.includes("オープン") || className.includes("OP")) return "OP";
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return "OP";
  return null;
}

// クラスごとの基準指数
const CLASS_BASE_INDEX = {
  未勝利: 280,
  "1勝クラス": 300,
  "2勝クラス": 305,
  "3勝クラス": 310,
  OP: 315,
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

  // 良馬場のみ収集: key = "競馬場_距離_クラス"
  const groups = {};
  let skipped = 0;
  let processedRaces = 0;
  let processedHorses = 0;

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

    // フィルタ: 芝・良馬場のみ
    if (surface !== TARGET_SURFACE) continue;
    if (condition !== "良") continue;

    const category = classifyRace(className);
    if (!category) {
      skipped++;
      continue;
    }

    const key = `${venue}_${dist}_${category}`;
    if (!groups[key]) groups[key] = { early: [], last3f: [] };

    // 全完走馬のタイムを収集（着順が数字の馬のみ）
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

    if (raceHasData) processedRaces++;
  }

  console.log(
    `Processed: ${processedRaces} races (良 only), ${processedHorses} horses, Skipped: ${skipped} (unclassified)`
  );

  // 前半-上がり回帰スロープを (競馬場, 距離) 単位で算出
  const regressionData = {};
  for (const [key, data] of Object.entries(groups)) {
    const [venue, dist] = key.split("_");
    const rkey = `${venue}_${dist}`;
    if (!regressionData[rkey]) regressionData[rkey] = { early: [], last3f: [] };
    for (let i = 0; i < data.early.length; i++) {
      regressionData[rkey].early.push(data.early[i]);
      regressionData[rkey].last3f.push(data.last3f[i]);
    }
  }

  const slopes = {};
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
    console.log(`Regression slope ${rkey}: ${slopes[rkey].toFixed(4)} (n=${n})`);
  }

  // 基準タイム算出（良馬場の平均）
  const baseTimes = {};
  for (const [key, data] of Object.entries(groups)) {
    if (data.early.length === 0) continue;
    const [venue, dist, category] = key.split("_");

    const avgEarly =
      data.early.reduce((a, b) => a + b, 0) / data.early.length;
    const avgLast3f =
      data.last3f.reduce((a, b) => a + b, 0) / data.last3f.length;
    const avgTotal = avgEarly + avgLast3f;
    const rkey = `${venue}_${dist}`;

    baseTimes[key] = {
      競馬場: venue,
      距離: dist,
      クラス: category,
      基準指数: CLASS_BASE_INDEX[category],
      基準前半秒: parseFloat(avgEarly.toFixed(2)),
      基準前半: secondsToTime(avgEarly),
      基準上がり秒: parseFloat(avgLast3f.toFixed(2)),
      基準上がり: avgLast3f.toFixed(1),
      基準走破秒: parseFloat(avgTotal.toFixed(2)),
      基準走破: secondsToTime(avgTotal),
      回帰スロープ: parseFloat(slopes[rkey].toFixed(4)),
      サンプル数: data.early.length,
    };
  }

  // ソート
  const sorted = Object.values(baseTimes).sort(
    (a, b) =>
      a.競馬場.localeCompare(b.競馬場) ||
      parseInt(a.距離) - parseInt(b.距離) ||
      a.クラス.localeCompare(b.クラス)
  );

  console.log("\n=== 基準タイムテーブル（良馬場） ===");
  console.log(
    "競馬場  距離   クラス        基準指数  前半     上がり  走破      サンプル"
  );
  for (const row of sorted) {
    console.log(
      `${row.競馬場.padEnd(4)}  ${row.距離.padStart(4)}m  ${row.クラス.padEnd(10)}  ${String(row.基準指数).padStart(4)}    ${row.基準前半.padStart(7)}  ${row.基準上がり.padStart(5)}   ${row.基準走破.padStart(7)}   ${String(row.サンプル数).padStart(4)}`
    );
  }

  // 出力
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${sorted.length} entries, 良馬場のみ)`);
}

main();
