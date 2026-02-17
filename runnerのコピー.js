const { scrapeRaceResult } = require("./scraper");

const VENUE_CODES = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉",
};

const DELAY_MS = 2000; // リクエスト間隔（サーバー負荷軽減）

function pad2(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(year, venueCode) {
  const venueName = VENUE_CODES[venueCode];
  if (!venueName) {
    console.error(
      `Unknown venue code: ${venueCode}\nValid codes: ${Object.entries(VENUE_CODES).map(([k, v]) => `${k}:${v}`).join(", ")}`
    );
    process.exit(1);
  }

  console.log(`=== ${year}年 ${venueName}(${venueCode}) 全レース取得開始 ===`);

  let totalSaved = 0;
  let totalSkipped = 0;

  // 開催: 01-06, 開催日: 01-12, レース: 01-12
  for (let kai = 1; kai <= 6; kai++) {
    let kaiHasData = false;

    for (let day = 1; day <= 12; day++) {
      let dayHasData = false;

      for (let race = 1; race <= 12; race++) {
        const raceId = `${year}${venueCode}${pad2(kai)}${pad2(day)}${pad2(race)}`;

        try {
          await scrapeRaceResult(raceId);
          totalSaved++;
          kaiHasData = true;
          dayHasData = true;
        } catch (e) {
          console.log(`  Skip: ${raceId} (${e.message})`);
          totalSkipped++;
          // 1Rでデータなしならその日は終了
          if (race === 1) break;
        }

        await sleep(DELAY_MS);
      }

      // その日にデータがなければ、この開催の残り日程もスキップ
      if (!dayHasData && day > 1) break;
    }

    // この開催にデータがなければ、残りの開催もスキップ
    if (!kaiHasData) break;
  }

  console.log(`\n=== 完了: ${totalSaved}件保存, ${totalSkipped}件スキップ ===`);
}

const year = process.argv[2];
const venueCode = process.argv[3];

if (!year || !venueCode) {
  console.error("Usage: node runner.js <year> <venue_code>");
  console.error("Example: node runner.js 2026 05  (2026年 東京)");
  console.error(
    `\nVenue codes:\n${Object.entries(VENUE_CODES).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`
  );
  process.exit(1);
}

run(year, venueCode).catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
