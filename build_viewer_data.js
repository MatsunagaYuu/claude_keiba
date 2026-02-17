const fs = require("fs");
const path = require("path");

const INDEX_DIR = "./race_index";
const OUTPUT_DIR = "./docs";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "data.json");

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

  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`Index files: ${files.length}`);

  const races = [];

  for (const file of files) {
    const raceId = file.replace("index_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(INDEX_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const year = raceId.substring(0, 4);

    // 短縮キーでデータ量削減
    const horses = [];
    for (const r of rows) {
      horses.push([
        r["着順"], r["枠番"], r["馬番"], r["馬名"], r["性齢"], r["斤量"],
        r["騎手"], r["タイム"], r["着差"], r["通過"], r["上がり"],
        r["人気"], r["単勝オッズ"],
        r["総合指数"], r["上がり指数"], r["能力指数"],
      ]);
    }

    races.push([
      raceId, year, first["競馬場名"], first["開催"], first["開催日"],
      first["クラス"], first["芝/ダート"], first["距離"],
      first["天候"], first["馬場"], horses,
    ]);
  }

  // レースIDでソート（新しい順）
  // 配列形式: [0]=raceId でソート（新しい順）
  races.sort((a, b) => b[0].localeCompare(a[0]));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(races), "utf-8");
  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`Saved: ${OUTPUT_FILE} (${races.length} races, ${sizeMB}MB)`);
}

main();
