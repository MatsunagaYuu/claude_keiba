const fs = require("fs");
const path = require("path");
const { scrapeRaceResult } = require("./scraper");

const RACE_RESULT_DIR = "./race_result";
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const files = fs
    .readdirSync(RACE_RESULT_DIR)
    .filter((f) => f.endsWith(".csv"));

  const broken = [];
  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8")
      .split("\n");
    if (lines.length < 2) continue;
    const headers = lines[0].split(",");
    const vals = lines[1].split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = vals[i] || ""));
    if (!row["競馬場名"] || !row["クラス"]) {
      const raceId = file.replace("result_", "").replace(".csv", "");
      broken.push(raceId);
    }
  }

  console.log(`Re-scraping ${broken.length} files with missing race info...`);

  let fixed = 0;
  let failed = 0;
  for (const raceId of broken) {
    try {
      scrapeRaceResult(raceId);
      fixed++;
    } catch (e) {
      console.log(`  Failed: ${raceId} (${e.message})`);
      failed++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${fixed} fixed, ${failed} failed`);
}

main();
