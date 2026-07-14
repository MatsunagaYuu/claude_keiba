const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseClass } = require("./nar_scraper");

const OUTPUT_DIR = path.join(__dirname, "..", "nar_shutuba");
const DELAY_MS = 500;

function sleep(ms) {
  execFileSync("sleep", [String(ms / 1000)]);
}

function fetchHTML(url) {
  try {
    const raw = execFileSync("curl", ["-s", "--max-time", "20", url], {
      maxBuffer: 10 * 1024 * 1024,
    });
    // nar.netkeiba.com は2026年5月頃にEUC-JP→UTF-8へ移行。両対応で自動判別
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return new TextDecoder("euc-jp").decode(raw);
    }
  } catch (e) {
    console.error(`  Fetch failed: ${url}`);
    return null;
  }
}

function getNarRaceIds(kaisaiDate) {
  const url = `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=${kaisaiDate}`;
  const html = fetchHTML(url);
  if (!html) return [];

  const ids = [];
  const re = /race_id=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    // 門別のrace_idは "2026300506XX" (30=門別コード)
    if (m[1].substring(4, 6) === "30" && !ids.includes(m[1])) {
      ids.push(m[1]);
    }
  }
  return ids.sort();
}

function scrapeNarShutuba(raceId) {
  const url = `https://nar.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  const html = fetchHTML(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // レース情報
  const raceName = $(".RaceName").text().trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const surfaceMatch = html.match(/ダ(\d+)m/);
  const distance = surfaceMatch ? surfaceMatch[1] : "";

  // 開催情報
  const raceData2Text = $(".RaceData02").text().trim();
  const kaisaiMatch = raceData2Text.match(/(\d+)回/);
  const dayMatch = raceData2Text.match(/(\d+)日目/);
  const kaisai = kaisaiMatch ? `${kaisaiMatch[1]}回` : "";
  const nichime = dayMatch ? `${dayMatch[1]}日目` : "";

  // クラス（レース名から正規化: C4, B3, OP, 重賞, 新馬, 未勝利 など）
  const className = parseClass(raceName);

  // 馬データ
  const horses = [];
  $("tr.HorseList").each((i, el) => {
    const $el = $(el);
    const waku = $el.find("td[class^='Waku']").first().text().trim();
    const umaban = $el.find("td[class^='Umaban']").first().text().trim();
    const horseName = $el.find(".HorseName a").text().trim();
    const jockey = $el.find(".Jockey a").text().trim();

    // 斤量
    let kinryo = "";
    $el.find("td").each((j, td) => {
      const text = $(td).text().trim();
      if (/^\d+(\.\d)?$/.test(text) && parseFloat(text) > 40 && parseFloat(text) < 70) {
        kinryo = text;
      }
    });

    // 性齢
    let sexAge = "";
    $el.find("td").each((j, td) => {
      const text = $(td).text().trim();
      if (/^[牡牝セ]\d+$/.test(text)) {
        sexAge = text;
      }
    });

    if (horseName) {
      horses.push({
        枠番: waku,
        馬番: umaban,
        馬名: horseName,
        性齢: sexAge,
        斤量: kinryo,
        騎手: jockey,
      });
    }
  });

  if (horses.length === 0) return null;

  return {
    競馬場名: "門別",
    開催: kaisai,
    開催日: nichime,
    レース名: raceName,
    クラス: className,
    "芝/ダート": "ダート",
    距離: distance,
    horses,
  };
}

function main() {
  const dateArg = process.argv[2];
  if (!dateArg || !/^\d{8}$/.test(dateArg)) {
    console.error("Usage: node scrape_nar_shutuba.js YYYYMMDD");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  console.log(`Fetching race list for ${dateArg}...`);
  const raceIds = getNarRaceIds(dateArg);
  console.log(`Found ${raceIds.length} races (門別)`);

  for (const raceId of raceIds) {
    console.log(`  Scraping ${raceId}...`);
    const data = scrapeNarShutuba(raceId);
    if (!data) {
      console.log(`    -> Failed`);
      continue;
    }

    // CSV出力
    const headers = ["競馬場名", "開催", "開催日", "レース名", "クラス", "芝/ダート", "距離", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手"];
    const lines = [headers.join(",")];
    for (const h of data.horses) {
      lines.push([
        data.競馬場名, data.開催, data.開催日, data.レース名, data.クラス,
        data["芝/ダート"], data.距離, h.枠番, h.馬番, h.馬名, h.性齢, h.斤量, h.騎手,
      ].join(","));
    }

    const outFile = path.join(OUTPUT_DIR, `shutuba_${raceId}.csv`);
    fs.writeFileSync(outFile, lines.join("\n"), "utf-8");
    console.log(`    -> ${data.horses.length} horses (${data.レース名})`);

    sleep(DELAY_MS);
  }

  console.log("Done.");
}

main();
