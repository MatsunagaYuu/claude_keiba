// NAR内製馬場差: 馬効果と日次馬場差の同時推定（交互最小二乗）
// build_baba_diff_v2.js のNAR移植版。タイム偏差（斤量補正・距離正規化済み）を
//   偏差 ≈ 馬効果（馬×半年ブロック） + 日効果（日×会場×路面） + レース効果 + ノイズ
// に分解する。対象会場は nar_race_result/ にある全会場（門別・大井・盛岡・水沢など）。
// 基準タイムは会場×路面×距離（クラス無し）だが、クラス質の差は馬効果が吸収する。
// 会場間を転厩馬の馬効果が接続するため、日効果の会場間水準も同時に推定される。
// 出力はJRA baba_diff.json と同形式。水準定数は無し（馬効果加重平均=0の制約で固定）。
// 使い方:
//   node scripts/build_nar_baba_diff.js                      # 全期間一括 → nar_baba_diff.json
//   node scripts/build_nar_baba_diff.js --fit-horses even    # 馬分割標本（汎化評価用）
//   node scripts/build_nar_baba_diff.js --append 20260708 20260709  # 指定日のみ追記（過去凍結）
// 注意: 一括再構築後は進行中半期の直近日が馬効果不足で潰れるため、
//       JRA同様に直近開催日を --append で上書きすること。
const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = path.join(__dirname, "..", "nar_race_result");
const BASE_TIMES_FILE = path.join(__dirname, "..", "nar_base_times.json");

