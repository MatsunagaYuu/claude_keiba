const fs = require("fs");
const path = require("path");

const INDEX_DIR = "./race_index";
const SHUTUBA_DIR = "./shutuba";
const OUTPUT_DIR = "./docs";
const CALENDAR_FILE = "./kaisai_calendar.json";

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

  // カレンダーデータから逆引きマップ構築
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

  // 1. race_indexから馬名→過去走実績マップを構築
  console.log("Building horse history map from race_index...");
  const horseHistory = {}; // 馬名 → [{date, venue, dist, surface, cond, rank, totalIdx, abilityIdx}, ...]

  const indexFiles = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`  Index files: ${indexFiles.length}`);

  for (const file of indexFiles) {
    const raceId = file.replace("index_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(INDEX_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const year = raceId.substring(0, 4);

    // 日付逆引き
    const kaisaiNum = parseInt((first["開催"] || "").replace("回", "")) || 0;
    const dayNum = parseInt((first["開催日"] || "").replace("日目", "")) || 0;
    const calKey = `${year}_${first["競馬場名"]}_${kaisaiNum}_${dayNum}`;
    const date = dateMap[calKey] || "";

    for (const r of rows) {
      const name = r["馬名"];
      if (!name) continue;
      if (!horseHistory[name]) horseHistory[name] = [];
      horseHistory[name].push({
        date,
        venue: first["競馬場名"],
        dist: first["距離"],
        surface: first["芝/ダート"],
        cond: first["馬場"],
        rank: r["着順"],
        totalIdx: r["総合指数"],
        abilityIdx: r["能力指数"],
      });
    }
  }

  // 各馬の過去走を日付降順でソート
  for (const name in horseHistory) {
    horseHistory[name].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }
  console.log(`  Horses with history: ${Object.keys(horseHistory).length}`);

  // 2. shutubaディレクトリの全CSVを読み込み
  const shutubaFiles = fs.readdirSync(SHUTUBA_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`Shutuba files: ${shutubaFiles.length}`);

  // 開催日ごとにグループ化
  const byDate = {};

  for (const file of shutubaFiles) {
    const raceId = file.replace("shutuba_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(SHUTUBA_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const year = raceId.substring(0, 4);

    // 日付逆引き
    const kaisaiNum = parseInt((first["開催"] || "").replace("回", "")) || 0;
    const dayNum = parseInt((first["開催日"] || "").replace("日目", "")) || 0;
    const calKey = `${year}_${first["競馬場名"]}_${kaisaiNum}_${dayNum}`;
    const date = dateMap[calKey] || "";

    if (!date) {
      console.warn(`  Warning: No date found for ${file} (key: ${calKey})`);
      continue;
    }

    // レース番号（raceId末尾2桁）
    const raceNum = parseInt(raceId.substring(10, 12)) || 0;

    // 馬データ構築
    const horses = [];
    for (const r of rows) {
      const name = r["馬名"];
      // 過去5走取得
      const history = horseHistory[name] || [];
      const past5 = history.slice(0, 5).map((h) => [
        h.date, h.venue, h.dist, h.surface, h.cond, h.rank, h.totalIdx, h.abilityIdx,
      ]);

      horses.push([
        r["枠番"], r["馬番"], r["馬名"], r["性齢"], r["斤量"], r["騎手"],
        past5,
      ]);
    }

    const race = [
      raceId, first["競馬場名"], raceNum, first["クラス"],
      first["芝/ダート"], first["距離"], horses,
    ];

    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(race);
  }

  // 各日付のレースをレース番号順でソート & 出力
  const dates = Object.keys(byDate).sort().reverse();
  for (const date of dates) {
    byDate[date].sort((a, b) => {
      // venue then raceNum
      if (a[1] !== b[1]) return a[1].localeCompare(b[1]);
      return a[2] - b[2];
    });
    const outFile = path.join(OUTPUT_DIR, `shutuba_${date}.json`);
    fs.writeFileSync(outFile, JSON.stringify(byDate[date]), "utf-8");
    const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`  ${date}: ${byDate[date].length} races (${sizeKB}KB)`);
  }

  // メタファイル出力
  const meta = dates.map((d) => ({
    date: d,
    count: byDate[d].length,
  }));
  const metaFile = path.join(OUTPUT_DIR, "shutuba_meta.json");
  fs.writeFileSync(metaFile, JSON.stringify(meta), "utf-8");
  console.log(`\nSaved: ${dates.length} date files + shutuba_meta.json`);
}

main();
