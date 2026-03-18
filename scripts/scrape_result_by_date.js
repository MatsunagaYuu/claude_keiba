const fs = require("fs");
const path = require("path");
const { scrapeRaceResult } = require("./scraper");

const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");
const DELAY_MS = 2000;

const VENUE_CODE_MAP = {
  "札幌": "01",
  "函館": "02",
  "福島": "03",
  "新潟": "04",
  "東京": "05",
  "中山": "06",
  "中京": "07",
  "京都": "08",
  "阪神": "09",
  "小倉": "10",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const date = process.argv[2];
  if (!date) {
    console.error("Usage: node scrape_result_by_date.js <date>");
    console.error("  e.g. node scrape_result_by_date.js 20260228");
    process.exit(1);
  }

  const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
  const entry = calendar.find((d) => d.date === date);
  if (!entry) {
    console.error(`Date not found in calendar: ${date}`);
    process.exit(1);
  }

  const year = date.substring(0, 4);
  let totalSaved = 0;
  let totalSkipped = 0;

  console.log(`=== ${date} レース結果取得 ===`);

  for (const v of entry.venues) {
    const venueCode = VENUE_CODE_MAP[v.venue];
    if (!venueCode) {
      console.error(`Unknown venue: ${v.venue}`);
      continue;
    }

    console.log(`\n--- ${v.venue} (${v.kaisai}回${v.day}日目) ---`);

    for (let race = 1; race <= 12; race++) {
      const raceId = `${year}${venueCode}${pad2(v.kaisai)}${pad2(v.day)}${pad2(race)}`;

      try {
        scrapeRaceResult(raceId);
        totalSaved++;
      } catch (e) {
        console.log(`  Skip: ${raceId} (${e.message})`);
        totalSkipped++;
        if (race === 1) break;
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`\n=== 完了: ${totalSaved}件保存, ${totalSkipped}件スキップ ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
