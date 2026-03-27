const fs = require("fs");
const path = require("path");

const NAISEI_MODE = process.argv.includes("--naisei");

const BASE_TIMES_FILE = path.join(__dirname, "..", "base_times.json");
const BABA_DIFF_FILE = path.join(__dirname, "..", "baba_diff.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result_fromDB");
const OUTPUT_DIR = path.join(__dirname, "..", NAISEI_MODE ? "race_index_naisei" : "race_index");

// 外部馬場差のダート基準距離（会場別）
const DIRT_BASE_DIST = {
  東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700,
};
const DIRT_DEFAULT_DIST = 1800;

// スケーリング: イクイノックス2023天皇賞秋キャリブレーション
// 1:55.2, 東京芝2000m 3歳以上OP, 馬場差-2.1秒, 斤量58kg → 指数336
const CALIBRATION_FACTOR = 6.667;
const CALIBRATION_DIST = 2000;

// 年齢クラス別アンカー指数（自前BT + factor=6.667から算出、BT整合）
const CLASS_ANCHOR_TURF = {
  "2歳新馬": 283, "2歳未勝利": 293, "2歳1勝": 299, "2歳OP": 300,
  "3歳新馬": 282, "3歳未勝利": 297, "3歳1勝": 303, "3歳OP": 309,
  "3歳以上1勝": 305, "3歳以上2勝": 307, "3歳以上3勝": 311, "3歳以上OP": 315,
  "4歳以上1勝": 304, "4歳以上2勝": 307, "4歳以上3勝": 311, "4歳以上OP": 315,
};
const CLASS_ANCHOR_DIRT = {
  "2歳新馬": 272, "2歳未勝利": 279, "2歳1勝": 296, "2歳OP": 300,
  "3歳新馬": 271, "3歳未勝利": 283, "3歳1勝": 297, "3歳OP": 305,
  "3歳以上1勝": 298, "3歳以上2勝": 304, "3歳以上3勝": 309, "3歳以上OP": 315,
  "4歳以上1勝": 296, "4歳以上2勝": 304, "4歳以上3勝": 310, "4歳以上OP": 316,
};
function getClassAnchor(surface, ageClass) {
  const tbl = surface === "ダート" ? CLASS_ANCHOR_DIRT : CLASS_ANCHOR_TURF;
  return tbl[ageClass] || 280;
}

// 上がり重み: 芝/ダート × 距離 × 等級で動的に決定
const TURF_AGARI_TABLE = [
  [1200, 0.20], [1400, 0.30], [1600, 0.40], [1800, 0.70],
  [2200, 0.70], [2400, 0.80], [9999, 0.80],
];
const DIRT_RATIO = 0.7;
const GRADE_AGARI_ADJ = { OP: -0.10, "3勝": -0.05, "2勝": 0, "1勝": 0.05 };
function getAgariWeight(surface, dist, ageClass) {
  const d = parseInt(dist);
  let base = 0.5;
  for (const [maxDist, w] of TURF_AGARI_TABLE) {
    if (d <= maxDist) { base = w; break; }
  }
  if (surface === "ダート") base *= DIRT_RATIO;
  // 年齢クラスから等級部分を抽出
  let adj = 0.05; // デフォルト（新馬/未勝利）
  for (const [grade, a] of Object.entries(GRADE_AGARI_ADJ)) {
    if (ageClass.includes(grade)) { adj = a; break; }
  }
  return Math.max(0.05, Math.min(1.0, base + adj));
}

// 斤量補正
const BASE_WEIGHT = 57;
const WEIGHT_FACTOR = 0.2;
// 脚溜め補正
const DRAFT_FACTOR = 0.6;

// 年齢クラス別分類（build_base_times.jsと同じロジック）
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

// 基準タイム取得: 年齢クラス別 → フォールバック（サンプル不足時）
// フォールバック時はマッチしたクラス名も返す（アンカー整合性のため）
const MIN_BT_SAMPLES = 20;
function getBaseTimes(baseMap, surface, venue, dist, ageClass) {
  // 1. 直接マッチ
  const key = `${surface}_${venue}_${dist}_${ageClass}`;
  const bt = baseMap[key];
  if (bt && bt.サンプル数 >= MIN_BT_SAMPLES) return { bt, matchedClass: ageClass };

  // 2. サンプル不足 → 同等級の古馬クラスにフォールバック
  const grade = ageClass.replace(/^(2歳|3歳|3歳以上|4歳以上)/, "");
  const fallbacks = ["3歳以上", "4歳以上"];
  for (const fb of fallbacks) {
    const fbClass = `${fb}${grade}`;
    const fbKey = `${surface}_${venue}_${dist}_${fbClass}`;
    const fbBt = baseMap[fbKey];
    if (fbBt && fbBt.サンプル数 >= MIN_BT_SAMPLES) return { bt: fbBt, matchedClass: fbClass };
  }

  // 3. サンプル不足でもデータがあればそのまま使用
  if (bt) return { bt, matchedClass: ageClass };
  for (const fb of fallbacks) {
    const fbClass = `${fb}${grade}`;
    const fbKey = `${surface}_${venue}_${dist}_${fbClass}`;
    if (baseMap[fbKey]) return { bt: baseMap[fbKey], matchedClass: fbClass };
  }
  return null;
}

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

