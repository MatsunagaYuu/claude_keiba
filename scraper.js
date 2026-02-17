const cheerio = require("cheerio");
const https = require("https");
const fs = require("fs");
const { execSync } = require("child_process");

function fetchHTML(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  const raw = execSync(
    `curl -s --max-time 20 "${url}"`,
    { maxBuffer: 10 * 1024 * 1024 }
  );
  // db.netkeiba.com is EUC-JP encoded
  const decoder = new TextDecoder("euc-jp");
  return decoder.decode(raw);
}

function scrapeRaceResult(raceId) {
  const html = fetchHTML(raceId);
  const $ = cheerio.load(html);

  // --- Race info ---
  // diary: "2026年02月10日 1回東京4日目 3歳未勝利 [指](馬齢)"
  const diary = $(".race_head_inner p.smalltxt").text().replace(/\s+/g, " ").trim();
  const diaryMatch = diary.match(/(\d+)回(.+?)(\d+日目)\s+(.+?)(?:\s{2,}|[\s\u00a0]+(?:牡|牝|セ|\(|\[))/);
  const kaisai = diaryMatch ? `${diaryMatch[1]}回` : "";
  const basho = diaryMatch ? diaryMatch[2] : "";
  const nichime = diaryMatch ? `${diaryMatch[3]}` : "";
  const raceClass = diaryMatch ? diaryMatch[4].trim() : "";

  // span: "ダ左1400m / 天候 : 晴 / ダート : 稍重 / 発走 : 10:05"
  const spanText = $(".racedata span").text().replace(/\s+/g, " ").trim();
  const surfaceMatch = spanText.match(/(芝|ダ)[^\d]*(\d+)m/);
  const surface = surfaceMatch
    ? surfaceMatch[1] === "ダ" ? "ダート" : "芝"
    : "";
  const distance = surfaceMatch ? surfaceMatch[2] : "";
  const weatherMatch = spanText.match(/天候\s*:\s*(\S+)/);
  const weather = weatherMatch ? weatherMatch[1] : "";
  const conditionMatch = spanText.match(/(?:芝|ダート)\s*:\s*(\S+)/);
  const condition = conditionMatch ? conditionMatch[1] : "";

  const raceInfo = {
    競馬場名: basho,
    開催: kaisai,
    開催日: nichime,
    クラス: raceClass,
    "芝/ダート": surface,
    距離: distance,
    天候: weather,
    馬場: condition,
  };

  // --- Result table ---
  const rows = [];
  $("table.race_table_01 tr").each((i, tr) => {
    if (i === 0) return; // skip header
    const tds = $(tr).find("td");
    if (tds.length === 0) return;

    const getText = (idx) => $(tds[idx]).text().replace(/\s+/g, " ").trim();

    // 0:着順, 1:枠番, 2:馬番, 3:馬名, 4:性齢, 5:斤量, 6:騎手,
    // 7:タイム, 8:着差, 10:通過, 11:上がり, 12:単勝オッズ, 13:人気
    rows.push({
      着順: getText(0),
      枠番: getText(1),
      馬番: getText(2),
      馬名: getText(3),
      性齢: getText(4),
      斤量: getText(5),
      騎手: getText(6),
      タイム: getText(7),
      着差: getText(8),
      通過: getText(10),
      上がり: getText(11),
      単勝オッズ: getText(12),
      人気: getText(13),
    });
  });

  if (rows.length === 0) {
    throw new Error(`No data found for race_id: ${raceId}`);
  }

  // --- Build CSV ---
  const raceInfoHeaders = [
    "競馬場名", "開催", "開催日", "クラス", "芝/ダート", "距離", "天候", "馬場",
  ];
  const headers = [
    ...raceInfoHeaders,
    "着順", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手",
    "タイム", "着差", "通過", "上がり", "人気", "単勝オッズ",
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

  const outputPath = "./race_result/";
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
  try {
    scrapeRaceResult(raceId);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
