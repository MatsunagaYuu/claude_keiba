// 上がり層（前半秒・上がり秒・回帰スロープ・上がり標準偏差）の鮮度更新版基準値。
// build_base_times.js と同一の対象条件・補正・クラス分類を使うが、直近N年窓（既定6年、
// 「実行時の最新レース年」から遡る）のデータのみを対象にする。
// 水準（基準走破秒・基準指数）は base_times.json の管轄のまま、ここでは出力しない
// （calc_index.js --v3 が上がり層の参照だけを本ファイルに差し替える設計のため）。
//
// 使い方: node scripts/build_agari_baselines.js [--window 6] [--out agari_baselines.json]

const fs = require("fs");
const path = require("path");
const { parseCSV } = require("./csv_util");

const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");

const windowIdx = process.argv.indexOf("--window");
const WINDOW_YEARS = windowIdx >= 0 ? parseInt(process.argv[windowIdx + 1]) : 6;
const outIdx = process.argv.indexOf("--out");
const OUTPUT_FILE = outIdx >= 0
  ? path.join(__dirname, "..", process.argv[outIdx + 1])
  : path.join(__dirname, "..", "agari_baselines.json");

// 対象: 芝・ダート両方（障害は除外）
const TARGET_SURFACES = ["芝", "ダート"];

// 外部馬場差のダート基準距離（会場別） -- build_base_times.js と同一
const DIRT_BASE_DIST = {
  東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700,
};
const DIRT_DEFAULT_DIST = 1800;

// 馬場差の前半/上がり配分 -- build_base_times.js と同一
const BABA_EARLY_RATIO = 0.6;
const BABA_LAST3F_RATIO = 0.4;

// クラス名 → 年齢クラス別カテゴリマッピング（build_base_times.js と同一）
function classifyRace(className) {
  if (!className) return null;
  if (className.includes("障害")) return null;

  let age;
  if (className.includes("2歳")) age = "2歳";
  else if (className.includes("4歳以上")) age = "4歳以上";
  else if (className.includes("3歳以上")) age = "3歳以上";
  else if (className.includes("3歳")) age = "3歳";
  else age = "3歳以上";

  if (className.includes("新馬")) return `${age}新馬`;
  if (className.includes("未勝利")) return `${age}未勝利`;
  if (className.includes("1勝") || className.includes("500万下")) return `${age}1勝`;
  if (className.includes("2勝") || className.includes("1000万下")) return `${age}2勝`;
  if (className.includes("3勝") || className.includes("1600万下")) return `${age}3勝`;
  if (className.includes("オープン") || className.includes("OP")) return `${age}OP`;
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return `${age}OP`;
  return null;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}
function secondsToTime(sec) {
  return Math.floor(sec / 60) + ":" + (sec % 60).toFixed(1).padStart(4, "0");
}

