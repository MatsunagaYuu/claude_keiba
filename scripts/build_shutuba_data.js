const fs = require("fs");
const path = require("path");

const INDEX_DIR = path.join(__dirname, "..", "race_index");
const SHUTUBA_DIR = path.join(__dirname, "..", "shutuba");
const OUTPUT_DIR = path.join(__dirname, "..", "docs");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");

const DIRT_BASE_DIST = { 東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700 };
const DIRT_DEFAULT_DIST = 1800;

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

  // 1. race_indexから馬名→過去走実績マップを構築
  console.log("Building horse history map from race_index...");
  const horseHistory = {};

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
        if (surface === "ダート") {
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

    for (const r of rows) {
      const name = r["馬名"];
      if (!name) continue;
      if (!horseHistory[name]) horseHistory[name] = [];
      horseHistory[name].push({
        raceId,
        date,
        venue: first["競馬場名"],
        dist: first["距離"],
        surface: first["芝/ダート"],
        cond: first["馬場"],
        rank: r["着順"],
        totalIdx: r["総合指数"],
        abilityIdx: r["能力指数"],
        time: r["タイム"],
        last3f: r["上がり"],
        babaSpeed,
        passing: r["通過"],
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
        h.babaSpeed, h.time, h.last3f, h.raceId, h.passing,
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
