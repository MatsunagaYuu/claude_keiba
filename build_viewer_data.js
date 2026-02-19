const fs = require("fs");
const path = require("path");

const INDEX_DIR = "./race_index";
const OUTPUT_DIR = "./docs";
const CALENDAR_FILE = "./kaisai_calendar.json";
const BABA_DIFF_FILE = "./baba_diff.json";

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

  // 馬場速度マップ: "年_競馬場_開催_日次" → 馬場速度
  const babaSpeedMap = {};
  if (fs.existsSync(BABA_DIFF_FILE)) {
    const babaDiffs = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
    for (const bd of babaDiffs) {
      const key = `${bd.年}_${bd.競馬場}_${bd.開催}_${bd.日次}`;
      babaSpeedMap[key] = bd.馬場速度 || "";
    }
    console.log(`BabaDiff: ${Object.keys(babaSpeedMap).length} entries`);
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

    // 馬場速度
    const babaSpeed = babaSpeedMap[calKey] || "";

    const race = [
      raceId, year, first["競馬場名"], first["開催"], first["開催日"],
      first["クラス"], first["芝/ダート"], first["距離"],
      first["天候"], first["馬場"], horses, date, raceNum, babaSpeed,
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
