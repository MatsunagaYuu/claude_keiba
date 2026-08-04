const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseClass, NAR_VENUES, NAR_ACTIVE_CODES } = require("./nar_scraper");
const { toCSVLine } = require("./csv_util");

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
    // 対応会場（NAR_ACTIVE_CODES）のみ取得。race_id形式 {YYYY}{code}{MMDD}{RR}
    if (NAR_ACTIVE_CODES.includes(m[1].substring(4, 6)) && !ids.includes(m[1])) {
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

  // レース情報（盛岡は芝コースあり）
  const raceName = $(".RaceName").text().trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const surfaceMatch = html.match(/(芝|ダ)(\d+)m/);
  const surface = surfaceMatch ? (surfaceMatch[1] === "ダ" ? "ダート" : "芝") : "ダート";
  const distance = surfaceMatch ? surfaceMatch[2] : "";

  // 開催情報
  const raceData2Text = $(".RaceData02").text().trim();
  const kaisaiMatch = raceData2Text.match(/(\d+)回/);
  const dayMatch = raceData2Text.match(/(\d+)日目/);
  const kaisai = kaisaiMatch ? `${kaisaiMatch[1]}回` : "";
  const nichime = dayMatch ? `${dayMatch[1]}日目` : "";

  // クラス（レース名から正規化: C4, B3, OP, 重賞, 新馬, 未勝利 など）
  const className = parseClass(raceName);

  // 馬データ
  // 注意: ページ内には出馬表本体（table.ShutubaTable）とは別に、会員限定の
  // 予想ラップ表（Shutuba_Table PredictRap_Table）も tr.HorseList を使っており、
  // スコープを絞らないと無関係な行まで走査してしまう。
  const horses = [];
  $("table.ShutubaTable tr.HorseList").each((i, el) => {
    const $el = $(el);
    const waku = $el.find("td[class^='Waku']").first().text().trim();
    const umaban = $el.find("td[class^='Umaban']").first().text().trim();
    const horseName = $el.find(".HorseName a").text().trim();
    const jockey = $el.find(".Jockey a").text().trim();

    // 性齢（例: "牝2"）
    let sexAge = "";
    $el.find("td").each((j, td) => {
      const text = $(td).text().trim();
      if (/^[牡牝セ]\d+$/.test(text)) {
        sexAge = text;
      }
    });

    // 斤量: 性齢セル(span.Age)の直後のtdが斤量。td内を数値レンジで走査すると
    // 単勝オッズ（40〜70の範囲に収まることがある）を誤って拾ってしまうため、
    // 位置関係で確実に斤量セルだけを取得する。
    const kinryo = $el.find("span.Age").closest("td").next("td").text().trim();

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
    競馬場名: NAR_VENUES[raceId.substring(4, 6)] || "",
    開催: kaisai,
    開催日: nichime,
    レース名: raceName,
    クラス: className,
    "芝/ダート": surface,
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
  console.log(`Found ${raceIds.length} races (対象会場)`);

  for (const raceId of raceIds) {
    console.log(`  Scraping ${raceId}...`);
    const data = scrapeNarShutuba(raceId);
    if (!data) {
      console.log(`    -> Failed`);
      continue;
    }

    // CSV出力
    const headers = ["競馬場名", "開催", "開催日", "レース名", "クラス", "芝/ダート", "距離", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手"];
    const lines = [toCSVLine(headers)];
    for (const h of data.horses) {
      lines.push(toCSVLine([
        data.競馬場名, data.開催, data.開催日, data.レース名, data.クラス,
        data["芝/ダート"], data.距離, h.枠番, h.馬番, h.馬名, h.性齢, h.斤量, h.騎手,
      ]));
    }

    const outFile = path.join(OUTPUT_DIR, `shutuba_${raceId}.csv`);
    fs.writeFileSync(outFile, lines.join("\n"), "utf-8");
    console.log(`    -> ${data.horses.length} horses (${data.レース名})`);

    sleep(DELAY_MS);
  }

  console.log("Done.");
}

main();
