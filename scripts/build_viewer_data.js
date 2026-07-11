const fs = require("fs");
const path = require("path");

const INDEX_DIR = path.join(__dirname, "..", "race_index");
const OUTPUT_DIR = path.join(__dirname, "..", "docs");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const BABA_DIFF_FILE = path.join(__dirname, "..", "baba_diff.json");

// 外部馬場差のダート距離スケーリング係数（回帰分析による）
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

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

  // 内製馬場差マップ: "surface_日付_競馬場" → レコード全体
  const babaMap = {};
  if (fs.existsSync(BABA_DIFF_FILE)) {
    const babaData = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
    for (const e of babaData) {
      if (e.芝馬場差 !== null) {
        const key = `芝_${e.日付}_${e.競馬場}`;
        babaMap[key] = e;
      }
      if (e.ダート馬場差 !== null) {
        const key = `ダート_${e.日付}_${e.競馬場}`;
        babaMap[key] = e;
      }
    }
    console.log(`BabaDiff (naisei): ${Object.keys(babaMap).length} entries`);
  }

  // --year YYYY [...] フィルタ: 指定年のファイルのみ処理
  const yearArgIdx = process.argv.indexOf("--year");
  const filterYears = new Set(yearArgIdx >= 0
    ? process.argv.slice(yearArgIdx + 1).filter(a => /^\d{4}$/.test(a))
    : []);

  // --merge: 既存 data_YYYY.json に差分マージ（GitHub Actions用）
  const mergeMode = process.argv.includes("--merge");

  const files = fs.readdirSync(INDEX_DIR)
    .filter(f => f.endsWith(".csv"))
    .filter(f => !filterYears.size || filterYears.has(f.slice(6, 10)));
  console.log(`Index files: ${files.length}${filterYears.size ? ` (year filter: ${[...filterYears].join(",")})` : ""}${mergeMode ? " [merge mode]" : ""}`);

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
        r["参考"] || "",  // 16: REF
      ]);
    }

    // 日付逆引き
    const kaisaiNum = parseInt((first["開催"] || "").replace("回", "")) || 0;
    const dayNum = parseInt((first["開催日"] || "").replace("日目", "")) || 0;
    const calKey = `${year}_${first["競馬場名"]}_${kaisaiNum}_${dayNum}`;
    const date = dateMap[calKey] || "";

    // レース番号（raceId末尾2桁）
    const raceNum = parseInt(raceId.substring(10, 12)) || 0;

    // 馬場差ラベル（内製 baba_diff.json から距離別対応で生成）
    // 日付解決は CSV の日付列を優先（kaisai_calendar は 2018+ しか無いので pre-2018 分をカバー）
    const surface = first["芝/ダート"] || "";
    let babaSpeed = "";
    const csvDateM = (first["日付"] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const babaDateStr = csvDateM
      ? `${csvDateM[1]}/${csvDateM[2].padStart(2, "0")}/${csvDateM[3].padStart(2, "0")}`
      : (date ? `${date.substring(0,4)}/${date.substring(4,6)}/${date.substring(6,8)}` : "");
    if (babaDateStr) {
      const babaKey = `${surface}_${babaDateStr}_${first["競馬場名"]}`;
      const babaRecord = babaMap[babaKey];
      if (babaRecord) {
        const dist = parseInt(first["距離"]);
        let displayVals = [];

        // レース別馬場差を優先
        // 二階層形式: {"芝": {R: 補正前値}, "ダート": {R: 補正前値}, "芝_1000": {R: 補正前値}, ...}
        // 旧フラット形式: {R: 補正済み実数値} (後方互換・内製v2の現行フォーマット)
        if (babaRecord.レース別馬場差) {
          const raceMap = babaRecord.レース別馬場差;
          const raceNumStr = String(raceNum);
          const distKey = `${surface}_${dist}`;
          if (raceMap[distKey]?.[raceNumStr] !== undefined) {
            const raw = raceMap[distKey][raceNumStr];
            displayVals.push(surface === "ダート"
              ? raw * (DIRT_SCALE_A * dist + DIRT_SCALE_B)
              : raw * (dist / 2000));
          } else if (raceMap[surface]?.[raceNumStr] !== undefined) {
            const raw = raceMap[surface][raceNumStr];
            displayVals.push(surface === "ダート"
              ? raw * (DIRT_SCALE_A * dist + DIRT_SCALE_B)
              : raw * (dist / 2000));
          } else if (raceMap[raceNumStr] !== undefined) {
            displayVals.push(raceMap[raceNumStr]);
          }
        }
        if (displayVals.length === 0 && surface === "ダート") {
          // ダート距離別馬場差がある場合
          if (babaRecord.ダート距離別馬場差 && babaRecord.ダート距離別馬場差[dist]) {
            displayVals.push(babaRecord.ダート距離別馬場差[dist]);
          } else if (babaRecord.ダート馬場差 !== null) {
            // 距離別がない場合、全体値で距離補正（回帰フィット係数）
            displayVals.push(babaRecord.ダート馬場差 * (DIRT_SCALE_A * dist + DIRT_SCALE_B));
          }
        } else if (displayVals.length === 0) {
          // 芝：常に距離補正
          if (babaRecord.芝馬場差 !== null) {
            displayVals.push(babaRecord.芝馬場差 * (dist / 2000));
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
  const finalCounts = {};
  for (const year of years) {
    let races;
    const outFile = path.join(OUTPUT_DIR, `data_${year}.json`);
    if (mergeMode && fs.existsSync(outFile)) {
      const existing = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      const raceMap = new Map(existing.map(r => [r[0], r]));
      for (const race of byYear[year]) raceMap.set(race[0], race);
      races = [...raceMap.values()];
    } else {
      races = byYear[year];
    }
    races.sort((a, b) => {
      const dateA = a[11] || a[0].substring(0, 8);
      const dateB = b[11] || b[0].substring(0, 8);
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return b[12] - a[12]; // race number desc
    });
    fs.writeFileSync(outFile, JSON.stringify(races), "utf-8");
    const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
    console.log(`  ${year}: ${races.length} races (${sizeMB}MB)`);
    finalCounts[year] = races.length;
  }

  // meta.json: フィルタ/マージ時は既存ファイルとマージして全年分を保持
  const metaFile = path.join(OUTPUT_DIR, "meta.json");
  let meta;
  if ((filterYears.size || mergeMode) && fs.existsSync(metaFile)) {
    const existing = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
    const metaMap = new Map(existing.map(e => [e.year, e]));
    for (const y of years) metaMap.set(y, { year: y, count: finalCounts[y] });
    meta = [...metaMap.keys()].sort().reverse().map(y => metaMap.get(y));
  } else {
    meta = years.map(y => ({ year: y, count: finalCounts[y] }));
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta), "utf-8");
  console.log(`\nSaved: ${years.length} year files + meta.json`);
}

main();
