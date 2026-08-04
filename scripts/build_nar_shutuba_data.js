const fs = require("fs");
const path = require("path");
const { parseCSV } = require("./csv_util");

const INDEX_DIR = path.join(__dirname, "..", "nar_race_index");
const SHUTUBA_DIR = path.join(__dirname, "..", "nar_shutuba");
const OUTPUT_DIR = path.join(__dirname, "..", "docs");
const BABA_DIFF_FILE = path.join(__dirname, "..", "nar_baba_diff.json");

function timeToSec(t) {
  if (!t) return null;
  const m = t.match(/^(\d+):(\d+\.\d+)$/);
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2]);
  return null;
}

function babaLabel(diff) {
  if (diff === null || diff === undefined) return "";
  const abs = Math.abs(diff);
  let label;
  if (abs >= 1.5) label = diff < 0 ? "極速" : "極遅";
  else if (abs >= 0.8) label = diff < 0 ? "速" : "遅";
  else if (abs >= 0.4) label = diff < 0 ? "やや速" : "やや遅";
  else label = "標準";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}(${label})`;
}


// race_idから日付(YYYY/MM/DD)を抽出
function raceIdToDate(raceId) {
  const year = raceId.substring(0, 4);
  const mm = raceId.substring(6, 8);
  const dd = raceId.substring(8, 10);
  return `${year}/${mm}/${dd}`;
}

// race_idから日付(YYYYMMDD)を抽出
function raceIdToDate8(raceId) {
  return raceId.substring(0, 4) + raceId.substring(6, 10);
}

function main() {
  const dateArg = process.argv[2];
  if (!dateArg || !/^\d{8}$/.test(dateArg)) {
    console.error("Usage: node build_nar_shutuba_data.js YYYYMMDD");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  // 馬場差読み込み
  const babaMap = {};
  if (fs.existsSync(BABA_DIFF_FILE)) {
    const babaDiff = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
    for (const b of babaDiff) babaMap[b.日付] = b;
  }

  // 1. race_indexから馬名→過去走マップ構築
  console.log("Building horse history from nar_race_index...");
  const horseHistory = {};

  const indexFiles = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith(".csv"));
  console.log(`  Index files: ${indexFiles.length}`);

  for (const file of indexFiles) {
    const raceId = file.replace("index_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(INDEX_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const date = raceIdToDate8(raceId);
    const dateSlash = raceIdToDate(raceId);

    // 馬場差ラベル（nar_baba_diff.json はALS内製・JRA互換形式）
    let babaSpeed = "";
    const baba = babaMap[dateSlash];
    if (baba && baba.ダート馬場差 !== null && baba.ダート馬場差 !== undefined) {
      babaSpeed = babaLabel(baba.ダート馬場差);
    }

    // 勝ち馬と2着馬
    const winnerRow = rows.find((r) => r["着順"] === "1");
    const secondRow = rows.find((r) => r["着順"] === "2");

    for (const r of rows) {
      const name = r["馬名"];
      if (!name) continue;
      if (!horseHistory[name]) horseHistory[name] = [];

      const isWinner = r["着順"] === "1";
      const refRow = isWinner ? secondRow : winnerRow;

      // タイム差
      let margin = "";
      const thisTime = timeToSec(r["タイム"]);
      const refTime = refRow ? timeToSec(refRow["タイム"]) : null;
      if (thisTime !== null && refTime !== null) {
        const diff = thisTime - refTime;
        margin = (diff > 0 ? "+" : "") + diff.toFixed(1);
      }

      horseHistory[name].push({
        raceId,
        date,
        venue: first["競馬場名"],
        dist: first["距離"],
        surface: first["芝/ダート"],
        cond: first["馬場"],
        rank: r["着順"],
        totalIdx: r["総合指数"],
        time: r["タイム"],
        last3f: r["上がり"],
        babaSpeed,
        jockey: r["騎手"] || "",
        weight: r["斤量"] || "",
        gate: r["枠番"] || "",
        pop: r["人気"] || "",
        refHorse: refRow ? refRow["馬名"] : "",
        margin,
      });
    }
  }

  // 日付降順ソート
  for (const name in horseHistory) {
    horseHistory[name].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }
  console.log(`  Horses with history: ${Object.keys(horseHistory).length}`);

  // 2. 出馬表CSV読み込み（指定日付のみ）
  const shutubaFiles = fs.readdirSync(SHUTUBA_DIR)
    .filter((f) => f.endsWith(".csv") && f.includes(dateArg.substring(0, 4) + "30" + dateArg.substring(4)));
  console.log(`Shutuba files for ${dateArg}: ${shutubaFiles.length}`);

  if (shutubaFiles.length === 0) {
    // ファイル名からdate部分を柔軟にマッチ
    const allFiles = fs.readdirSync(SHUTUBA_DIR).filter((f) => f.endsWith(".csv"));
    const matched = allFiles.filter((f) => {
      const id = f.replace("shutuba_", "").replace(".csv", "");
      return raceIdToDate8(id) === dateArg;
    });
    if (matched.length > 0) {
      shutubaFiles.push(...matched);
      console.log(`  (matched by date extraction: ${matched.length} files)`);
    }
  }

  const races = [];
  for (const file of shutubaFiles.sort()) {
    const raceId = file.replace("shutuba_", "").replace(".csv", "");
    const content = fs.readFileSync(path.join(SHUTUBA_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const raceNum = parseInt(raceId.substring(10, 12)) || 0;

    const horses = [];
    for (const r of rows) {
      const name = r["馬名"];
      const history = horseHistory[name] || [];
      const past5 = history.slice(0, 5).map((h) => [
        h.date, h.venue, h.dist, h.surface, h.cond, h.rank, h.totalIdx, "",
        h.babaSpeed, h.time, h.last3f, h.raceId, "", "",
        h.jockey || "", h.weight || "", h.gate || "", h.pop || "",
        h.refHorse || "", h.margin || "",
      ]);

      horses.push([
        r["枠番"], r["馬番"], r["馬名"], r["性齢"], r["斤量"], r["騎手"],
        past5,
      ]);
    }

    races.push([
      raceId, first["競馬場名"], raceNum, first["クラス"],
      first["芝/ダート"], first["距離"], horses,
    ]);
  }

  // レース番号順ソート
  races.sort((a, b) => a[2] - b[2]);

  const outFile = path.join(OUTPUT_DIR, `nar_shutuba_${dateArg}.json`);
  fs.writeFileSync(outFile, JSON.stringify(races), "utf-8");
  const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`\nSaved: ${outFile} (${races.length} races, ${sizeKB}KB)`);
}

main();
