const fs = require("fs");
const path = require("path");
const { parseCSV, toCSVLine } = require("./csv_util");

const V3_MODE = process.argv.includes("--v3");
const RACE_EFFECT_CALIB_FILE = path.join(__dirname, "..", "race_effect_calibration.json");

const RACE_RESULT_DIR = path.join(__dirname, "..", "nar_race_result");
const outdirIdx = process.argv.indexOf("--outdir");
const OUTPUT_DIR = outdirIdx >= 0
  ? path.join(__dirname, "..", process.argv[outdirIdx + 1])
  : path.join(__dirname, "..", "nar_race_index");
const BASE_TIMES_FILE = path.join(__dirname, "..", "nar_base_times.json");
const BABA_DIFF_FILE = path.join(__dirname, "..", "nar_baba_diff.json");

// 距離別アンカー指数（全会場共通・暫定。会場間の水準差は基準タイムが会場別のため
// 指数には現れない＝会場をまたぐ絶対比較は未キャリブレーション。転厩馬データが
// 溜まったら会場offsetを推定して補正する想定）
const ANCHOR_BY_DIST = {
  850: 242,
  1000: 245,
  1100: 245,
  1200: 250,
  1300: 253,
  1400: 255,
  1500: 260,
  1600: 260,
  1650: 260,
  1700: 260,
  1800: 260,
  1900: 263,
  2000: 265,
  2400: 265,
  2600: 265,
};
const DEFAULT_ANCHOR = 260;
const BASE_FACTOR = 6.667; // 2000m基準

// build_nar_baba_diff.js と同一の補正定数
const BASE_WEIGHT = 55; // 門別の標準斤量
const WEIGHT_FACTOR = 0.2;
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

// タイム文字列(M:SS.S) → 秒数
function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

// CSVパース

// race_idから日付(YYYY/MM/DD)を抽出
function extractDate(filename) {
  const id = filename.replace("result_", "").replace(".csv", "");
  const year = id.substring(0, 4);
  const mm = id.substring(6, 8);
  const dd = id.substring(8, 10);
  return `${year}/${mm}/${dd}`;
}