const apIdx = process.argv.indexOf("--append");
const APPEND_DATES = apIdx >= 0
  ? process.argv.slice(apIdx + 1).filter(a => /^\d{8}$/.test(a))
      .map(d => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`).sort()
  : null;
if (apIdx >= 0 && (!APPEND_DATES || APPEND_DATES.length === 0)) {
  console.error("ERROR: --append には YYYYMMDD 形式の日付が必要です");
  process.exit(1);
}
const APPEND_WINDOW_DAYS = 180;
const outIdx = process.argv.indexOf("--out");
const OUTPUT_FILE = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1])
  : path.join(__dirname, "..", "nar_baba_diff.json");
const fhIdx = process.argv.indexOf("--fit-horses");
const FIT_HORSES = fhIdx >= 0 ? process.argv[fhIdx + 1] : "all"; // all|even|odd

// calc_nar_index.js と同一の補正定数
const BASE_WEIGHT = 55; // 門別の標準斤量（JRAより軽め）
const WEIGHT_FACTOR = 0.2;
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

const SHRINK_K = 8;       // 日効果の縮約強度（観測数換算）
const SHRINK_K_RACE = 15; // レース効果の縮約強度
// 基準タイムがクラス無しのため偏差の裾がJRAより広い（クラス差は馬効果が吸収する）
const CLIP = 12;
const MAX_ITER = 100;
const TOL = 0.002;

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

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

function trimmedMean(arr, pct) {
  if (arr.length === 0) return null;
  if (arr.length <= 4) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const sorted = [...arr].sort((a, b) => a - b);
  const t = Math.floor(sorted.length * pct / 100);
  const trimmed = sorted.slice(t, sorted.length - t);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function horseHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// race_id: {YYYY}{30}{MMDD}{RR}（NAR CSVには日付列が無いのでIDから復元）
function dateFromRaceId(rid) {
  return `${rid.slice(0, 4)}/${rid.slice(6, 8)}/${rid.slice(8, 10)}`;
}

function dateToDays(dateStr) {
  return Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / 86400000;
}

function main() {
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const btMap = {};
  for (const bt of baseTimes) btMap[`${bt.競馬場}_${bt["芝/ダート"]}_${bt.距離}`] = bt;

  const windowMin = APPEND_DATES ? dateToDays(APPEND_DATES[0]) - APPEND_WINDOW_DAYS : null;
  const windowMax = APPEND_DATES ? dateToDays(APPEND_DATES[APPEND_DATES.length - 1]) : null;
  const files = fs.readdirSync(RACE_RESULT_DIR).filter(f => f.endsWith(".csv"));

  // 観測の収集: { block(馬×半年), node(日付), race, y(正規化偏差) }
  const obs = [];
  const raceMeta = {};
  let skippedRaces = 0, clipped = 0;
  for (const file of files) {
    const rows = parseCSV(fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8"));
    if (rows.length === 0) { skippedRaces++; continue; }
    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = parseInt(first["距離"]);
    if ((surface !== "芝" && surface !== "ダート") || isNaN(dist)) { skippedRaces++; continue; }
    const bt = btMap[`${venue}_${surface}_${dist}`];
    if (!bt) { skippedRaces++; continue; }
    const rid = file.replace("result_", "").replace(".csv", "");
    const date = dateFromRaceId(rid);
    if (APPEND_DATES) {
      const dn = dateToDays(date);
      if (dn <= windowMin || dn > windowMax) continue;
    }

    const scale = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : (dist / 2000);
    const year = date.slice(0, 4);
    const half = parseInt(date.slice(5, 7)) <= 6 ? "H1" : "H2";
    const node = `${surface}_${date}_${venue}`;
    raceMeta[rid] = { date, venue, surface, raceNum: parseInt(rid.substring(10, 12)), scale, node };

    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) continue;
      const name = row["馬名"];
      if (!name) continue;
      if (FIT_HORSES === "even" && horseHash(name) % 2 !== 0) continue;
      if (FIT_HORSES === "odd" && horseHash(name) % 2 !== 1) continue;
      const sec = timeToSeconds(row["タイム"]);
      if (!sec) continue;
      const weight = parseFloat(row["斤量"]) || BASE_WEIGHT;
      const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (dist / 2000);
      const y = (sec - weightAdj - bt.基準走破秒) / scale;
      if (Math.abs(y) > CLIP) { clipped++; continue; }
      obs.push({ block: APPEND_DATES ? name : `${name}_${year}${half}`, node, race: rid, y });
    }
  }
  console.log(`観測数: ${obs.length}, クリップ除外: ${clipped}, スキップレース: ${skippedRaces}, fitHorses=${FIT_HORSES}`);

  const blockIdx = new Map(), nodeIdx = new Map(), raceIdx = new Map();
  for (const o of obs) {
    if (!blockIdx.has(o.block)) blockIdx.set(o.block, blockIdx.size);
    if (!nodeIdx.has(o.node)) nodeIdx.set(o.node, nodeIdx.size);
    if (!raceIdx.has(o.race)) raceIdx.set(o.race, raceIdx.size);
    o.b = blockIdx.get(o.block);
    o.n = nodeIdx.get(o.node);
    o.k = raceIdx.get(o.race);
  }
  const nBlocks = blockIdx.size, nNodes = nodeIdx.size, nRaces = raceIdx.size;
  console.log(`馬ブロック数: ${nBlocks}, 日ノード数: ${nNodes}, レース数: ${nRaces}`);

  const nodeObs = Array.from({ length: nNodes }, () => []);
  const blockObs = Array.from({ length: nBlocks }, () => []);
  const raceObs = Array.from({ length: nRaces }, () => []);
  for (const o of obs) { nodeObs[o.n].push(o); blockObs[o.b].push(o); raceObs[o.k].push(o); }

  // 交互最小二乗
  const a = new Float64Array(nBlocks); // 馬効果
  const b = new Float64Array(nNodes);  // 日効果
  const r = new Float64Array(nRaces);  // レース効果
  let iter = 0, maxDelta = Infinity;
  for (iter = 0; iter < MAX_ITER && maxDelta > TOL; iter++) {
    for (let i = 0; i < nBlocks; i++) {
      const list = blockObs[i];
      let s = 0;
      for (const o of list) s += o.y - b[o.n] - r[o.k];
      a[i] = s / list.length;
    }
    // 識別性制約: 馬効果の観測数加重平均=0（水準の馬効果側への漂流を防ぎ、
    // 日効果の0を「基準タイム=良馬場平均」に固定する）
    {
      let s = 0;
      for (let i = 0; i < nBlocks; i++) s += a[i] * blockObs[i].length;
      const mean = s / obs.length;
      for (let i = 0; i < nBlocks; i++) a[i] -= mean;
    }
    maxDelta = 0;
    for (let j = 0; j < nNodes; j++) {
      const list = nodeObs[j];
      const res = list.map(o => o.y - a[o.b] - r[o.k]);
      const raw = trimmedMean(res, 10);
      const nb = list.length / (list.length + SHRINK_K) * raw;
      const d = Math.abs(nb - b[j]);
      if (d > maxDelta) maxDelta = d;
      b[j] = nb;
    }
    for (let k = 0; k < nRaces; k++) {
      const list = raceObs[k];
      const res = list.map(o => o.y - a[o.b] - b[o.n]);
      const raw = trimmedMean(res, 10);
      const nr = list.length / (list.length + SHRINK_K_RACE) * raw;
      const d = Math.abs(nr - r[k]);
      if (d > maxDelta) maxDelta = d;
      r[k] = nr;
    }
  }
  console.log(`ALS収束: ${iter}回, maxDelta=${maxDelta.toFixed(4)}`);

  // 出力（JRA baba_diff.json 互換形式: 日付×会場レコード、路面別フィールド）
  const records = {};
  for (const [nodeKey, j] of nodeIdx) {
    const [surface, date, venue] = nodeKey.split("_");
    if (APPEND_DATES && !APPEND_DATES.includes(date)) continue;
    const dayKey = `${date}_${venue}`;
    if (!records[dayKey]) {
      records[dayKey] = {
        年: parseInt(date.slice(0, 4)), 競馬場: venue, 日付: date,
        芝馬場差: null, ダート馬場差: null,
      };
    }
    const val = parseFloat(b[j].toFixed(2));
    if (surface === "芝") records[dayKey].芝馬場差 = val;
    else records[dayKey].ダート馬場差 = val;
  }
  for (const [rid, k] of raceIdx) {
    const m = raceMeta[rid];
    const rec = records[`${m.date}_${m.venue}`];
    if (!rec) continue;
    if (!rec.レース別馬場差) rec.レース別馬場差 = {};
    const j = nodeIdx.get(m.node);
    rec.レース別馬場差[String(m.raceNum)] = parseFloat(((b[j] + r[k]) * m.scale).toFixed(2));
  }
  let output = Object.values(records);
  if (APPEND_DATES) {
    for (const d of APPEND_DATES) {
      if (!output.some(rec => rec.日付 === d)) {
        console.error(`ERROR: 対象日 ${d} の観測がありません（レース結果未取得？）`);
        process.exit(1);
      }
    }
    const existing = fs.existsSync(OUTPUT_FILE)
      ? JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8")).filter(rec => !APPEND_DATES.includes(rec.日付))
      : [];
    console.log(`追記: ${output.length}レコード（既存${existing.length}レコードは凍結）`);
    output = existing.concat(output);
  }
  output.sort((x, y) => x.日付.localeCompare(y.日付) || x.競馬場.localeCompare(y.競馬場));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 1), "utf-8");
  console.log(`出力: ${output.length}日会場レコード → ${OUTPUT_FILE}`);

  for (const surf of ["芝", "ダート"]) {
    const key = `${surf}馬場差`;
    const vals = output.map(rec => rec[key]).filter(v => v !== null).sort((x, y) => x - y);
    if (vals.length === 0) continue;
    const avg = vals.reduce((x, y) => x + y, 0) / vals.length;
    console.log(`${surf}: ${vals.length}日会場, 平均=${avg.toFixed(3)}, 最速=${vals[0]}, 最遅=${vals[vals.length - 1]}`);
  }
}

main();
