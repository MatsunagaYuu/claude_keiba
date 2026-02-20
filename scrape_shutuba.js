const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUTPUT_DIR = "./shutuba";
const DELAY_MS = 500;

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function fetchHTML(url, encoding = "utf-8") {
  try {
    const raw = execSync(`curl -s --max-time 20 "${url}"`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    if (encoding === "euc-jp") {
      const decoder = new TextDecoder("euc-jp");
      return decoder.decode(raw);
    }
    return raw.toString("utf-8");
  } catch (e) {
    console.error(`  Fetch failed: ${url}`);
    return null;
  }
}

function getRaceIds(kaisaiDate) {
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${kaisaiDate}`;
  const html = fetchHTML(url);
  if (!html) return [];

  const ids = [];
  const re = /race_id=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids.sort();
}

function scrapeShutuba(raceId) {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  const html = fetchHTML(url, "euc-jp");
  if (!html) return null;

  const $ = cheerio.load(html);

  // Race info
  const raceName = $(".RaceName").text().trim();
  const raceData1 = $(".RaceData01 span").first().text().trim();
  const surfaceMatch = raceData1.match(/(芝|ダ)\D*(\d+)m/);
  const surface = surfaceMatch ? (surfaceMatch[1] === "ダ" ? "ダート" : "芝") : "";
  const distance = surfaceMatch ? surfaceMatch[2] : "";

  // RaceData02: 開催, 競馬場, 日目
  const spans2 = [];
  $(".RaceData02 span").each((i, el) => {
    spans2.push($(el).text().trim());
  });
  const kaisaiNum = spans2[0] || ""; // "1回"
  const venue = spans2[1] || "";     // "東京"
  const dayNum = spans2[2] || "";    // "7日目"

  // Race number from RaceNum
  const raceNum = $(".RaceNum").text().trim().replace("R", "");

  // Horses
  const horses = [];
  $(".HorseList").each((i, el) => {
    // 枠番: クラスが Waku1〜Waku8 なので属性セレクタで取得
    const wakuTd = $(el).find("td[class*='Waku']").first();
    const waku = wakuTd.find("span").text().trim() || wakuTd.text().trim();
    const umaban = $(el).find("td[class*='Umaban']").text().trim();
    const horseName = $(el).find(".HorseName a").text().trim();
    const horseUrl = $(el).find(".HorseName a").attr("href") || "";
    const horseIdMatch = horseUrl.match(/horse\/(\d+)/);
    const horseId = horseIdMatch ? horseIdMatch[1] : "";
    const barei = $(el).find(".Barei").text().trim();
    const kinryo = $(el).find("td").eq(5).text().trim();
    const jockey = $(el).find(".Jockey a").text().trim();
    const trainer = $(el).find(".Trainer a").text().trim();

    if (horseName) {
      horses.push({
        枠番: waku,
        馬番: umaban,
        馬名: horseName,
        馬ID: horseId,
        性齢: barei,
        斤量: kinryo,
        騎手: jockey,
        厩舎: trainer,
      });
    }
  });

  return {
    raceId,
    raceNum,
    競馬場名: venue,
    開催: kaisaiNum,
    開催日: dayNum,
    クラス: raceName,
    "芝/ダート": surface,
    距離: distance,
    horses,
  };
}

function toCSV(raceData) {
  const headers = [
    "競馬場名", "開催", "開催日", "クラス", "芝/ダート", "距離",
    "枠番", "馬番", "馬名", "馬ID", "性齢", "斤量", "騎手", "厩舎",
  ];
  const lines = [headers.join(",")];
  for (const h of raceData.horses) {
    lines.push([
      raceData.競馬場名, raceData.開催, raceData.開催日,
      raceData.クラス, raceData["芝/ダート"], raceData.距離,
      h.枠番, h.馬番, h.馬名, h.馬ID, h.性齢, h.斤量, h.騎手, h.厩舎,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

function main() {
  const kaisaiDate = process.argv[2];
  if (!kaisaiDate) {
    console.error("Usage: node scrape_shutuba.js <kaisai_date>");
    console.error("  e.g. node scrape_shutuba.js 20260221");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  console.log(`\n=== ${kaisaiDate} ===`);
  const raceIds = getRaceIds(kaisaiDate);
  console.log(`  Race IDs: ${raceIds.length}`);

  for (const raceId of raceIds) {
    sleep(DELAY_MS);
    const data = scrapeShutuba(raceId);
    if (!data || data.horses.length === 0) {
      console.log(`  ${raceId}: (no data)`);
      continue;
    }

    const csvFile = path.join(OUTPUT_DIR, `shutuba_${raceId}.csv`);
    fs.writeFileSync(csvFile, toCSV(data), "utf-8");
    console.log(`  ${raceId}: ${data.競馬場名} ${data.raceNum}R ${data.クラス} ${data["芝/ダート"]}${data.距離}m ${data.horses.length}頭`);
  }

  console.log(`\nDone: ${raceIds.length} races saved to ${OUTPUT_DIR}/`);
}

main();
