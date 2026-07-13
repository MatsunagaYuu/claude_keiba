const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = path.join(__dirname, "..", "nar_race_result");
const OUTPUT_FILE = path.join(__dirname, "..", "nar_base_times.json");

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

// CSVパース
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

// 上下10%カット平均
function trimmedMean(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  const lo = Math.ceil(n * 0.10);
  const hi = Math.floor(n * (1 - 0.10));
  if (hi <= lo) return vals.reduce((a, b) => a + b, 0) / n;
  const trimmed = sorted.slice(lo, hi);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function main() {
  const files = fs
    .readdirSync(RACE_RESULT_DIR)
    .filter((f) => f.endsWith(".csv"));
  console.log(`CSV files: ${files.length}`);

  // 距離別にタイム・上がりを収集（良馬場のみ）
  const groups = {}; // key: 距離 → { total: [], early: [], last3f: [] }
  let totalRaces = 0;
  let goodRaces = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const condition = first["馬場"];
    const dist = first["距離"];
    totalRaces++;

    // 良馬場のみ
    if (condition !== "良") continue;
    goodRaces++;

    if (!groups[dist]) groups[dist] = { total: [], early: [], last3f: [] };

    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) continue;
      const totalSec = timeToSeconds(row["タイム"]);
      if (!totalSec) continue;

      groups[dist].total.push(totalSec);

      const last3f = parseFloat(row["上がり"]);
      if (last3f && !isNaN(last3f)) {
        groups[dist].early.push(totalSec - last3f);
        groups[dist].last3f.push(last3f);
      }
    }
  }

  console.log(`Total races: ${totalRaces}, 良馬場: ${goodRaces}`);

  // 距離ごとに基準タイム算出
  const results = [];
  const distances = Object.keys(groups).sort((a, b) => parseInt(a) - parseInt(b));

  console.log("\n距離    基準走破      前半       上がり    サンプル(走破/上がり)");
  console.log("─".repeat(65));

  for (const dist of distances) {
    const g = groups[dist];
    const avgTotal = trimmedMean(g.total);
    const avgEarly = g.early.length >= 10 ? trimmedMean(g.early) : null;
    const avgLast3f = g.last3f.length >= 10 ? trimmedMean(g.last3f) : null;

    const entry = {
      距離: parseInt(dist),
      基準走破秒: parseFloat(avgTotal.toFixed(2)),
      基準走破: secondsToTime(avgTotal),
      基準前半秒: avgEarly ? parseFloat(avgEarly.toFixed(2)) : null,
      基準前半: avgEarly ? secondsToTime(avgEarly) : null,
      基準上がり秒: avgLast3f ? parseFloat(avgLast3f.toFixed(2)) : null,
      基準上がり: avgLast3f ? avgLast3f.toFixed(1) : null,
      サンプル数_走破: g.total.length,
      サンプル数_上がり: g.last3f.length,
    };
    results.push(entry);

    const earlyStr = avgEarly ? secondsToTime(avgEarly).padStart(7) : "   N/A ";
    const last3fStr = avgLast3f ? avgLast3f.toFixed(1).padStart(5) : "  N/A";
    console.log(
      `${dist.padStart(4)}m   ${secondsToTime(avgTotal).padStart(7)}   ${earlyStr}   ${last3fStr}     ${String(g.total.length).padStart(5)} / ${String(g.last3f.length).padStart(5)}`
    );
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${results.length} entries)`);
}

main();
