const fs = require("fs");
const path = require("path");

const INDEX_DIR = path.join(__dirname, "..", "race_index");
const OUTPUT_DIR = path.join(__dirname, "..", "docs");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");

const DIRT_BASE_DIST = { 東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700 };
const DIRT_DEFAULT_DIST = 1800;

// 馬場差 → 速度ラベル（2000m換算基準）
function babaLabel(diff) {
  if (diff === null || diff === undefined) return "";
  const abs = Math.abs(diff);
  let label;
  if (abs >= 2.0) label = diff < 0 ? "極速" : "極遅";
  else if (abs >= 1.0) label = diff < 0 ? "速" : "遅";
  else if (abs >= 0.5) label = diff < 0 ? "やや速" : "やや遅";
  else label = "標準";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}(${label})`;
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
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  // カレンダーデータから逆引きマップ構築: "venue_kaisai_day" → "YYYYMMDD"
  const dateMap = {};
  if (fs.existsSync(CALENDAR_FILE)) {
    const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
    for (const entry of calendar) {
      for (const v of entry.venues) {
        const key = `${entry.date.substring(0, 4)}_${v.venue}_${v.kaisai}_${v.day}`;
        dateMap[key] = entry.date;
      }
    }
    console.log(`Calendar: ${Object.keys(dateMap).length} venue-day mappings`);
  }

  // 外部馬場差マップ: "surface_日付_競馬場" → レコード全体
  const extBabaMap = {};
  if (fs.existsSync(EXT_BABA_FILE)) {
    const extData = JSON.parse(fs.readFileSync(EXT_BABA_FILE, "utf-8"));
    for (const e of extData) {
      if (e.芝馬場差 !== null) {
        const key = `芝_${e.日付}_${e.競馬場}`;
        extBabaMap[key] = e;
      }
      if (e.ダート馬場差 !== null) {
        const key = `ダート_${e.日付}_${e.競馬場}`;
        extBabaMap[key] = e;
      }
    }
    console.log(`ExtBabaDiff: ${Object.keys(extBabaMap).length} entries`);
  }

  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`Index files: ${files.length}`);

  // 年ごとにグループ化
  const byYear = {};

  for (const file of files) {
    const raceId = file.replace("index_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(INDEX_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const year = raceId.substring(0, 4);

    const horses = [];
    for (const r of rows) {
      horses.push([
        r["着順"], r["枠番"], r["馬番"], r["馬名"], r["性齢"], r["斤量"],
        r["騎手"], r["タイム"], r["着差"], r["通過"], r["上がり"],
        r["人気"], r["単勝オッズ"],
        r["総合指数"], r["上がり指数"], r["能力指数"],
      ]);
    }

    // 日付逆引き
    const kaisaiNum = parseInt((first["開催"] || "").replace("回", "")) || 0;
    const dayNum = parseInt((first["開催日"] || "").replace("日目", "")) || 0;
    const calKey = `${year}_${first["競馬場名"]}_${kaisaiNum}_${dayNum}`;
    const date = dateMap[calKey] || "";

    // レース番号（raceId末尾2桁）
    const raceNum = parseInt(raceId.substring(10, 12)) || 0;

    // 馬場差ラベル（外部馬場差から距離別対応で生成）
    const surface = first["芝/ダート"] || "";
    let babaSpeed = "";
    if (date) {
      const dateStr = `${date.substring(0,4)}/${date.substring(4,6)}/${date.substring(6,8)}`;
      const extKey = `${surface}_${dateStr}_${first["競馬場名"]}`;
      const extRecord = extBabaMap[extKey];
      if (extRecord) {
        const dist = parseInt(first["距離"]);
        let displayVals = [];

        // レース別馬場差を優先（距離補正済み）
        if (extRecord.レース別馬場差 && extRecord.レース別馬場差[String(raceNum)] !== undefined) {
          displayVals.push(extRecord.レース別馬場差[String(raceNum)]);
        } else if (surface === "ダート") {
          // ダート距離別馬場差がある場合
          if (extRecord.ダート距離別馬場差 && extRecord.ダート距離別馬場差[dist]) {
            displayVals.push(extRecord.ダート距離別馬場差[dist]);
          } else if (extRecord.ダート馬場差 !== null) {
            // 距離別がない場合、全体値で距離補正して表示
            const baseDist = DIRT_BASE_DIST[first["競馬場名"]] || DIRT_DEFAULT_DIST;
            displayVals.push(extRecord.ダート馬場差 * (dist / baseDist));
          }
        } else {
          // 芝：常に距離補正
          if (extRecord.芝馬場差 !== null) {
            displayVals.push(extRecord.芝馬場差 * (dist / 2000));
          }
        }
        // 複数の値がある場合は前後両方表示（例: "-1.9 → -1.6"）
        if (displayVals.length > 0) {
          babaSpeed = displayVals.map(v => babaLabel(v)).join(" → ");
        }
      }
    }

    const race = [
      raceId, year, first["競馬場名"], first["開催"], first["開催日"],
      first["クラス"], first["芝/ダート"], first["距離"],
      first["天候"], first["馬場"], horses, date, raceNum, babaSpeed,
      first["グレード"] || "",    // 14: GRADE
      first["レース名"] || "",    // 15: RACE_NAME
    ];

    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(race);
  }

  // 年ごとにファイル出力
  const years = Object.keys(byYear).sort().reverse();
  for (const year of years) {
    byYear[year].sort((a, b) => {
      const dateA = a[11] || a[0].substring(0, 8);
      const dateB = b[11] || b[0].substring(0, 8);
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return b[12] - a[12]; // race number desc
    });
    const outFile = path.join(OUTPUT_DIR, `data_${year}.json`);
    fs.writeFileSync(outFile, JSON.stringify(byYear[year]), "utf-8");
    const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
    console.log(`  ${year}: ${byYear[year].length} races (${sizeMB}MB)`);
  }

  // 年リストのメタファイル
  const meta = years.map(y => ({ year: y, count: byYear[y].length }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "meta.json"), JSON.stringify(meta), "utf-8");
  console.log(`\nSaved: ${years.length} year files + meta.json`);
}

main();
