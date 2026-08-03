// 通過順位(コーナー通過順位)を追加する前に取得した既存 nar_race_result/*.csv を
// 再取得して 通過 列を埋める、一回限りのバックフィルスクリプト。
// 既に 通過 列にデータがあるファイルはスキップする（中断・再開に対応）。
// 使い方: node scripts/backfill_nar_passing.js
const fs = require("fs");
const path = require("path");
const { scrapeNarRaceResult } = require("./nar_scraper");

const RACE_RESULT_DIR = path.join(__dirname, "..", "nar_race_result");
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPassingData(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const headers = lines[0].split(",");
  const idx = headers.indexOf("通過");
  if (idx < 0) return false;
  return lines.slice(1).some((l) => (l.split(",")[idx] || "").trim() !== "");
}

async function main() {
  const files = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));
  const targets = files.filter((f) => !hasPassingData(path.join(RACE_RESULT_DIR, f)));
  console.log(`対象: ${targets.length} / 全${files.length}件（既に通過ありはスキップ）`);

  let done = 0, failed = 0;
  const startTime = Date.now();
  for (const file of targets) {
    const raceId = file.replace("result_", "").replace(".csv", "");
    try {
      scrapeNarRaceResult(raceId);
      done++;
    } catch (e) {
      failed++;
      console.log(`  Failed: ${raceId} (${e.message})`);
    }
    if (done % 100 === 0 && done > 0) {
      const elapsedMin = (Date.now() - startTime) / 60000;
      const rate = done / elapsedMin;
      const remainMin = (targets.length - done) / rate;
      console.log(`進捗: ${done}/${targets.length} (失敗${failed}) 経過${elapsedMin.toFixed(0)}分 残り約${remainMin.toFixed(0)}分`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\n=== 完了: ${done}件成功, ${failed}件失敗 ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
