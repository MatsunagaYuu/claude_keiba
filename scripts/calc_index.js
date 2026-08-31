const fs = require("fs");
const path = require("path");
const { parseCSV } = require("./csv_util");

const NAISEI_MODE = process.argv.includes("--naisei");
const NO_CALIB = process.argv.includes("--no-calib");
const V3_MODE = process.argv.includes("--v3");

const BASE_TIMES_FILE = path.join(__dirname, "..", "base_times.json");
const BABA_DIFF_FILE = path.join(__dirname, "..", "baba_diff.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const CALIB_FILE = path.join(__dirname, "..", "venue_calibration.json");
const RACE_EFFECT_CALIB_FILE = path.join(__dirname, "..", "race_effect_calibration.json");
const RACE_RESULT_DIR = path.join(__dirname, "..", "race_result");
// --naisei は馬場差ソースの切替のみ（出力先は常に race_index、切り戻しはフラグを外すだけ）
const outdirIdx = process.argv.indexOf("--outdir");
const OUTPUT_DIR = outdirIdx >= 0
  ? path.join(__dirname, "..", process.argv[outdirIdx + 1])
  : path.join(__dirname, "..", "race_index");

// 外部馬場差のダート距離スケーリング係数（回帰分析による）
// ratio = DIRT_SCALE_A * dist + DIRT_SCALE_B
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

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

  // 会場×路面×距離帯キャリブレーション（venue_calibration.json 無し or --no-calib で現行挙動）
  // 期間別offset: レース年で期間を特定、範囲外は最寄り期間にクランプ
  // 距離帯は build_venue_calibration.js の bandOfDist と一致させること
  const bandOfDist = d => (d <= 1400 ? "短" : d <= 2000 ? "中" : "長");
  let calibPeriods = null;
  if (!NO_CALIB && fs.existsSync(CALIB_FILE)) {
    const calib = JSON.parse(fs.readFileSync(CALIB_FILE, "utf-8"));
    calibPeriods = calib.periods.map(p => {
      const map = {};
      for (const o of p.offsets) map[`${o["芝/ダート"]}_${o.競馬場}_${o.距離帯}`] = o.offset;
      return { from: p.from, to: p.to, map };
    });
    console.log(`Venue calibration loaded: ${calibPeriods.length} periods (generated ${calib.generated})`);
  }

  // --v3: レース効果補正係数（build_race_calibration.js が生成）。無ければ警告してこの補正のみスキップ
  let raceEffectCalib = null;
  if (V3_MODE) {
    if (fs.existsSync(RACE_EFFECT_CALIB_FILE)) {
      const rec = JSON.parse(fs.readFileSync(RACE_EFFECT_CALIB_FILE, "utf-8"));
      raceEffectCalib = rec.jra || null;
      if (raceEffectCalib) console.log(`--v3: race_effect_calibration.json loaded (jra: ${Object.keys(raceEffectCalib).join(", ")})`);
      else console.warn(`--v3: race_effect_calibration.json has no "jra" section. Skipping race-effect correction (agari zero-sum still applied).`);
    } else {
      console.warn(`--v3: ${RACE_EFFECT_CALIB_FILE} not found. Skipping race-effect correction (agari zero-sum still applied).`);
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const allFiles = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));

  // 単一raceId指定（12桁）または --date YYYYMMDD [...] によるフィルタ
  const raceId = process.argv.find(a => !a.startsWith("--") && /^\d{12}$/.test(a));
  const dateArgIdx = process.argv.indexOf("--date");
  const filterDates = dateArgIdx >= 0
    ? process.argv.slice(dateArgIdx + 1).filter(a => /^\d{8}$/.test(a))
    : [];

  let fileEntries; // { file, dir }
  if (raceId) {
    const fileName = `result_${raceId}.csv`;
    if (!fs.existsSync(path.join(RACE_RESULT_DIR, fileName))) {
      console.error(`File not found: ${fileName}`);
      process.exit(1);
    }
    fileEntries = [{ file: fileName, dir: RACE_RESULT_DIR }];
  } else {
    fileEntries = allFiles.map((f) => ({ file: f, dir: RACE_RESULT_DIR }));
  }
  console.log(`Input: ${allFiles.length} files from race_result/`);

  // --date フィルタ: カレンダーからraceIdプレフィックスを生成して絞り込み
  if (filterDates.length > 0 && !raceId) {
    const VENUE_CODE_MAP = {
      "札幌": "01", "函館": "02", "福島": "03", "新潟": "04", "東京": "05",
      "中山": "06", "中京": "07", "京都": "08", "阪神": "09", "小倉": "10",
    };
    const cal = fs.existsSync(CALENDAR_FILE)
      ? JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"))
      : [];
    const prefixes = new Set();
    for (const date of filterDates) {
      const entry = cal.find(e => e.date === date);
      if (!entry) { console.warn(`Warning: Date not in calendar: ${date}`); continue; }
      for (const v of entry.venues) {
        const code = VENUE_CODE_MAP[v.venue];
        if (code) {
          prefixes.add(`${date.slice(0, 4)}${code}${String(v.kaisai).padStart(2, "0")}${String(v.day).padStart(2, "0")}`);
        }
      }
    }
    const before = fileEntries.length;
    fileEntries = fileEntries.filter(({ file }) => prefixes.has(file.replace("result_", "").slice(0, 10)));
    console.log(`Date filter [${filterDates.join(",")}]: ${fileEntries.length}/${before} files`);
  }

  let processed = 0;
  let skipped = 0;
  let noBaba = 0;
  let btFallbackLogged = new Set();

  for (const { file, dir } of fileEntries) {
    const content = fs.readFileSync(path.join(dir, file), "utf-8");
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
    const calKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    // 日付解決はCSVの日付列を優先（開催カレンダーは2018年以降しか無いためフォールバック扱い）
    const csvDateM = (first["日付"] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const raceDate = csvDateM
      ? `${csvDateM[1]}/${csvDateM[2].padStart(2, "0")}/${csvDateM[3].padStart(2, "0")}`
      : (extBabaMap._calDateMap && extBabaMap._calDateMap[calKey]);
    if (raceDate) {
      const d = parseInt(dist);
      const extKey = `${surface}_${raceDate}_${venue}`;
      const extRecord = extBabaMap[extKey];
      if (extRecord) {
        // レース番号取得（ファイル名末尾2桁）
        const raceNum = parseInt(rid.substring(10, 12));

        // レース別馬場差を優先
        // 二階層形式: {"芝": {R: 補正前値}, "ダート": {R: 補正前値}, "芝_1000": {R: 補正前値}, ...}
        // 旧フラット形式: {R: 補正済み実数値} (後方互換)
        if (extRecord.レース別馬場差) {
          const raceMap = extRecord.レース別馬場差;
          const raceNumStr = String(raceNum);
          const distKey = `${surface}_${d}`;
          if (raceMap[distKey]?.[raceNumStr] !== undefined) {
            // 距離別変動（補正前値）→ 距離補正適用
            const raw = raceMap[distKey][raceNumStr];
            babaDiff = surface === "ダート"
              ? raw * (DIRT_SCALE_A * d + DIRT_SCALE_B)
              : raw * (d / 2000);
          } else if (raceMap[surface]?.[raceNumStr] !== undefined) {
            // surface別変動（補正前値）→ 距離補正適用
            const raw = raceMap[surface][raceNumStr];
            babaDiff = surface === "ダート"
              ? raw * (DIRT_SCALE_A * d + DIRT_SCALE_B)
              : raw * (d / 2000);
          } else if (raceMap[raceNumStr] !== undefined) {
            // 旧フラット形式（補正済み）→ そのまま使用
            babaDiff = raceMap[raceNumStr];
          }
        }
        if (babaDiff === null && surface === "ダート") {
          // ダート：距離別馬場差が優先
          if (extRecord.ダート距離別馬場差 && extRecord.ダート距離別馬場差[d]) {
            // 距離別がある場合、そのまま使用（既に距離補正済み）
            babaDiff = extRecord.ダート距離別馬場差[d];
          } else if (extRecord.ダート馬場差 !== null) {
            // 距離別がない場合、全体値で距離補正（回帰フィット係数）
            babaDiff = extRecord.ダート馬場差 * (DIRT_SCALE_A * d + DIRT_SCALE_B);
          }
        } else if (babaDiff === null) {
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

    let calibOffset = 0;
    if (calibPeriods) {
      const y = parseInt(year);
      const pd = calibPeriods.find(p => y >= p.from && y <= p.to)
        || (y < calibPeriods[0].from ? calibPeriods[0] : calibPeriods[calibPeriods.length - 1]);
      calibOffset = pd.map[`${surface}_${venue}_${bandOfDist(parseInt(dist))}`] || 0;
    }

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

    // --v3: レース効果補正（paceDev/raceEff）に使う値。verify_index_health.js と同一定義
    let raceEffV3 = 0;
    let paceDevV3 = 0;
    if (V3_MODE) {
      const scaleV3 = surface === "ダート" ? (DIRT_SCALE_A * parseInt(dist) + DIRT_SCALE_B) : parseInt(dist) / 2000;
      if (leaderEarly !== Infinity) {
        paceDevV3 = (leaderEarly - (bt.基準前半秒 + babaDiff * 0.6)) / scaleV3;
      }
      if (raceDate) {
        const d = parseInt(dist);
        const extKey = `${surface}_${raceDate}_${venue}`;
        const extRecord = extBabaMap[extKey];
        if (extRecord) {
          const raceNumStr = String(parseInt(rid.substring(10, 12)));
          const dayVal = surface === "芝" ? extRecord.芝馬場差 : extRecord.ダート馬場差;
          let raceBaba = null;
          if (extRecord.レース別馬場差 && typeof extRecord.レース別馬場差[raceNumStr] === "number") {
            raceBaba = extRecord.レース別馬場差[raceNumStr];
          }
          if (raceBaba !== null && dayVal !== null && dayVal !== undefined) {
            raceEffV3 = raceBaba / scaleV3 - dayVal;
          }
        }
      }
    }

    // --v3: 補正pt = gamma*clip(paceDev,±3) + kappa*raceEff（hasBabaのレースのみ、総合・能力とも同額を丸め前に加算）
    let correctionPt = 0;
    if (V3_MODE && hasBaba && raceEffectCalib) {
      const c = raceEffectCalib[surface];
      if (c) {
        const clippedPace = Math.max(-3, Math.min(3, paceDevV3));
        correctionPt = c.gamma * clippedPace + c.kappa * raceEffV3;
      }
    }

    // 1パス目: 完走馬の中間値を算出（--v3の上がりゼロサム化に必要なレース内平均を先に求める）
    const rowCalc = [];
    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) { rowCalc.push({ valid: false, row }); continue; }

      const totalSec = timeToSeconds(row["タイム"]);
      const last3f = parseFloat(row["上がり"]);
      if (!totalSec || !last3f || isNaN(last3f)) { rowCalc.push({ valid: false, row }); continue; }

      const earlySec = totalSec - last3f;

      // 斤量補正
      const weight = parseFloat(row["斤量"]) || BASE_WEIGHT;
      const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (parseInt(dist) / 2000);

      // 総合指数
      const factor = CALIBRATION_FACTOR * (CALIBRATION_DIST / parseInt(dist));
      const refBaseSec = bt.基準走破秒;
      const adjustedRef = refBaseSec + babaDiff;
      const timeDiff = adjustedRef - totalSec + weightAdj;

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
      const agariRaw = (absoluteAgari * 0.2 + relativeAgari * 0.8) * courseFactor;

      const agariWeight = getAgariWeight(surface, dist, ageClass);
      const gi = agariRaw * agariWeight;

      rowCalc.push({ valid: true, row, factor, timeDiff, gi });
    }

    // レース内の g_i = agariRaw*agariWeight の平均（--v3のみ使用。完走1頭ならgi-ḡ=0）
    let gBar = 0;
    if (V3_MODE) {
      const validGi = rowCalc.filter(r => r.valid).map(r => r.gi);
      if (validGi.length) gBar = validGi.reduce((a, b) => a + b, 0) / validGi.length;
    }

    // 2パス目: 総合・能力指数を確定
    const indexedRows = [];
    for (const rc of rowCalc) {
      if (!rc.valid) {
        indexedRows.push({ ...rc.row, 総合指数: "", 上がり指数: "", 能力指数: "", 参考: "" });
        continue;
      }
      const { row, factor, timeDiff, gi } = rc;
      const totalIdx = Math.round(anchorIndex + timeDiff * factor - calibOffset + correctionPt);
      const combinedRaw = V3_MODE ? (timeDiff + (gi - gBar)) : (timeDiff + gi);
      const abilityIdx = Math.round(anchorIndex + combinedRaw * factor - calibOffset + correctionPt);
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
      "競馬場名", "開催", "開催日", "クラス", "レース名", "グレード", "芝/ダート", "距離", "天候", "馬場", "日付",
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