function main() {
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const baseMap = {};
  for (const bt of baseTimes) {
    const surface = bt["芝/ダート"] || "芝";
    const key = `${surface}_${bt.競馬場}_${bt.距離}_${bt.クラス}`;
    baseMap[key] = bt;
  }

  // コース特性補正: 全コースの上がり標準偏差の平均を算出
  const allStddevs = baseTimes.map(bt => bt.上がり標準偏差).filter(v => v > 0);
  const globalAvgStddev = allStddevs.length > 0
    ? allStddevs.reduce((a, b) => a + b, 0) / allStddevs.length
    : 1;

  // 馬場差: キー "surface_年_競馬場_開催_日次"（従来の算出値、フォールバック用）
  const babaDiffs = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
  const babaMap = {};
  for (const bd of babaDiffs) {
    const surface = bd["芝/ダート"] || "芝";
    const key = `${surface}_${bd.年}_${bd.競馬場}_${bd.開催}_${bd.日次}`;
    babaMap[key] = bd;
  }

  // 馬場差: キー "surface_日付_競馬場" → レコード
  const extBabaMap = {};
  let extBabaCount = 0;
  const babaSourceFile = NAISEI_MODE ? BABA_DIFF_FILE : EXT_BABA_FILE;
  const babaSourceLabel = NAISEI_MODE ? "Internal (naisei)" : "External";
  if (fs.existsSync(babaSourceFile)) {
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
    const extData = JSON.parse(fs.readFileSync(babaSourceFile, "utf-8"));
    for (const e of extData) {
      const venue = e.競馬場;
      // レコード全体を保持（ダート距離別等の情報を保持）
      if (e.芝馬場差 !== null) {
        const key = `芝_${e.日付}_${venue}`;
        extBabaMap[key] = e;
      }
      if (e.ダート馬場差 !== null) {
        const key = `ダート_${e.日付}_${venue}`;
        extBabaMap[key] = e;
      }
      extBabaCount++;
    }
    console.log(`${babaSourceLabel} baba_diff loaded: ${extBabaCount} records`);
    extBabaMap._calDateMap = calDateMap;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const raceId = process.argv.filter(a => !a.startsWith("--"))[2];
  let files;
  if (raceId) {
    const fileName = `result_${raceId}.csv`;
    if (!fs.existsSync(path.join(RACE_RESULT_DIR, fileName))) {
      console.error(`File not found: ${fileName}`);
      process.exit(1);
    }
    files = [fileName];
  } else {
    files = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));
  }

  let processed = 0;
  let skipped = 0;
  let noBaba = 0;
  let btFallbackLogged = new Set();

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) { skipped++; continue; }

    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = first["距離"];
    const className = first["クラス"];
    const kaisai = first["開催"];
    const nichime = first["開催日"];

    if (surface !== "芝" && surface !== "ダート") { skipped++; continue; }

    const ageClass = classifyRace(className);
    if (!ageClass) { skipped++; continue; }

    // 基準タイム取得（年齢クラス別、フォールバックあり）
    const btResult = getBaseTimes(baseMap, surface, venue, dist, ageClass);
    if (!btResult) { skipped++; continue; }
    const { bt, matchedClass } = btResult;

    // フォールバックログ
    if (matchedClass !== ageClass) {
      const fbKey = `${surface}_${venue}_${dist}_${ageClass}`;
      if (!btFallbackLogged.has(fbKey)) {
        console.log(`  BT fallback: ${fbKey} → ${matchedClass} (n=${bt.サンプル数})`);
        btFallbackLogged.add(fbKey);
      }
    }

    // フォールバック時はBTに合わせたアンカーを使用（BT-アンカー整合性）
    const anchorIndex = getClassAnchor(surface, matchedClass);

    // レースID・開催情報
    const rid = file.replace("result_", "").replace(".csv", "");
    const year = rid.substring(0, 4);
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));

    // 馬場差（外部/内製データ優先）
    let babaDiff = null;
    const USE_EXT_BABA = true; // extBabaMap には --naisei 時は内製データが入る
    const calKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    const raceDate = USE_EXT_BABA && extBabaMap._calDateMap && extBabaMap._calDateMap[calKey];
    if (raceDate) {
      const d = parseInt(dist);
      const extKey = `${surface}_${raceDate}_${venue}`;
      const extRecord = extBabaMap[extKey];
      if (extRecord) {
        // レース番号取得（ファイル名末尾2桁）
        const raceNum = parseInt(rid.substring(10, 12));

        // レース別馬場差を優先（距離補正済み）
        if (extRecord.レース別馬場差 && extRecord.レース別馬場差[String(raceNum)] !== undefined) {
          babaDiff = extRecord.レース別馬場差[String(raceNum)];
        } else if (surface === "ダート") {
          // ダート：距離別馬場差が優先
          if (extRecord.ダート距離別馬場差 && extRecord.ダート距離別馬場差[d]) {
            // 距離別がある場合、そのまま使用（既に距離補正済み）
            babaDiff = extRecord.ダート距離別馬場差[d];
          } else if (extRecord.ダート馬場差 !== null) {
            // 距離別がない場合、全体値で距離補正
            const baseDist = DIRT_BASE_DIST[venue] || DIRT_DEFAULT_DIST;
            babaDiff = extRecord.ダート馬場差 * (d / baseDist);
          }
        } else {
          // 芝：常に距離補正（2000m基準）
          if (extRecord.芝馬場差 !== null) {
            babaDiff = extRecord.芝馬場差 * (d / 2000);
          }
        }
      }
    }
    let hasBaba = true;
    if (babaDiff === null) {
      babaDiff = 0;
      hasBaba = false;
      noBaba++;
    }

    const slope = bt.回帰スロープ || 0;
    const courseStddev = bt.上がり標準偏差 || globalAvgStddev;
    const courseFactor = globalAvgStddev / courseStddev;

    // 先頭馬の前半タイム（脚溜め補正の基準）
    let leaderEarly = Infinity;
    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) continue;
      const totalSec = timeToSeconds(row["タイム"]);
      const last3f = parseFloat(row["上がり"]);
      if (totalSec && last3f && !isNaN(last3f)) {
        const early = totalSec - last3f;
        if (early < leaderEarly) leaderEarly = early;
      }
    }

    const indexedRows = [];
    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) {
        indexedRows.push({ ...row, 総合指数: "", 上がり指数: "", 能力指数: "", 参考: "" });
        continue;
      }

      const totalSec = timeToSeconds(row["タイム"]);
      const last3f = parseFloat(row["上がり"]);

      if (!totalSec || !last3f || isNaN(last3f)) {
        indexedRows.push({ ...row, 総合指数: "", 上がり指数: "", 能力指数: "", 参考: "" });
        continue;
      }

      const earlySec = totalSec - last3f;

      // 斤量補正
      const weight = parseFloat(row["斤量"]) || BASE_WEIGHT;
      const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (parseInt(dist) / 2000);

      // 総合指数
      const factor = CALIBRATION_FACTOR * (CALIBRATION_DIST / parseInt(dist));
      const refBaseSec = bt.基準走破秒;
      const adjustedRef = refBaseSec + babaDiff;
      const timeDiff = adjustedRef - totalSec + weightAdj;
      const totalIdx = Math.round(anchorIndex + timeDiff * factor);

      // 上がり指数
      const anchorEarlyBase = bt.基準前半秒 + babaDiff * 0.6;
      const anchorLast3fBase = bt.基準上がり秒 + babaDiff * 0.4;
      const earlyDiff = earlySec - anchorEarlyBase;
      const expectedLast3f = anchorLast3fBase + slope * earlyDiff;

      const positionGap = earlySec - leaderEarly;
      const draftPenalty = positionGap * DRAFT_FACTOR;
      const adjustedLast3f = last3f + draftPenalty;

      const relativeAgari = expectedLast3f - adjustedLast3f;
      const absoluteAgari = anchorLast3fBase - last3f;
      const agariRaw = (absoluteAgari * 0.5 + relativeAgari * 0.5) * courseFactor;

      const agariWeight = getAgariWeight(surface, dist, ageClass);
      const combinedRaw = timeDiff + agariRaw * agariWeight;
      const abilityIdx = Math.round(anchorIndex + combinedRaw * factor);
      const last3fIdx = abilityIdx - totalIdx;

      indexedRows.push({
        ...row,
        総合指数: String(totalIdx),
        上がり指数: String(last3fIdx),
        能力指数: String(abilityIdx),
        参考: hasBaba ? "" : "1",
      });
    }

    // CSV出力
    const headers = [
      "競馬場名", "開催", "開催日", "クラス", "レース名", "グレード", "芝/ダート", "距離", "天候", "馬場",
      "着順", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手",
      "タイム", "着差", "通過", "上がり", "人気", "単勝オッズ",
      "総合指数", "上がり指数", "能力指数", "参考",
    ];

    const csvLines = [headers.join(",")];
    for (const row of indexedRows) {
      const line = headers.map((h) => {
        const val = row[h] || "";
        if (val.includes(",") || val.includes('"')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      });
      csvLines.push(line.join(","));
    }

    const outFile = path.join(OUTPUT_DIR, file.replace("result_", "index_"));
    fs.writeFileSync(outFile, csvLines.join("\n"), "utf-8");
    processed++;
  }

  console.log(`Processed: ${processed}, Skipped: ${skipped}, No baba data: ${noBaba}`);
  if (raceId && processed > 0) {
    const outFile = path.join(OUTPUT_DIR, `index_${raceId}.csv`);
    console.log(`Output: ${outFile}`);
    const result = fs.readFileSync(outFile, "utf-8");
    console.log("\n" + result);
  }
}

main();
