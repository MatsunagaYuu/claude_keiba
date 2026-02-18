const fs = require("fs");
const path = require("path");

const BASE_TIMES_FILE = "./base_times.json";
const BABA_DIFF_FILE = "./baba_diff.json";
const RACE_RESULT_DIR = "./race_result";
const OUTPUT_DIR = "./race_index";

// キャリブレーション:
// イクイノックス 2023天皇賞秋 東京芝2000m 1:55.2 → 指数336
// OP良基準: 1:59.32(119.32秒), 基準指数315
// 天皇賞秋2023の馬場差: -0.86秒(全場全距離算出, 速い馬場)
// 補正後基準: 119.32 + (-0.86) = 118.46秒
// 差: 118.46 - 115.2 = 3.26秒 → 21ポイント
// factor_at_2000 = 21 / 3.26 = 6.442
const ANCHOR_INDEX = 315;
const CALIBRATION_FACTOR = 6.442;
const CALIBRATION_DIST = 2000;
// 能力指数 = 総合指数 + 上がり指数 × AGARI_WEIGHT
const AGARI_WEIGHT = 0.5;
// 脚溜め補正: 先頭から1秒後方で待機 → 上がりが約DRAFT_FACTOR秒速くなると仮定
// 後方待機の展開利を割り引くための係数
const DRAFT_FACTOR = 0.6;
// 世代補正: 世代限定レースは古馬混合より能力が低いため基準指数を下げる
// データ分析結果: OP 3歳-7/2歳-12, 1勝 3歳-2/2歳-3
// 世代限定レースは古馬混合より走破タイムが遅い（能力差）ため
// 基準指数を上げて指数を相対的に下げる
const GEN_CORRECTION = {
  OP:     { "3歳": 7, "2歳": 12 },
  "1勝クラス": { "3歳": 2, "2歳": 3 },
};

function detectGeneration(className) {
  if (className.includes("2歳")) return "2歳";
  if (className.includes("3歳") && !className.includes("以上")) return "3歳";
  return "古馬";
}

function distFactor(dist) {
  return CALIBRATION_FACTOR * (CALIBRATION_DIST / parseInt(dist));
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
  // 特別レース名のみの場合（クラス情報なし）はスキップ
  return null;
}

function main() {
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  // キー: "競馬場_距離_クラス"（良馬場基準）
  const baseMap = {};
  for (const bt of baseTimes) {
    const key = `${bt.競馬場}_${bt.距離}_${bt.クラス}`;
    baseMap[key] = bt;
  }

  // 馬場差: キー "年_競馬場_開催_日次"
  const babaDiffs = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
  const babaMap = {};
  for (const bd of babaDiffs) {
    const key = `${bd.年}_${bd.競馬場}_${bd.開催}_${bd.日次}`;
    babaMap[key] = bd;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const raceId = process.argv[2];
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

    if (surface !== "芝") {
      skipped++;
      continue;
    }

    const category = classifyRace(className);
    if (!category) { skipped++; continue; }

    // 良馬場基準タイム
    const btKey = `${venue}_${dist}_${category}`;
    const bt = baseMap[btKey];
    if (!bt) { skipped++; continue; }

    // 世代補正: 世代限定レースの基準指数を下げる
    const gen = detectGeneration(className);
    const genCorr = (GEN_CORRECTION[category] && GEN_CORRECTION[category][gen]) || 0;
    const baseIndex = bt.基準指数 + genCorr;

    // 馬場差
    const rid = file.replace("result_", "").replace(".csv", "");
    const year = rid.substring(0, 4);
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));
    const babaKey = `${year}_${venue}_${kaiNum}_${dayNum}`;
    const bd = babaMap[babaKey];
    // 馬場差を当該距離に変換（baba_diffは2000m換算）
    const babaDiff = bd ? bd.馬場差 * (parseInt(dist) / 2000) : 0;
    if (!bd) noBaba++;

    const factor = distFactor(dist);
    const slope = bt.回帰スロープ || 0;

    // レース全体の先頭馬の前半タイムを算出（脚溜め補正の基準）
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
        indexedRows.push({ ...row, 総合指数: "", 上がり指数: "", 能力指数: "" });
        continue;
      }

      const totalSec = timeToSeconds(row["タイム"]);
      const last3f = parseFloat(row["上がり"]);

      if (!totalSec || !last3f || isNaN(last3f)) {
        indexedRows.push({ ...row, 総合指数: "", 上がり指数: "", 能力指数: "" });
        continue;
      }

      const earlySec = totalSec - last3f;

      // 総合指数: 良基準 + 馬場差補正
      // 馬場差がプラス（遅い馬場）→ 基準タイムを遅くする → 同じタイムでも高指数
      const adjustedBase = bt.基準走破秒 + babaDiff;
      const timeDiff = adjustedBase - totalSec;
      const totalIdx = Math.round(baseIndex + timeDiff * factor);

      // 上がり指数: ペースを考慮した末脚評価 + 脚溜め補正
      const adjustedEarlyBase = bt.基準前半秒 + babaDiff * 0.6; // 馬場差の6割を前半に配分
      const adjustedLast3fBase = bt.基準上がり秒 + babaDiff * 0.4; // 4割を上がりに配分
      const earlyDiff = earlySec - adjustedEarlyBase;
      const expectedLast3f = adjustedLast3fBase + slope * earlyDiff;

      // 脚溜め補正: 先頭から後方にいるほど上がりにペナルティ
      // 先頭馬からの前半差 × DRAFT_FACTOR を上がりに加算（後方ほど不利に補正）
      const positionGap = earlySec - leaderEarly;
      const draftPenalty = positionGap * DRAFT_FACTOR;
      const adjustedLast3f = last3f + draftPenalty;

      const last3fIdx = Math.round((expectedLast3f - adjustedLast3f) * factor);

      // 能力指数: 総合指数 + 上がり指数の比重加算
      const abilityIdx = Math.round(totalIdx + last3fIdx * AGARI_WEIGHT);

      indexedRows.push({
        ...row,
        総合指数: String(totalIdx),
        上がり指数: String(last3fIdx),
        能力指数: String(abilityIdx),
      });
    }

    // CSV出力
    const headers = [
      "競馬場名", "開催", "開催日", "クラス", "芝/ダート", "距離", "天候", "馬場",
      "着順", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手",
      "タイム", "着差", "通過", "上がり", "人気", "単勝オッズ",
      "総合指数", "上がり指数", "能力指数",
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
