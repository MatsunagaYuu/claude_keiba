// 内製馬場差 v2: 馬効果と日次馬場差の同時推定（交互最小二乗）
// タイム偏差（斤量補正・距離正規化済み）を
//   偏差 ≈ 馬効果（馬×半年ブロック） + 日効果（日×会場×路面） + ノイズ
// に分解する。指数は入力に使わない（指数のブレが馬場差に伝播しない構造）。
// 日効果はゼロ方向へ縮約（サンプル少の日の暴れ抑制）。
// 使い方:
//   node scripts/build_baba_diff_v2.js                     # → baba_diff_v2.json
//   node scripts/build_baba_diff_v2.js --out /tmp/x.json --since 2014
//   node scripts/build_baba_diff_v2.js --fit-horses even   # 馬分割標本（汎化評価用）
//   node scripts/build_baba_diff_v2.js --race-effect       # レース別効果を追加推定
// --race-effect: 馬効果・日効果を除いた残差からレース別効果（ペース・日内変動）を
// 縮約付きで推定し、レース別馬場差（旧フラット形式、補正済み秒）として出力する。
// v1のレース内平均と違い、馬効果を除去済みなのでフィールド質が混入しない。
const fs = require("fs");
const path = require("path");
const { parseCSV } = require("./csv_util");

const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result");
const BASE_TIMES_FILE = path.join(__dirname, "..", "base_times.json");

// --append YYYYMMDD [...]: 週次追記モード。対象日から遡る180日窓（馬効果は窓内一定）で
// 推定し、対象日のレコードだけを既存ファイルにマージする（過去日は凍結）。
// 暦半期ブロックの境界問題（1月・7月初週）を回避するための設計。レース効果は常に有効。
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
  : path.join(__dirname, "..", APPEND_DATES ? "baba_diff.json" : "baba_diff_v2.json");
const sinceIdx = process.argv.indexOf("--since");
const SINCE_YEAR = sinceIdx >= 0 ? parseInt(process.argv[sinceIdx + 1]) : 2014;
const fhIdx = process.argv.indexOf("--fit-horses");
const FIT_HORSES = fhIdx >= 0 ? process.argv[fhIdx + 1] : "all"; // all|even|odd
const RACE_EFFECT = process.argv.includes("--race-effect") || !!APPEND_DATES;

// calc_index.js と同一の補正定数
const BASE_WEIGHT = 57;
const WEIGHT_FACTOR = 0.2;
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

const MIN_BT_SAMPLES = 20;
const SHRINK_K = 8;      // 日効果の縮約強度（観測数換算）
const SHRINK_K_RACE = 15; // レース効果の縮約強度（1レース≈10-16頭なので強め）
// 外部馬場差（ittai.net）時代とのスケール連続性のための水準定数。
// 外部の基準0は「平均より遅い馬場」だったため、平均≈0の内製値をそのまま使うと
// 全指数が約+4.6pt上振れする（イクイノックス336が339になる）。
// 2018-2026の共通日の平均差（内-外）を打ち消す定数（2026-07-08確定、以後固定）
const LEVEL_OFFSET = { 芝: -0.686, ダート: -0.278 };
const CLIP = 8;          // 正規化偏差の外れ値クリップ（秒）
const MAX_ITER = 100;
const TOL = 0.002;

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

