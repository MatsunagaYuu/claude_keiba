const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result");
const BASE_TIMES_FILE = path.join(__dirname, "..", "base_times.json");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const OUTPUT_FILE = path.join(__dirname, "..", "baba_diff.json");

// 斤量補正
const BASE_WEIGHT = 57;
const WEIGHT_FACTOR = 0.2;

// ダート基準距離（会場別、calc_index.jsと同一）
const DIRT_BASE_DIST = {
  東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700,
};
const DIRT_DEFAULT_DIST = 1800;

// --- calc_index.js と同一ロジック ---

const MIN_BT_SAMPLES = 20;

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
    const fbKey = `${surface}_${venue}_${dist}_${fb}${grade}`;
    const fbBt = baseMap[fbKey];
    if (fbBt && fbBt.サンプル数 >= MIN_BT_SAMPLES) return fbBt;
  }
  if (bt) return bt;
  for (const fb of fallbacks) {
    const fbKey = `${surface}_${venue}_${dist}_${fb}${grade}`;
    if (baseMap[fbKey]) return baseMap[fbKey];
  }
  return null;
}

// --- ユーティリティ ---

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

// トリム平均（上下 pct% を除外）
function trimmedMean(arr, pct) {
  if (arr.length === 0) return null;
  if (arr.length <= 4) {
    // 少数サンプルはそのまま平均
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * pct / 100);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  if (trimmed.length === 0) return arr.reduce((a, b) => a + b, 0) / arr.length;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function main() {
  // 基準タイム読み込み
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const baseMap = {};
  for (const bt of baseTimes) {
    const surface = bt["芝/ダート"] || "芝";
    const key = `${surface}_${bt.競馬場}_${bt.距離}_${bt.クラス}`;
    baseMap[key] = bt;
  }

  // カレンダーから (年_会場_開催_日次) → 日付 の逆引きマップ
  const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
  const calDateMap = {};
  for (const entry of calendar) {
    for (const v of entry.venues) {
      const key = `${entry.date.substring(0, 4)}_${v.venue}_${v.kaisai}_${v.day}`;
      const dateStr = `${entry.date.substring(0, 4)}/${entry.date.substring(4, 6)}/${entry.date.substring(6, 8)}`;
      calDateMap[key] = dateStr;
    }
  }

  // レース結果ファイルを全読み込み
  const files = fs
    .readdirSync(RACE_RESULT_DIR)
    .filter((f) => f.endsWith(".csv"));

  // レースごとの馬場差を算出し、日単位でグループ化
  // dayKey = "日付_会場" (e.g., "2019/01/05_中山")
  const dayRaces = {}; // dayKey → { surface → [ {raceNum, babaDiff, dist} ] }

  let processedRaces = 0;
  let skippedRaces = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) { skippedRaces++; continue; }

    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = first["距離"];
    const className = first["クラス"];
    const kaisai = first["開催"];
    const nichime = first["開催日"];

    if (surface !== "芝" && surface !== "ダート") { skippedRaces++; continue; }

    const ageClass = classifyRace(className);
    if (!ageClass) { skippedRaces++; continue; }

    const bt = getBaseTimes(baseMap, surface, venue, dist, ageClass);
    if (!bt) { skippedRaces++; continue; }

    // ファイル名からレースIDを取得
    const raceId = file.replace("result_", "").replace(".csv", "");
    const year = raceId.substring(0, 4);
    const raceNum = parseInt(raceId.substring(10, 12));
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));

    // 日付取得
    const calKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    const dateStr = calDateMap[calKey];
    if (!dateStr) { skippedRaces++; continue; }

    const d = parseInt(dist);

    // 各完走馬の偏差を算出
    const deviations = [];
    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) continue;
      const totalSec = timeToSeconds(row["タイム"]);
      if (!totalSec) continue;

      const weight = parseFloat(row["斤量"]) || BASE_WEIGHT;
      const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (d / 2000);
      const adjSec = totalSec - weightAdj;
      const rawDev = adjSec - bt.基準走破秒;
      const normDev = rawDev * (2000 / d);
      deviations.push(normDev);
    }

    if (deviations.length < 3) { skippedRaces++; continue; }

    // レース馬場差（トリム平均、上下10%除外）
    const raceBabaDiff = trimmedMean(deviations, 10);

    // 距離補正済みの値（レース別馬場差用）: 2000m換算値をレース距離に戻す
    // normDev = rawDev * (2000/d) なので、距離補正済み = raceBabaDiff * (d/2000)
    const distCorrectedDiff = raceBabaDiff * (d / 2000);

    const dayKey = `${dateStr}_${venue}`;
    if (!dayRaces[dayKey]) {
      dayRaces[dayKey] = {
        year: parseInt(year), venue, dateStr,
        芝: [], ダート: [],
      };
    }
    dayRaces[dayKey][surface].push({
      raceNum,
      babaDiff2000: raceBabaDiff,       // 2000m換算の馬場差
      distCorrectedDiff,                 // 距離補正済みの馬場差
      dist: d,
    });
    processedRaces++;
  }

  // 日ごとに集約して出力形式を構築
  const output = [];

  for (const [dayKey, dayData] of Object.entries(dayRaces)) {
    const record = {
      年: dayData.year,
      競馬場: dayData.venue,
      日付: dayData.dateStr,
    };

    // 芝馬場差: 全芝レースの2000m換算馬場差の平均
    if (dayData.芝.length > 0) {
      const turfDiffs = dayData.芝.map((r) => r.babaDiff2000);
      record.芝馬場差 = parseFloat((turfDiffs.reduce((a, b) => a + b, 0) / turfDiffs.length).toFixed(2));
    } else {
      record.芝馬場差 = null;
    }

    // ダート馬場差: 全ダートレースの2000m換算馬場差の平均を、基準距離に換算
    if (dayData.ダート.length > 0) {
      const dirtDiffs2000 = dayData.ダート.map((r) => r.babaDiff2000);
      const avg2000 = dirtDiffs2000.reduce((a, b) => a + b, 0) / dirtDiffs2000.length;
      // ダート馬場差は基準距離ベース（calc_index.jsがdist/baseDistで距離補正するため）
      const baseDist = DIRT_BASE_DIST[dayData.venue] || DIRT_DEFAULT_DIST;
      record.ダート馬場差 = parseFloat((avg2000 * (baseDist / 2000)).toFixed(2));
    } else {
      record.ダート馬場差 = null;
    }

    // レース別馬場差: 各レースの距離補正済みの値
    const allRaces = [...dayData.芝, ...dayData.ダート];
    if (allRaces.length > 0) {
      const raceMap = {};
      for (const r of allRaces) {
        raceMap[String(r.raceNum)] = parseFloat(r.distCorrectedDiff.toFixed(2));
      }
      record.レース別馬場差 = raceMap;
    }

    output.push(record);
  }

  // ソート: 日付 → 競馬場
  output.sort((a, b) => a.日付.localeCompare(b.日付) || a.競馬場.localeCompare(b.競馬場));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Processed: ${processedRaces} races, Skipped: ${skippedRaces}`);
  console.log(`Output: ${output.length} day-venue records → ${OUTPUT_FILE}`);

  // サマリー統計
  const turfDays = output.filter((r) => r.芝馬場差 !== null);
  const dirtDays = output.filter((r) => r.ダート馬場差 !== null);
  if (turfDays.length > 0) {
    const vals = turfDays.map((r) => r.芝馬場差).sort((a, b) => a - b);
    const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    console.log(`芝: ${turfDays.length}日, 平均=${avg}, 最速=${vals[0]}, 最遅=${vals[vals.length - 1]}`);
  }
  if (dirtDays.length > 0) {
    const vals = dirtDays.map((r) => r.ダート馬場差).sort((a, b) => a - b);
    const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    console.log(`ダート: ${dirtDays.length}日, 平均=${avg}, 最速=${vals[0]}, 最遅=${vals[vals.length - 1]}`);
  }
}

main();
