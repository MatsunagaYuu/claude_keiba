const fs = require("fs");
const path = require("path");
const { scrapeNarRaceResult } = require("./nar_scraper");

const KEIBAJO_CODE = "30"; // 門別
const DELAY_MS = 2000;
const MAX_RACE = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dateArg = process.argv[2];
  if (!dateArg) {
    console.error("Usage: node scrape_nar_result_by_date.js <date|date1,date2,...>");
    console.error("  e.g. node scrape_nar_result_by_date.js 20260429");
    console.error("  e.g. node scrape_nar_result_by_date.js 20260415,20260416");
    process.exit(1);
  }

  const dates = dateArg.split(",");
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const date of dates) {
    if (!/^\d{8}$/.test(date)) {
      console.error(`Invalid date format: ${date} (expected YYYYMMDD)`);
      continue;
    }

    const year = date.substring(0, 4);
    const mmdd = date.substring(4, 8);

    console.log(`\n=== ${date} 門別レース結果取得 ===`);

    const outputDir = path.join(__dirname, "..", "nar_race_result");

    for (let race = 1; race <= MAX_RACE; race++) {
      const raceNum = String(race).padStart(2, "0");
      const raceId = `${year}${KEIBAJO_CODE}${mmdd}${raceNum}`;

      // 既存ファイルがあればスキップ
      const outputFile = path.join(outputDir, `result_${raceId}.csv`);
      if (fs.existsSync(outputFile)) {
        console.log(`  Skip (already exists): ${raceId}`);
        totalSkipped++;
        continue;
      }

      try {
        scrapeNarRaceResult(raceId);
        totalSaved++;
      } catch (e) {
        console.log(`  Skip: ${raceId} (${e.message})`);
        totalSkipped++;
        // 1Rでデータなしなら、その日は開催なし
        if (race === 1) {
          console.log(`  → ${date} は開催なし、次の日付へ`);
          break;
        }
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