function getBaseTimes(baseMap, surface, venue, dist, ageClass) {
  const key = `${surface}_${venue}_${dist}_${ageClass}`;
  const bt = baseMap[key];
  if (bt && bt.サンプル数 >= MIN_BT_SAMPLES) return bt;
  const grade = ageClass.replace(/^(2歳|3歳|3歳以上|4歳以上)/, "");
  const fallbacks = ["3歳以上", "4歳以上"];
  for (const fb of fallbacks) {
    const fbBt = baseMap[`${surface}_${venue}_${dist}_${fb}${grade}`];
    if (fbBt && fbBt.サンプル数 >= MIN_BT_SAMPLES) return fbBt;
  }
  if (bt) return bt;
  for (const fb of fallbacks) {
    const fbBt = baseMap[`${surface}_${venue}_${dist}_${fb}${grade}`];
    if (fbBt) return fbBt;
  }
  return null;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
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

function padDate(dateStr) {
  const m = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
}

function dateToDays(dateStr) {
  return Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / 86400000;
}

function main() {
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const baseMap = {};
  for (const bt of baseTimes) {
    const surface = bt["芝/ダート"] || "芝";
    baseMap[`${surface}_${bt.競馬場}_${bt.距離}_${bt.クラス}`] = bt;
  }

  // append時は対象日の前年以降のファイルだけ読む（180日窓に十分）
  const effSince = APPEND_DATES ? parseInt(APPEND_DATES[0].slice(0, 4)) - 1 : SINCE_YEAR;
  const windowMin = APPEND_DATES ? dateToDays(APPEND_DATES[0]) - APPEND_WINDOW_DAYS : null;
  const windowMax = APPEND_DATES ? dateToDays(APPEND_DATES[APPEND_DATES.length - 1]) : null;
  const files = fs.readdirSync(RACE_RESULT_DIR).filter(f => {
    if (!f.endsWith(".csv")) return false;
    return parseInt(f.slice(7, 11)) >= effSince;
  });

  // 観測の収集: { block(馬×半年), node(日_会場_路面), race, y(正規化偏差) }
  const obs = [];
  const raceMeta = {};
  let skippedRaces = 0;
  for (const file of files) {
    const rows = parseCSV(fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8"));
    if (rows.length === 0) { skippedRaces++; continue; }
    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = parseInt(first["距離"]);
    if ((surface !== "芝" && surface !== "ダート") || isNaN(dist)) { skippedRaces++; continue; }
    const ageClass = classifyRace(first["クラス"]);
    if (!ageClass) { skippedRaces++; continue; }
    const bt = getBaseTimes(baseMap, surface, venue, first["距離"], ageClass);
    if (!bt) { skippedRaces++; continue; }
    const date = padDate(first["日付"]);
    if (!date) { skippedRaces++; continue; }
    if (APPEND_DATES) {
      const dn = dateToDays(date);
      if (dn <= windowMin || dn > windowMax) continue;
    }

    const scale = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : (dist / 2000);
    const year = date.slice(0, 4);
    const half = parseInt(date.slice(5, 7)) <= 6 ? "H1" : "H2";
    const node = `${surface}_${date}_${venue}`;
    const rid = file.replace("result_", "").replace(".csv", "");
    raceMeta[rid] = { date, venue, raceNum: parseInt(rid.substring(10, 12)), scale, node };

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
      if (Math.abs(y) > CLIP) continue;
      // append時は窓内一定の馬効果（暦半期の境界問題を回避）、一括構築時は馬×半期
      obs.push({ block: APPEND_DATES ? name : `${name}_${year}${half}`, node, race: rid, y });
    }
  }
  console.log(`観測数: ${obs.length}, スキップレース: ${skippedRaces}, fitHorses=${FIT_HORSES}`);

  // ブロック/ノード/レースのインデックス化
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
  console.log(`馬ブロック数: ${nBlocks}, 日×会場×路面ノード数: ${nNodes}, レース数: ${nRaces}, raceEffect=${RACE_EFFECT}`);

  // 集計用リスト
  const nodeObs = Array.from({ length: nNodes }, () => []);
  const blockObs = Array.from({ length: nBlocks }, () => []);
  const raceObs = Array.from({ length: nRaces }, () => []);
  for (const o of obs) { nodeObs[o.n].push(o); blockObs[o.b].push(o); raceObs[o.k].push(o); }

  // 交互最小二乗
  const a = new Float64Array(nBlocks); // 馬効果
  const b = new Float64Array(nNodes);  // 日効果
  const r = new Float64Array(nRaces);  // レース効果（--race-effect時のみ更新）
  let iter = 0, maxDelta = Infinity;
  for (iter = 0; iter < MAX_ITER && maxDelta > TOL; iter++) {
    // 馬効果更新: ブロック内平均
    for (let i = 0; i < nBlocks; i++) {
      const list = blockObs[i];
      let s = 0;
      for (const o of list) s += o.y - b[o.n] - r[o.k];
      a[i] = s / list.length;
    }
    // 日効果更新: トリム平均＋縮約
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
    // レース効果更新: 日効果からの残差のトリム平均＋強め縮約
    if (RACE_EFFECT) {
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
  }
  console.log(`ALS収束: ${iter}回, maxDelta=${maxDelta.toFixed(4)}`);

  // 出力: 日付×会場でグループ化（既存内製フォーマット互換）
  const records = {};
  for (const [nodeKey, j] of nodeIdx) {
    const [surface, date, venue] = nodeKey.split("_");
    if (APPEND_DATES && !APPEND_DATES.includes(date)) continue;
    const dayKey = `${date}_${venue}`;
    if (!records[dayKey]) {
      records[dayKey] = { 年: parseInt(date.slice(0, 4)), 競馬場: venue, 日付: date, 芝馬場差: null, ダート馬場差: null };
    }
    const val = parseFloat((b[j] + LEVEL_OFFSET[surface]).toFixed(2));
    if (surface === "芝") records[dayKey].芝馬場差 = val;
    else records[dayKey].ダート馬場差 = val;
  }
  // レース別馬場差（旧フラット形式: 距離補正済み秒。calc_indexが直接使用）
  if (RACE_EFFECT) {
    for (const [rid, k] of raceIdx) {
      const m = raceMeta[rid];
      const rec = records[`${m.date}_${m.venue}`];
      if (!rec) continue;
      if (!rec.レース別馬場差) rec.レース別馬場差 = {};
      const j = nodeIdx.get(m.node);
      const surf = m.node.split("_")[0];
      rec.レース別馬場差[String(m.raceNum)] = parseFloat(((b[j] + r[k] + LEVEL_OFFSET[surf]) * m.scale).toFixed(2));
    }
  }
  let output = Object.values(records);
  if (APPEND_DATES) {
    // 対象日に観測がなければ異常（結果未取得等）として失敗させる
    for (const d of APPEND_DATES) {
      if (!output.some(r => r.日付 === d)) {
        console.error(`ERROR: 対象日 ${d} の観測がありません（レース結果未取得？）`);
        process.exit(1);
      }
    }
    // 既存ファイルの対象日以外は凍結のままマージ
    const existing = fs.existsSync(OUTPUT_FILE)
      ? JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8")).filter(r => !APPEND_DATES.includes(r.日付))
      : [];
    console.log(`追記: ${output.length}レコード（既存${existing.length}レコードは凍結）`);
    output = existing.concat(output);
  }
  output.sort((x, y) => x.日付.localeCompare(y.日付) || x.競馬場.localeCompare(y.競馬場));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 1), "utf-8");
  console.log(`出力: ${output.length}日会場レコード → ${OUTPUT_FILE}`);

  // サマリー
  for (const surf of ["芝", "ダート"]) {
    const key = `${surf}馬場差`;
    const vals = output.map(r => r[key]).filter(v => v !== null).sort((x, y) => x - y);
    if (vals.length === 0) continue;
    const avg = vals.reduce((x, y) => x + y, 0) / vals.length;
    console.log(`${surf}: ${vals.length}日, 平均=${avg.toFixed(3)}, 最速=${vals[0]}, 最遅=${vals[vals.length - 1]}`);
  }
}

main();
