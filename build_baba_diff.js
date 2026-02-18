const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = "./race_result";
const BASE_TIMES_FILE = "./base_times.json";
const OUTPUT_FILE = "./baba_diff.json";

const CALIBRATION_FACTOR = 3.883;
const CALIBRATION_DIST = 2000;

function distFactor(dist) {
  return CALIBRATION_FACTOR * (CALIBRATION_DIST / parseInt(dist));
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
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
  return null;
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
  // 良馬場の基準タイムを読み込み
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const baseMap = {};
  for (const bt of baseTimes) {
    const key = `${bt.競馬場}_${bt.距離}_${bt.クラス}`;
    baseMap[key] = bt;
  }

  const files = fs
    .readdirSync(RACE_RESULT_DIR)
    .filter((f) => f.endsWith(".csv"));

  // 日ごとの偏差を収集: key = "競馬場_開催_日次"
  const dayGroups = {};

  for (const file of files) {
    const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const venue = first["競馬場名"];
    const surface = first["芝/ダート"];
    const dist = first["距離"];
    const className = first["クラス"];
    const kaisai = first["開催"];
    const nichime = first["開催日"];

    if (surface !== "芝") continue;

    const category = classifyRace(className);
    if (!category) continue;

    const btKey = `${venue}_${dist}_${category}`;
    const bt = baseMap[btKey];
    if (!bt) continue;

    // ファイル名からレースIDの年を取得: result_YYYYVVKKDDNN.csv
    const raceId = file.replace("result_", "").replace(".csv", "");
    const year = raceId.substring(0, 4);
    const kaiNum = parseInt(kaisai.replace("回", ""));
    const dayNum = parseInt(nichime.replace("日目", ""));
    const dayKey = `${year}_${venue}_${kaiNum}_${dayNum}`;

    if (!dayGroups[dayKey]) {
      dayGroups[dayKey] = { year: parseInt(year), venue, kai: kaiNum, day: dayNum, deviations: [] };
    }

    // 全完走馬のタイム偏差を収集（距離正規化: 2000m換算秒）
    for (const row of rows) {
      if (!/^\d+$/.test(row["着順"])) continue;
      const totalSec = timeToSeconds(row["タイム"]);
      if (!totalSec) continue;

      // 良馬場基準からの偏差（2000m換算）
      const rawDev = totalSec - bt.基準走破秒;
      const normDev = rawDev * (2000 / parseInt(dist));
      dayGroups[dayKey].deviations.push(normDev);
    }
  }

  // 日ごとの平均偏差（馬場差）を算出
  const babaDiffs = [];
  for (const [key, group] of Object.entries(dayGroups)) {
    if (group.deviations.length < 3) continue; // 最低3頭分

    const avgDev =
      group.deviations.reduce((a, b) => a + b, 0) / group.deviations.length;

    babaDiffs.push({
      年: group.year,
      競馬場: group.venue,
      開催: group.kai,
      日次: group.day,
      馬場差: parseFloat(avgDev.toFixed(2)),
      サンプル数: group.deviations.length,
    });
  }

  // ソート
  babaDiffs.sort(
    (a, b) =>
      a.年 - b.年 || a.競馬場.localeCompare(b.競馬場) || a.開催 - b.開催 || a.日次 - b.日次
  );

  // 7段階分類（絶対閾値）
  // 馬場差は良馬場基準からの偏差(2000m換算秒)。正=遅い、負=速い。
  // 良馬場は馬場差≈0なので基本的に「極速」になる設計。
  const BABA_LABELS = [
    { label: "極速", max: 0.5 },
    { label: "速",   max: 1.0 },
    { label: "稍速", max: 1.5 },
    { label: "標準", max: 2.0 },
    { label: "稍遅", max: 3.0 },
    { label: "遅",   max: 5.0 },
    { label: "極遅", max: Infinity },
  ];

  // 分類を付与
  for (const d of babaDiffs) {
    d.馬場速度 = BABA_LABELS.find((b) => d.馬場差 < b.max).label;
  }
  const labels = BABA_LABELS.map((b) => b.label);

  console.log(`\n=== 馬場差 7段階分類（絶対閾値） ===`);
  console.log("分類    馬場差閾値(2000m換算秒)    該当日数");
  for (let i = 0; i < BABA_LABELS.length; i++) {
    const lo = i === 0 ? -Infinity : BABA_LABELS[i - 1].max;
    const hi = BABA_LABELS[i].max;
    const count = babaDiffs.filter((d) => d.馬場速度 === BABA_LABELS[i].label).length;
    console.log(
      `${BABA_LABELS[i].label.padEnd(6)}  ${lo === -Infinity ? "      " : lo.toFixed(2).padStart(6)} ~ ${hi === Infinity ? "      " : hi.toFixed(2).padStart(6)}    ${String(count).padStart(4)}`
    );
  }

  // 統計
  const allDevs = babaDiffs.map((d) => d.馬場差).sort((a, b) => a - b);
  const n = allDevs.length;
  console.log(`\n全${babaDiffs.length}日`);
  console.log(`馬場差 平均: ${(allDevs.reduce((a, b) => a + b, 0) / n).toFixed(2)}秒`);
  console.log(`馬場差 最速: ${allDevs[0].toFixed(2)}秒, 最遅: ${allDevs[n - 1].toFixed(2)}秒`);

  // サンプル: 天皇賞秋2023
  const tenno = babaDiffs.find(
    (d) => d.競馬場 === "東京" && d.開催 === 4 && d.日次 === 9
  );
  if (tenno) {
    console.log(
      `\n天皇賞秋2023: 馬場差=${tenno.馬場差}秒 → ${tenno.馬場速度}`
    );
  }

  // 出力
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(babaDiffs, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${babaDiffs.length} days)`);
}

main();
