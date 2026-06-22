const cheerio = require("cheerio");
const https = require("https");
const fs = require("fs");
const path = require("path");
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

function parseRaceNameGrade(h1Text) {
  const text = h1Text.replace(/<!--.*?-->/g, "").trim();
  const m = text.match(/^(.+?)\((GI{0,2}|L|OP|\d+勝)\)$/);
  if (!m) return { raceName: "", grade: "" };
  const suffix = m[2];
  let grade = "";
  if (suffix === "GI") grade = "G1";
  else if (suffix === "GII") grade = "G2";
  else if (suffix === "GIII") grade = "G3";
  else if (suffix === "L") grade = "L";
  else grade = "OP";
  return { raceName: m[1], grade };
}

function scrapeRaceResult(raceId) {
  const html = fetchHTML(raceId);
  const $ = cheerio.load(html);

  const h1Text = $(".race_head_inner h1").text().trim();
  const { raceName, grade } = parseRaceNameGrade(h1Text);

  const diary = $(".race_head_inner p.smalltxt").text().replace(/\s+/g, " ").trim();
  const dateMatch = diary.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const raceDate = dateMatch
    ? `${dateMatch[1]}/${parseInt(dateMatch[2])}/${parseInt(dateMatch[3])}`
    : "";
  const diaryMatch = diary.match(/(\d+)回(.+?)(\d+日目)\s+(.+?)(?:\s{2,}|$)/);
  const kaisai = diaryMatch ? `${diaryMatch[1]}回` : "";
  const basho = diaryMatch ? diaryMatch[2] : "";
  const nichime = diaryMatch ? diaryMatch[3] : "";
  const raceClass = diaryMatch ? diaryMatch[4].trim() : "";

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
    "日付": raceDate,
    "競馬場名": basho,
    "開催": kaisai,
    "開催日": nichime,
    "クラス": raceClass,
    "レース名": raceName,
    "グレード": grade,
    "芝/ダート": surface,
    "距離": distance,
    "天候": weather,
    "馬場": condition,
  };

  const rows = [];
  $("table.race_table_01 tr").each((i, tr) => {
    if (i === 0) return;
    const tds = $(tr).find("td");
    if (tds.length === 0) return;
    const getText = (idx) => $(tds[idx]).text().replace(/\s+/g, " ").trim();
    rows.push({
      "着順": getText(0),
      "枠番": getText(1),
      "馬番": getText(2),
      "馬名": getText(3),
      "性齢": getText(4),
      "斤量": getText(5),
      "騎手": getText(6),
      "タイム": getText(7),
      "着差": getText(8),
      "通過": getText(14),
      "上がり": getText(15),
      "単勝オッズ": getText(16),
      "人気": getText(17),
    });
  });

  if (rows.length === 0) {
    throw new Error(`No data found for race_id: ${raceId}`);
  }

  const headers = [
    "日付", "競馬場名", "開催", "開催日",
    "クラス", "レース名", "グレード",
    "芝/ダート", "距離", "天候", "馬場",
    "着順", "枠番", "馬番", "馬名", "性齢",
    "斤量", "騎手", "タイム", "着差",
    "通過", "上がり", "人気", "単勝オッズ",
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

  const outputPath = path.join(__dirname, "..", "race_result") + "/";
  const outputFile = `${outputPath}result_${raceId}.csv`;
  fs.writeFileSync(outputFile, csvLines.join("\n"), "utf-8");
  console.log(`Saved: ${outputFile} (${rows.length} rows)`);
}

module.exports = { scrapeRaceResult };

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
