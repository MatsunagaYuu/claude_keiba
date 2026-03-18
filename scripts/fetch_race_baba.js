// レース別馬場差のインクリメンタル取得スクリプト
// 既存 external_baba_diff.json を読み込み、変動ありかつレース別馬場差未取得のレコードのみ処理
// 定期的に保存するため、中断しても再開可能
//
// Usage: node scripts/fetch_race_baba.js [yearFrom] [yearTo]
//   デフォルト: 2026 → 2019（降順）

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cheerio = require("cheerio");

const DATA_FILE = path.join(__dirname, "..", "external_baba_diff.json");

const VENUES = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟",
  "05": "東京", "06": "中山", "07": "中京", "08": "京都",
  "09": "阪神", "10": "小倉",
};
const VENUE_TO_CODE = {};
for (const [code, name] of Object.entries(VENUES)) {
  VENUE_TO_CODE[name] = code;
}

function parseBabaDiff(str) {
  if (!str || str.trim() === "---" || str.trim() === "") return null;
  let s = str.trim().replace(/±/g, "").replace(/\+/g, "");
  if (s.includes("→") || s.includes("～")) {
    const parts = s.split(/[→～]/).map((p) => p.trim());
    s = parts[parts.length - 1];
  }
  const val = parseFloat(s);
  return isNaN(val) ? null : val;
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function scrapeRaceBaba(year, dateStr, jyoCode) {
  const day = dateStr.replace(/\//g, "-");
  const url = `https://ittai.net/RK/time_analysis.php?year=${year}&day=${day}&jyo=${parseInt(jyoCode)}`;
  const tmpFile = `/tmp/race_baba_${jyoCode}_${day}.html`;

  try {
    const code = execSync(
      `curl -s -o "${tmpFile}" -w "%{http_code}" "${url}"`,
      { timeout: 20000 }
    ).toString().trim();

    if (code !== "200") {
      console.error(`  HTTP ${code}: ${url}`);
      return null;
    }
  } catch (e) {
    console.error(`  Fetch error: ${url} - ${e.message}`);
    return null;
  }

  try {
    execSync(`iconv -f SHIFT_JIS -t UTF-8 "${tmpFile}" > "${tmpFile}.utf8" && mv "${tmpFile}.utf8" "${tmpFile}"`);
  } catch {
    // iconv失敗時はそのまま読む
  }
  const html = fs.readFileSync(tmpFile, "utf-8");
  const $ = cheerio.load(html);

  const raceBaba = {};
  $("table.table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 12) return;
    const rText = $(tds[0]).text().trim();
    const rMatch = rText.match(/^(\d+)R$/);
    if (!rMatch) return;
    const raceNum = rMatch[1];
    const babaDiffText = $(tds[11]).text().trim();
    const val = parseBabaDiff(babaDiffText);
    if (val !== null) {
      raceBaba[raceNum] = val;
    }
  });

  return Object.keys(raceBaba).length > 0 ? raceBaba : null;
}

function main() {
  const yearFrom = parseInt(process.argv[2]) || 2026;
  const yearTo = parseInt(process.argv[3]) || 2019;

  // 既存データ読み込み
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }
  const allData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`Loaded: ${allData.length} records`);

  // 変動ありかつレース別馬場差未取得のレコードを抽出
  const targets = allData.filter(r => {
    const hasVariation = r.芝馬場差変動前 !== null || r.ダート馬場差変動前 !== null;
    return hasVariation && !r.レース別馬場差;
  });

  // 年でグループ化（降順処理のため）
  const byYear = {};
  for (const r of targets) {
    const y = r.年;
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(r);
  }

  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const filteredYears = years.filter(y => {
    if (yearFrom >= yearTo) return y <= yearFrom && y >= yearTo;
    return y >= yearFrom && y <= yearTo;
  });

  console.log(`Targets: ${targets.length} records across years: ${filteredYears.join(", ")}`);

  let totalFetched = 0;
  let saveCounter = 0;

  for (const year of filteredYears) {
    const recs = byYear[year];
    console.log(`\n=== ${year}: ${recs.length} days to fetch ===`);

    for (const record of recs) {
      const jyoCode = VENUE_TO_CODE[record.競馬場];
      if (!jyoCode) {
        console.log(`  Skip (unknown venue): ${record.日付} ${record.競馬場}`);
        continue;
      }

      process.stdout.write(`  ${record.日付} ${record.競馬場}...`);
      sleep(2000);

      const raceBaba = scrapeRaceBaba(record.年, record.日付, jyoCode);
      if (raceBaba) {
        record.レース別馬場差 = raceBaba;
        totalFetched++;
        console.log(` OK (${Object.keys(raceBaba).length} races)`);
      } else {
        console.log(` no data`);
      }

      saveCounter++;
      // 10件ごとに中間保存
      if (saveCounter % 10 === 0) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
        console.log(`  [saved: ${totalFetched} fetched so far]`);
      }
    }

    // 年の終わりに保存
    fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
    console.log(`--- ${year} done. Total fetched: ${totalFetched} ---`);
  }

  // 最終保存
  fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2), "utf-8");
  console.log(`\nComplete. Fetched race baba for ${totalFetched} days.`);
}

main();
