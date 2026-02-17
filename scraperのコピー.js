const puppeteer = require("puppeteer");
const fs = require("fs");

async function scrapeRaceResult(raceId) {
  const url = `https://race.netkeiba.com/race/result.html?race_id=${raceId}`;
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Wait for the result table to render
  await page.waitForSelector("table.RaceTable01", { timeout: 15000 });

  // Extract race info
  const raceInfo = await page.evaluate(() => {
    const getText = (el) =>
      el ? el.textContent.replace(/\s+/g, " ").trim() : "";

    // RaceData02: 開催回, 競馬場名, 開催日, ...
    const data02Spans = document.querySelectorAll(".RaceData02 > span");
    const kaisai = getText(data02Spans[0]); // e.g. "1回"
    const basho = getText(data02Spans[1]); // e.g. "東京"
    const nichime = getText(data02Spans[2]); // e.g. "4日目"

    // RaceData01: 芝/ダート, 距離, 天候, 馬場
    const data01Text = getText(document.querySelector(".RaceData01"));
    // Parse surface and distance: "ダ1400m" or "芝1600m"
    const surfaceMatch = data01Text.match(/(芝|ダ)(\d+)m/);
    const surface = surfaceMatch
      ? surfaceMatch[1] === "ダ"
        ? "ダート"
        : "芝"
      : "";
    const distance = surfaceMatch ? surfaceMatch[2] : "";

    // Parse weather: "天候:晴"
    const weatherMatch = data01Text.match(/天候:(\S+)/);
    const weather = weatherMatch ? weatherMatch[1] : "";

    // Parse track condition: "馬場:稍"
    const conditionMatch = data01Text.match(/馬場:(\S+)/);
    const condition = conditionMatch ? conditionMatch[1] : "";

    // RaceName: クラス (e.g. "3歳未勝利")
    const raceClass = getText(document.querySelector(".RaceName"));

    return {
      競馬場名: basho,
      開催: kaisai,
      開催日: nichime,
      クラス: raceClass,
      "芝/ダート": surface,
      距離: distance,
      天候: weather,
      馬場: condition,
    };
  });

  const rows = await page.evaluate(() => {
    const table = document.querySelector("table.RaceTable01");
    if (!table) return [];

    const tbody = table.querySelector("tbody");
    if (!tbody) return [];

    const trs = tbody.querySelectorAll("tr.HorseList");
    const results = [];

    for (const tr of trs) {
      const tds = tr.querySelectorAll("td");
      if (tds.length === 0) continue;

      const getText = (el) =>
        el ? el.textContent.replace(/\s+/g, " ").trim() : "";

      // Column mapping based on actual HTML structure:
      // 0:着順, 1:枠番, 2:馬番, 3:馬名, 4:性齢, 5:斤量, 6:騎手,
      // 7:タイム, 8:着差, 9:人気, 10:単勝オッズ, 11:上がり, 12:通過, 13:調教師, 14:体重
      results.push({
        着順: getText(tds[0]),
        枠番: getText(tds[1]),
        馬番: getText(tds[2]),
        馬名: getText(tds[3]),
        性齢: getText(tds[4]),
        斤量: getText(tds[5]),
        騎手: getText(tds[6]),
        タイム: getText(tds[7]),
        着差: getText(tds[8]),
        人気: getText(tds[9]),
        単勝オッズ: getText(tds[10]),
        上がり: getText(tds[11]),
        通過: getText(tds[12]),
      });
    }

    return results;
  });

  await browser.close();

  if (rows.length === 0) {
    throw new Error(`No data found for race_id: ${raceId}`);
  }

  // Build CSV
  const raceInfoHeaders = [
    "競馬場名",
    "開催",
    "開催日",
    "クラス",
    "芝/ダート",
    "距離",
    "天候",
    "馬場",
  ];
  const headers = [
    ...raceInfoHeaders,
    "着順",
    "枠番",
    "馬番",
    "馬名",
    "性齢",
    "斤量",
    "騎手",
    "タイム",
    "着差",
    "通過",
    "上がり",
    "人気",
    "単勝オッズ",
  ];

  const csvLines = [headers.join(",")];
  for (const row of rows) {
    const merged = { ...raceInfo, ...row };
    const line = headers.map((h) => {
      const val = merged[h] || "";
      if (val.includes(",") || val.includes('"')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    csvLines.push(line.join(","));
  }
  const outputPath = './race_result/';
  const outputFile = `${outputPath}result_${raceId}.csv`;
  fs.writeFileSync(outputFile, csvLines.join("\n"), "utf-8");
  console.log(`Saved: ${outputFile} (${rows.length} rows)`);
}

module.exports = { scrapeRaceResult };

// CLI direct execution
if (require.main === module) {
  const raceId = process.argv[2];
  if (!raceId) {
    console.error("Usage: node scraper.js <race_id>");
    process.exit(1);
  }
  scrapeRaceResult(raceId).catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
