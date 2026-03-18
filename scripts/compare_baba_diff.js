const fs = require("fs");
const path = require("path");

const INTERNAL_FILE = path.join(__dirname, "..", "baba_diff.json");
const EXTERNAL_FILE = path.join(__dirname, "..", "external_baba_diff.json");

function main() {
  const internal = JSON.parse(fs.readFileSync(INTERNAL_FILE, "utf-8"));
  const external = JSON.parse(fs.readFileSync(EXTERNAL_FILE, "utf-8"));

  // 外部データをキー引き: "日付_競馬場"
  const extMap = {};
  for (const e of external) {
    const key = `${e.日付}_${e.競馬場}`;
    extMap[key] = e;
  }

  // 内部データをキー引き
  const intMap = {};
  for (const i of internal) {
    const key = `${i.日付}_${i.競馬場}`;
    intMap[key] = i;
  }

  // 芝・ダートそれぞれで比較
  for (const surface of ["芝", "ダート"]) {
    const field = `${surface}馬場差`;
    const pairs = [];

    for (const [key, intRec] of Object.entries(intMap)) {
      const extRec = extMap[key];
      if (!extRec) continue;
      const intVal = intRec[field];
      const extVal = extRec[field];
      if (intVal === null || intVal === undefined) continue;
      if (extVal === null || extVal === undefined) continue;
      pairs.push({ key, int: intVal, ext: extVal, diff: intVal - extVal });
    }

    if (pairs.length === 0) {
      console.log(`\n=== ${surface} ===\n  比較データなし`);
      continue;
    }

    // 基本統計
    const diffs = pairs.map((p) => p.diff);
    const absDiffs = diffs.map((d) => Math.abs(d));
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const absMean = absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length;
    const maxAbsDiff = Math.max(...absDiffs);

    // 相関係数
    const intVals = pairs.map((p) => p.int);
    const extVals = pairs.map((p) => p.ext);
    const corr = pearsonCorrelation(intVals, extVals);

    // RMSE
    const rmse = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);

    console.log(`\n=== ${surface}馬場差 比較 ===`);
    console.log(`  比較日数: ${pairs.length}`);
    console.log(`  相関係数: ${corr.toFixed(4)}`);
    console.log(`  平均差 (内製-外部): ${mean.toFixed(3)}`);
    console.log(`  平均絶対差: ${absMean.toFixed(3)}`);
    console.log(`  RMSE: ${rmse.toFixed(3)}`);
    console.log(`  最大絶対差: ${maxAbsDiff.toFixed(3)}`);

    // 差の分布
    const buckets = [0.5, 1.0, 1.5, 2.0, 3.0, Infinity];
    const labels = ["≤0.5", "≤1.0", "≤1.5", "≤2.0", "≤3.0", ">3.0"];
    console.log(`\n  差の分布:`);
    let cumCount = 0;
    for (let i = 0; i < buckets.length; i++) {
      const count = absDiffs.filter((d) => d <= buckets[i] && (i === 0 || d > buckets[i - 1])).length;
      cumCount += count;
      const pct = ((cumCount / pairs.length) * 100).toFixed(1);
      console.log(`    ${labels[i].padEnd(5)}: ${String(count).padStart(5)} (累計 ${pct}%)`);
    }

    // 差が大きいケースのサンプル（上位10件）
    pairs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    console.log(`\n  差が大きいケース（上位10件）:`);
    console.log(`  ${"日付_競馬場".padEnd(22)} ${"内製".padStart(7)} ${"外部".padStart(7)} ${"差".padStart(7)}`);
    for (const p of pairs.slice(0, 10)) {
      console.log(`  ${p.key.padEnd(22)} ${p.int.toFixed(2).padStart(7)} ${p.ext.toFixed(2).padStart(7)} ${p.diff.toFixed(2).padStart(7)}`);
    }
  }

  // レース別馬場差の比較
  console.log(`\n=== レース別馬場差 比較 ===`);
  const racePairs = [];
  for (const [key, intRec] of Object.entries(intMap)) {
    const extRec = extMap[key];
    if (!extRec || !extRec.レース別馬場差 || !intRec.レース別馬場差) continue;
    for (const [raceNum, intVal] of Object.entries(intRec.レース別馬場差)) {
      const extVal = extRec.レース別馬場差[raceNum];
      if (extVal === undefined || extVal === null) continue;
      racePairs.push({ key: `${key}_R${raceNum}`, int: intVal, ext: extVal, diff: intVal - extVal });
    }
  }
  if (racePairs.length > 0) {
    const diffs = racePairs.map((p) => p.diff);
    const absDiffs = diffs.map((d) => Math.abs(d));
    const corr = pearsonCorrelation(racePairs.map((p) => p.int), racePairs.map((p) => p.ext));
    const rmse = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
    console.log(`  比較レース数: ${racePairs.length}`);
    console.log(`  相関係数: ${corr.toFixed(4)}`);
    console.log(`  RMSE: ${rmse.toFixed(3)}`);
    console.log(`  平均絶対差: ${(absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length).toFixed(3)}`);
  } else {
    console.log(`  レース別馬場差の比較データなし`);
  }
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n === 0) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

main();
