const fs = require("fs");
const path = require("path");

const INDEX_DIR = path.join(__dirname, "..", "race_index");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const BASE_TIMES_FILE = path.join(__dirname, "..", "base_times.json");
const EXT_BABA_FILE = path.join(__dirname, "..", "external_baba_diff.json");

const DIRT_BASE_DIST = { 東京: 1600, 札幌: 1700, 函館: 1700, 小倉: 1700 };
const DIRT_DEFAULT_DIST = 1800;

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
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error("Usage: node horse_history.js <馬名|部分一致>");
    console.error("  e.g. node horse_history.js ドウデュース");
    console.error("  e.g. node horse_history.js リバティ  (部分一致で検索)");
    process.exit(1);
  }

  // カレンダーから日付逆引きマップ
  const dateMap = {};
  const calDateMap = {};
  if (fs.existsSync(CALENDAR_FILE)) {
    const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
    for (const entry of calendar) {
      for (const v of entry.venues) {
        const key = `${entry.date.substring(0, 4)}_${v.venue}_${v.kaisai}_${v.day}`;
        dateMap[key] = entry.date;
        const dateStr = `${entry.date.substring(0,4)}/${entry.date.substring(4,6)}/${entry.date.substring(6,8)}`;
        calDateMap[key] = dateStr;
      }
    }
  }

  // 基準タイム
  const baseMap = {};
  if (fs.existsSync(BASE_TIMES_FILE)) {
    const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
    for (const bt of baseTimes) {
      const surface = bt["芝/ダート"] || "芝";
      const key = `${surface}_${bt.競馬場}_${bt.距離}_${bt.クラス}`;
      baseMap[key] = bt;
    }
  }

  // 外部馬場差
  const extBabaMap = {};
  if (fs.existsSync(EXT_BABA_FILE)) {
    const extData = JSON.parse(fs.readFileSync(EXT_BABA_FILE, "utf-8"));
    for (const e of extData) {
      if (e.芝馬場差 !== null) extBabaMap[`芝_${e.日付}_${e.競馬場}`] = e.芝馬場差;
      if (e.ダート馬場差 !== null) extBabaMap[`ダート_${e.日付}_${e.競馬場}`] = e.ダート馬場差;
    }
  }

  // クラス分類（calc_index.jsと同じ）
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

  function getBaseTimes(surface, venue, dist, ageClass) {
    const key = `${surface}_${venue}_${dist}_${ageClass}`;
    const bt = baseMap[key];
    if (bt && bt.サンプル数 >= 20) return bt;
    const grade = ageClass.replace(/^(2歳|3歳|3歳以上|4歳以上)/, "");
    for (const fb of ["3歳以上", "4歳以上"]) {
      const fbKey = `${surface}_${venue}_${dist}_${fb}${grade}`;
      const fbBt = baseMap[fbKey];
      if (fbBt && fbBt.サンプル数 >= 20) return fbBt;
    }
    if (bt) return bt;
    for (const fb of ["3歳以上", "4歳以上"]) {
      const fbKey = `${surface}_${venue}_${dist}_${fb}${grade}`;
      if (baseMap[fbKey]) return baseMap[fbKey];
    }
    return null;
  }

  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith(".csv"));
  const results = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(INDEX_DIR, file), "utf-8");
    const rows = parseCSV(content);
    if (rows.length === 0) continue;

    const first = rows[0];
    const raceId = file.replace("index_", "").replace(".csv", "");
    const year = raceId.substring(0, 4);
    const kaisaiNum = parseInt((first["開催"] || "").replace("回", "")) || 0;
    const dayNum = parseInt((first["開催日"] || "").replace("日目", "")) || 0;
    const calKey = `${year}_${first["競馬場名"]}_${kaisaiNum}_${dayNum}`;
    const date = dateMap[calKey] || "";

    // 馬場差・基準タイム取得
    const surface = first["芝/ダート"];
    const venue = first["競馬場名"];
    const dist = first["距離"];
    const ageClass = classifyRace(first["クラス"]);

    let babaDiff = null;
    const raceDate = calDateMap[calKey];
    if (raceDate) {
      const extKey = `${surface}_${raceDate}_${venue}`;
      if (extBabaMap[extKey] !== undefined) {
        const extBaba = extBabaMap[extKey];
        const d = parseInt(dist);
        if (surface === "ダート") {
          const baseDist = DIRT_BASE_DIST[venue] || DIRT_DEFAULT_DIST;
          babaDiff = extBaba * (d / baseDist);
        } else {
          babaDiff = extBaba * (d / 2000);
        }
      }
    }

    let btSec = null;
    let btFallback = false;
    if (ageClass) {
      const bt = getBaseTimes(surface, venue, dist, ageClass);
      if (bt) {
        btSec = bt.基準走破秒;
        btFallback = bt.クラス !== ageClass;
      }
    }

    for (const row of rows) {
      if (row["馬名"].includes(query)) {
        results.push({
          date,
          raceId,
          venue,
          surface,
          dist,
          cond: first["馬場"],
          class: first["クラス"],
          name: row["馬名"],
          rank: row["着順"],
          waku: row["枠番"],
          umaban: row["馬番"],
          weight: row["斤量"],
          jockey: row["騎手"],
          time: row["タイム"],
          last3f: row["上がり"],
          pop: row["人気"],
          totalIdx: row["総合指数"],
          agariIdx: row["上がり指数"],
          abilityIdx: row["能力指数"],
          ref: row["参考"] === "1",
          babaDiff,
          btSec,
          btFallback,
        });
      }
    }
  }

  if (results.length === 0) {
    console.error(`"${query}" に一致する馬が見つかりません`);
    process.exit(1);
  }

  // 馬名ごとにグループ化
  const byHorse = {};
  for (const r of results) {
    if (!byHorse[r.name]) byHorse[r.name] = [];
    byHorse[r.name].push(r);
  }

  // 各馬を日付順ソート
  for (const name of Object.keys(byHorse)) {
    byHorse[name].sort((a, b) => a.date.localeCompare(b.date));
  }

  const horses = Object.keys(byHorse).sort();
  if (horses.length > 1) {
    console.log(`${horses.length}頭がヒット: ${horses.join(", ")}\n`);
  }

  for (const name of horses) {
    const runs = byHorse[name];
    console.log(`=== ${name} (${runs.length}走) ===`);
    console.log(
      "日付       場所  芝ダ  距離   馬場  クラス                着順  斤量  騎手         タイム    上3F  人  総合  上がり  能力  馬場差  基準T   FB"
    );
    console.log("-".repeat(155));

    for (const r of runs) {
      const surf = r.surface === "ダート" ? "ダ" : r.surface;
      const cls = r.class.substring(0, 18).padEnd(18);
      const baba = r.babaDiff !== null ? (r.babaDiff >= 0 ? "+" : "") + r.babaDiff.toFixed(1) : "  -  ";
      const btStr = r.btSec !== null ? r.btSec.toFixed(1) : "  -  ";
      const fbStr = r.btFallback ? "*" : " ";
      const refStr = r.ref ? "(参考)" : "      ";
      console.log(
        `${r.date}  ${r.venue.padEnd(3)} ${surf.padEnd(2)}  ${r.dist.padStart(4)}m  ${r.cond.padEnd(2)}  ${cls}  ${r.rank.padStart(2)}着  ${r.weight.padStart(4)}  ${r.jockey.padEnd(10)}  ${r.time.padStart(7)}  ${r.last3f.padStart(4)}  ${r.pop.padStart(2)}  ${r.totalIdx.padStart(4)}  ${r.agariIdx.padStart(4)}  ${r.abilityIdx.padStart(4)}  ${baba.padStart(5)}  ${btStr.padStart(6)}  ${fbStr} ${refStr}`
      );
    }

    // 統計
    const valid = runs.filter((r) => r.totalIdx && r.abilityIdx);
    if (valid.length > 0) {
      const totals = valid.map((r) => parseInt(r.totalIdx));
      const abilities = valid.map((r) => parseInt(r.abilityIdx));
      const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
      const max = (arr) => Math.max(...arr);
      console.log("-".repeat(130));
      console.log(
        `  総合指数: avg=${avg(totals)} max=${max(totals)}  能力指数: avg=${avg(abilities)} max=${max(abilities)}  (${valid.length}走)`
      );
    }
    console.log("");
  }
}

main();