function main() {
  // 基準タイム読み込み（会場×路面×距離）
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const btMap = {};
  for (const b of baseTimes) btMap[`${b.競馬場}_${b["芝/ダート"]}_${b.距離}`] = b;

  // 馬場差読み込み（日付×会場）
  const babaDiff = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
  const babaMap = {};
  for (const b of babaDiff) babaMap[`${b.日付}_${b.競馬場}`] = b;

  // --v3: レース効果補正係数（build_race_calibration.js が生成）。無ければ警告してこの補正のみスキップ
  let raceEffectCalib = null;
  if (V3_MODE) {
    if (fs.existsSync(RACE_EFFECT_CALIB_FILE)) {
      const rec = JSON.parse(fs.readFileSync(RACE_EFFECT_CALIB_FILE, "utf-8"));
      raceEffectCalib = rec.nar || null;
      if (raceEffectCalib) console.log(`--v3: race_effect_calibration.json loaded (nar: ${Object.keys(raceEffectCalib).join(", ")})`);
      else console.warn(`--v3: race_effect_calibration.json has no "nar" section. Skipping race-effect correction.`);
    } else {
      console.warn(`--v3: ${RACE_EFFECT_CALIB_FILE} not found. Skipping race-effect correction.`);
    }
  }

  // 出力ディレクトリ
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const files = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`Input files: ${files.length}`);

  let processed = 0, skipped = 0, noBaba = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) { skipped++; continue; }

    const venue = rows[0]["競馬場名"];
    const surface = rows[0]["芝/ダート"];
    const dist = parseInt(rows[0]["距離"]);
    const bt = btMap[`${venue}_${surface}_${dist}`];
    if (!bt) { skipped++; continue; }

    const date = extractDate(file);
    const baba = babaMap[`${date}_${venue}`];
    const raceNum = parseInt(file.replace("result_", "").substring(10, 12)) || 0;

    // factor: 距離スケーリング
    const factor = BASE_FACTOR * (2000 / dist);
    const anchorIndex = ANCHOR_BY_DIST[dist] || DEFAULT_ANCHOR;

    // 馬場差（nar_baba_diff.json: ALS内製・JRA互換形式）
    // レース別馬場差（距離補正済み秒）を最優先、無ければ日レベルを距離補正
    let babaDiff = 0, hasBaba = false;
    // --v3: raceEff = レース別馬場差(距離補正済み秒)/scale − 日次馬場差（verify_index_health.js と同一定義）
    let raceEffV3 = 0;
    if (baba) {
      const dayVal = surface === "芝" ? baba.芝馬場差 : baba.ダート馬場差;
      const raceVal = baba.レース別馬場差 && baba.レース別馬場差[String(raceNum)];
      if (raceVal !== undefined && raceVal !== null) {
        babaDiff = raceVal;
        hasBaba = true;
        if (V3_MODE && dayVal !== null && dayVal !== undefined) {
          const scaleV3 = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : dist / 2000;
          raceEffV3 = raceVal / scaleV3 - dayVal;
        }
      } else if (dayVal !== null && dayVal !== undefined) {
        babaDiff = surface === "ダート"
          ? dayVal * (DIRT_SCALE_A * dist + DIRT_SCALE_B)
          : dayVal * (dist / 2000);
        hasBaba = true;
      } else {
        noBaba++;
      }
    } else {
      noBaba++;
    }

    // --v3: 補正pt = kappa*raceEff（hasBabaのレースのみ、丸め前に加算）
    let correctionPt = 0;
    if (V3_MODE && hasBaba && raceEffectCalib) {
      const c = raceEffectCalib[surface];
      if (c) correctionPt = c.kappa * raceEffV3;
    }

    // 各馬の指数を計算
    const outputRows = [];
    for (const row of rows) {
      const rank = row["着順"];
      if (!/^\d+$/.test(rank)) {
        // 非完走（中止、除外等）
        outputRows.push({ ...row, 総合指数: "", 補正: hasBaba ? "1" : "0" });
        continue;
      }

      const totalSec = timeToSeconds(row["タイム"]);
      if (!totalSec) {
        outputRows.push({ ...row, 総合指数: "", 補正: hasBaba ? "1" : "0" });
        continue;
      }

      // 総合指数: JRA calc_index.js と同じ構造
      // adjustedRef = 基準 + 馬場差、timeDiff = adjustedRef - 走破 + 斤量補正
      const weight = parseFloat(row["斤量"]) || BASE_WEIGHT;
      const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (dist / 2000);
      const totalIndex = anchorIndex + (bt.基準走破秒 + babaDiff - totalSec + weightAdj) * factor + correctionPt;

      outputRows.push({
        ...row,
        総合指数: String(Math.round(totalIndex)),
        補正: hasBaba ? "1" : "0",
      });
    }

    // CSV出力
    const headers = Object.keys(outputRows[0]);
    const csvLines = [toCSVLine(headers)];
    for (const row of outputRows) {
      csvLines.push(toCSVLine(headers.map((h) => row[h] || "")));
    }
    const outFile = file.replace("result_", "index_");
    fs.writeFileSync(path.join(OUTPUT_DIR, outFile), csvLines.join("\n"), "utf-8");
    processed++;
  }

  console.log(`Processed: ${processed}, Skipped: ${skipped}, No baba data: ${noBaba}`);

  // サンプル表示: 各距離1レースずつ
  console.log("\n=== サンプル出力 ===");
  const seen = {};
  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (!rows.length) continue;
    const dist = parseInt(rows[0]["距離"]);
    if (seen[dist] || dist > 1800) continue;
    const date = extractDate(file);
    if (!babaMap[date]) continue;
    seen[dist] = true;

    const outFile = file.replace("result_", "index_");
    const outContent = fs.readFileSync(path.join(OUTPUT_DIR, outFile), "utf-8");
    const outRows = parseCSV(outContent);

    console.log(`\n--- ${rows[0]["レース名"]} ${dist}m (${rows[0]["クラス"]}) ${date} 馬場:${rows[0]["馬場"]}`);
    console.log("着 馬名              タイム   上がり  総合指数");
    for (const r of outRows.slice(0, 6)) {
      const name = (r["馬名"] || "").padEnd(10);
      console.log(
        `${(r["着順"]||"").padStart(2)} ${name} ${(r["タイム"]||"").padStart(7)}  ${(r["上がり"]||"").padStart(5)}   ${(r["総合指数"]||"").padStart(6)}`
      );
    }
  }
}

main();