function main() {
  const files = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`CSV files found: ${files.length}`);

  // 実行時の最新レース年を決定（ファイル名のraceId先頭4桁＝年、build_base_times.js等の慣例と統一）
  let maxYear = 0;
  for (const file of files) {
    const y = parseInt(file.replace("result_", "").slice(0, 4));
    if (!isNaN(y) && y > maxYear) maxYear = y;
  }
  const minYear = maxYear - WINDOW_YEARS + 1;
  console.log(`Window: ${WINDOW_YEARS}年（${minYear}-${maxYear}）`);

  // 外部馬場差を読み込み
  const extBabaMap = {};
  if (fs.existsSync(EXT_BABA_FILE) && fs.existsSync(CALENDAR_FILE)) {
    const extData = JSON.parse(fs.readFileSync(EXT_BABA_FILE, "utf-8"));
    for (const e of extData) {
      if (e.芝馬場差 !== null) extBabaMap[`芝_${e.日付}_${e.競馬場}`] = e.芝馬場差;
      if (e.ダート馬場差 !== null) extBabaMap[`ダート_${e.日付}_${e.競馬場}`] = e.ダート馬場差;
    }
    console.log(`External baba_diff loaded: ${Object.keys(extBabaMap).length} entries`);
  }

  // カレンダーから開催→日付の逆引き
  const calDateMap = {};
  if (fs.existsSync(CALENDAR_FILE)) {
    const cal = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
    for (const entry of cal) {
      for (const v of entry.venues) {
        const key = `${entry.date.substring(0, 4)}_${v.venue}_${v.kaisai}_${v.day}`;
        calDateMap[key] = `${entry.date.substring(0, 4)}/${entry.date.substring(4, 6)}/${entry.date.substring(6, 8)}`;
      }
    }
  }

  const groups = {};
  let skipped = 0, outOfWindow = 0;
  let processedRaces = 0, processedHorses = 0, correctedRaces = 0, uncorrectedRaces = 0;

  for (const file of files) {
    const raceId0 = file.replace("result_", "").replace(".csv", "");
    const year0 = parseInt(raceId0.slice(0, 4));
    if (isNaN(year0) || year0 < minYear || year0 > maxYear) { outOfWindow++; continue; }

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
    if (!category) { skipped++; continue; }

    const raceId = file.replace("result_", "").replace(".csv", "");
    const year = raceId.substring(0, 4);
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));
    const calKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    const raceDate = calDateMap[calKey];
    const extKey = raceDate ? `${surface}_${raceDate}_${venue}` : null;
    const extBaba = extKey ? extBabaMap[extKey] : undefined;

    if (extBaba !== undefined) {
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
        groups[key].early.push(earlySec - babaCorrEarly);
        groups[key].last3f.push(last3f - babaCorrLast3f);
        raceHasData = true;
        processedHorses++;
      }
      if (raceHasData) { processedRaces++; correctedRaces++; }
    } else {
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
    `Processed: ${processedRaces} races (corrected: ${correctedRaces}, uncorrected/良: ${uncorrectedRaces}), ${processedHorses} horses, Skipped: ${skipped} (unclassified), OutOfWindow: ${outOfWindow}`
  );

  // 前半-上がり回帰スロープを (surface, 競馬場, 距離) 単位で算出（build_base_times.js と同一）
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

  // 基準前半秒・基準上がり秒（良馬場・上下10%カット平均）— build_base_times.js と同一
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

  const agariBaselines = {};
  for (const [key, data] of Object.entries(groups)) {
    if (data.early.length === 0) continue;
    const [surface, venue, dist, category] = key.split("_");

    const avgEarly = trimmedMean(data.early);
    const avgLast3f = trimmedMean(data.last3f);
    const rkey = `${surface}_${venue}_${dist}`;

    agariBaselines[key] = {
      "芝/ダート": surface,
      競馬場: venue,
      距離: dist,
      クラス: category,
      基準前半秒: parseFloat(avgEarly.toFixed(2)),
      基準前半: secondsToTime(avgEarly),
      基準上がり秒: parseFloat(avgLast3f.toFixed(2)),
      基準上がり: avgLast3f.toFixed(1),
      回帰スロープ: parseFloat(slopes[rkey].toFixed(4)),
      回帰R2: parseFloat((regressionR2[rkey] || 0).toFixed(4)),
      上がり標準偏差: parseFloat((stddevs[rkey] || 0).toFixed(3)),
      サンプル数: data.early.length,
    };
  }

  const sorted = Object.values(agariBaselines).sort(
    (a, b) =>
      a["芝/ダート"].localeCompare(b["芝/ダート"]) ||
      a.競馬場.localeCompare(b.競馬場) ||
      parseInt(a.距離) - parseInt(b.距離) ||
      a.クラス.localeCompare(b.クラス)
  );

  for (const surf of TARGET_SURFACES) {
    const surfData = sorted.filter(r => r["芝/ダート"] === surf);
    console.log(`\n=== 上がり層基準テーブル（${surf}・${WINDOW_YEARS}年窓・標準馬場換算） ===`);
    console.log("競馬場  距離   クラス        前半     上がり  サンプル");
    for (const row of surfData) {
      console.log(
        `${row.競馬場.padEnd(4)}  ${row.距離.padStart(4)}m  ${row.クラス.padEnd(10)}  ${row.基準前半.padStart(7)}  ${row.基準上がり.padStart(5)}   ${String(row.サンプル数).padStart(4)}`
      );
    }
    console.log(`${surf}: ${surfData.length} entries`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${sorted.length} entries, window=${WINDOW_YEARS}y ${minYear}-${maxYear})`);
}

main();
