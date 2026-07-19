const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { scrapeNarRaceResult, NAR_VENUES, NAR_ACTIVE_CODES } = require("./nar_scraper");

const VENUE_NAMES = NAR_VENUES;
const ACTIVE_CODES = NAR_ACTIVE_CODES;

const DELAY_MS = 2000;
const LIST_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 日付のレース一覧から対象会場のrace_idを取得（1リクエストで全会場判明）
function getRaceIds(date, codes) {
  const url = `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`;
  let raw;
  try {
    raw = execFileSync("curl", ["-s", "--max-time", "20", url], { maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.error(`  List fetch failed: ${date}`);
    return [];
  }
  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    html = new TextDecoder("euc-jp").decode(raw);
  }
  const ids = [...new Set([...html.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]))];
  return ids.filter((id) => codes.includes(id.substring(4, 6))).sort();
}

async function main() {
  const args = process.argv.slice(2);
  const codesIdx = args.indexOf("--codes");
  const codes = codesIdx >= 0
    ? args[codesIdx + 1].split(",").map((c) => c.trim())
    : ACTIVE_CODES;
  const dateArg = args.filter((a) => /^[\d,]+$/.test(a))[0];
  if (!dateArg) {
    console.error("Usage: node scrape_nar_result_by_date.js <date|date1,date2,...> [--codes 30,44]");
    console.error(`  対応会場: ${Object.entries(VENUE_NAMES).map(([c, n]) => `${c}=${n}`).join(" ")}`);
    console.error(`  デフォルト: ${ACTIVE_CODES.map((c) => VENUE_NAMES[c]).join(",")}`);
    process.exit(1);
  }

  const dates = dateArg.split(",").filter((d) => /^\d{8}$/.test(d));
  const outputDir = path.join(__dirname, "..", "nar_race_result");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  let totalSaved = 0, totalSkipped = 0, totalFailed = 0;

  for (const date of dates) {
    const raceIds = getRaceIds(date, codes);
    if (raceIds.length === 0) {
      console.log(`${date}: 対象会場の開催なし`);
      await sleep(LIST_DELAY_MS);
      continue;
    }
    const venues = [...new Set(raceIds.map((id) => VENUE_NAMES[id.substring(4, 6)] || id.substring(4, 6)))];
    console.log(`\n=== ${date} ${venues.join("・")} ${raceIds.length}レース ===`);

    for (const raceId of raceIds) {
      const outputFile = path.join(outputDir, `result_${raceId}.csv`);
      if (fs.existsSync(outputFile)) {
        totalSkipped++;
        continue;
      }
      try {
        scrapeNarRaceResult(raceId);
        totalSaved++;
      } catch (e) {
        console.log(`  Failed: ${raceId} (${e.message})`);
        totalFailed++;
      }
      await sleep(DELAY_MS);
    }
    await sleep(LIST_DELAY_MS);
  }

  console.log(`\n=== 完了: ${totalSaved}件保存, ${totalSkipped}件スキップ, ${totalFailed}件失敗 ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
