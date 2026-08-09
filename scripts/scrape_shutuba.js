const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { toCSVLine } = require("./csv_util");

const OUTPUT_DIR = path.join(__dirname, "..", "shutuba");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
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
  const html = fetchHTML(url);
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

  // 条件クラス: RaceData02 の "サラ系３歳以上 ２勝クラス" から抽出。
  // 結果側(race_index)の16クラス区分と揃えた表記にする（新馬/未勝利/1勝/2勝/3勝/OP）。
  // レース名(RaceName)は「大垣特別」のような特別名なのでクラス判定には使えない。
  const data02 = $(".RaceData02").text().replace(/\s+/g, " ").trim();
  const raceClass = (() => {
    const zen = { "１": "1", "２": "2", "３": "3" };
    // 障害競走は平地と別体系（障害未勝利／障害オープン）なので先に判定する
    const jump = /障害/.test(data02) ? "障害" : "";
    if (/新馬/.test(data02)) return `${jump}新馬`;
    if (/未勝利/.test(data02)) return `${jump}未勝利`;
    const win = data02.match(/([１２３1-3])勝クラス/);
    if (win) return `${jump}${zen[win[1]] || win[1]}勝`;
    if (/オープン|リステッド|重賞/.test(data02)) return `${jump}OP`;
    return jump;
  })();

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
    クラス: raceClass || raceName,
    レース名: raceName,
    "芝/ダート": surface,
    距離: distance,
    horses,
  };
}

function toCSV(raceData) {
  const headers = [
    "競馬場名", "開催", "開催日", "クラス", "レース名", "芝/ダート", "距離",
    "枠番", "馬番", "馬名", "馬ID", "性齢", "斤量", "騎手", "厩舎",
  ];
  const lines = [toCSVLine(headers)];
  for (const h of raceData.horses) {
    lines.push(toCSVLine([
      raceData.競馬場名, raceData.開催, raceData.開催日,
      raceData.クラス, raceData.レース名, raceData["芝/ダート"], raceData.距離,
      h.枠番, h.馬番, h.馬名, h.馬ID, h.性齢, h.斤量, h.騎手, h.厩舎,
    ]));
  }
  return lines.join("\n") + "\n";
}

// kaisai_calendar.json から指定日付の開催会場セットを構築
function loadExpectedVenues(kaisaiDate) {
  if (!fs.existsSync(CALENDAR_FILE)) return null;
  const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
  const entry = calendar.find(e => e.date === kaisaiDate);
  if (!entry) return null;
  // "競馬場名_開催回_日目数字" のセットを返す（例: "東京_1_3"）
  const set = new Set();
  for (const v of entry.venues) {
    set.add(`${v.venue}_${v.kaisai}_${v.day}`);
  }
  return set;
}

function main() {
  // --race-ids モード: 特定のrace_idを直接指定してスクレイピング
  const raceIdsIdx = process.argv.indexOf("--race-ids");
  if (raceIdsIdx >= 0) {
    const raceIds = process.argv.slice(raceIdsIdx + 1).filter(a => /^\d{12}$/.test(a));
    if (raceIds.length === 0) {
      console.error("Usage: node scrape_shutuba.js --race-ids <raceId1> <raceId2> ...");
      process.exit(1);
    }
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
    let saved = 0;
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
      saved++;
    }
    console.log(`\nDone: ${saved} saved`);
    return;
  }

  const kaisaiDate = process.argv[2];
  if (!kaisaiDate) {
    console.error("Usage: node scrape_shutuba.js <kaisai_date>");
    console.error("       node scrape_shutuba.js --race-ids <raceId1> ...");
    console.error("  e.g. node scrape_shutuba.js 20260221");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  // カレンダーで当日の開催会場を確認
  const expectedVenues = loadExpectedVenues(kaisaiDate);
  if (!expectedVenues) {
    console.warn(`WARNING: ${kaisaiDate} not found in kaisai_calendar.json. Race ID validation will be skipped.`);
  } else {
    console.log(`Expected venues: ${[...expectedVenues].join(", ")}`);
  }

  console.log(`\n=== ${kaisaiDate} ===`);
  const raceIds = getRaceIds(kaisaiDate);
  console.log(`  Race IDs: ${raceIds.length}`);

  let saved = 0;
  let invalid = 0;

  for (const raceId of raceIds) {
    sleep(DELAY_MS);
    const data = scrapeShutuba(raceId);
    if (!data || data.horses.length === 0) {
      console.log(`  ${raceId}: (no data)`);
      continue;
    }

    // カレンダーと照合してrace_idが正しい日付のものか検証
    if (expectedVenues) {
      const kaisaiN = parseInt((data.開催 || "").replace("回", "")) || 0;
      const dayN = parseInt((data.開催日 || "").replace("日目", "")) || 0;
      const venueKey = `${data.競馬場名}_${kaisaiN}_${dayN}`;
      if (!expectedVenues.has(venueKey)) {
        console.warn(`  ${raceId}: SKIP (venue mismatch: got "${venueKey}", not in expected set)`);
        invalid++;
        continue;
      }
    }

    const csvFile = path.join(OUTPUT_DIR, `shutuba_${raceId}.csv`);
    fs.writeFileSync(csvFile, toCSV(data), "utf-8");
    console.log(`  ${raceId}: ${data.競馬場名} ${data.raceNum}R ${data.クラス} ${data["芝/ダート"]}${data.距離}m ${data.horses.length}頭`);
    saved++;
  }

  console.log(`\nDone: ${saved} saved, ${invalid} skipped (invalid date)`);
}

main();
