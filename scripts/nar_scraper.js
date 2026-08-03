const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function fetchHTML(raceId) {
  const url = `https://nar.netkeiba.com/race/result.html?race_id=${raceId}`;
  const raw = execSync(
    `curl -s --max-time 20 "${url}"`,
    { maxBuffer: 10 * 1024 * 1024 }
  );
  // nar.netkeiba.com は2026年5月頃にEUC-JP→UTF-8へ移行。両対応で自動判別
  // （EUC-JPのバイト列はUTF-8として不正になるため fatal:true で判別できる）
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("euc-jp").decode(raw);
  }
}

/**
 * クラス名をパース
 * "3歳以上 C4ー3"                          → "C4"
 * "3歳条件 未勝利"                          → "未勝利"
 * "2歳 新馬"                               → "新馬"
 * "3歳以上 A1"                             → "A1"
 * "JRA認定競走フレッシュチャレンジ競走(2歳)"  → "新馬"
 * "25周年キレートレモン特別(3歳) OP"         → "OP"
 * "門別開幕!すぱっと4倍特別(B3)"            → "B3"
 * "エピファネイア・プレミアム(B2)"            → "B2"
 * "3歳 C4 40万円以下"                       → "C4"
 */
function parseClass(raceName) {
  const name = raceName.replace(/\s+/g, " ").trim();
  // JRA認定競走（フレッシュチャレンジ/スーパーフレッシュチャレン）= 新馬
  if (name.includes("フレッシュ")) return "新馬";
  if (name.includes("新馬")) return "新馬";
  if (name.includes("未勝利")) return "未勝利";
  // 重賞（〔H1〕〔H2〕〔H3〕 or "重賞"）
  if (name.includes("重賞") || /〔H\d〕/.test(name)) return "重賞";
  // OP判定（"OP"が含まれる場合。特別レース名(3歳) OPなど）
  if (/\bOP\b/.test(name) || name.includes("オープン")) return "OP";
  // A1-C4: 本文中 or 末尾カッコ内 "(B3)" "(C4)" など
  const classMatch = name.match(/([ABC]\d)/);
  if (classMatch) return classMatch[1];
  return name;
}

// コーナー通過順位テーブル（table.Corner_Num）から馬番別の通過順位文字列を作る。
// 各コーナー行は "(10,4,2),3,(5,11),1,13,(8,14),12,7,6-9" のような形式:
//   カンマ/ハイフン/イコールは区切り（間隔の大小を表すが順位計算では区別不要）
//   括弧は僅差の並走馬群（同順位として扱う＝JRAの通過欄と同じ「同着は同数字」方式）
// JRA側の通過欄（例: "9-10-9-8"）と同じ「先頭から連続した順位番号（同着は人数分スキップ）」
// になるよう変換し、馬番→各コーナー順位の配列を返す。
function parseCornerPassing($) {
  const cornerRows = $("table.Corner_Num tr");
  if (cornerRows.length === 0) return {};

  const byHorse = {}; // 馬番 → [1角, 2角, ...]
  cornerRows.each((i, tr) => {
    const text = $(tr).find("td").text().trim();
    if (!text) return;
    let cursor = 1;
    const tokenRe = /\(([\d,]+)\)|(\d+)/g;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      const nums = m[1] ? m[1].split(",").map((n) => n.trim()) : [m[2]];
      for (const n of nums) {
        if (!byHorse[n]) byHorse[n] = [];
        byHorse[n].push(cursor);
      }
      cursor += nums.length;
    }
  });
  return byHorse;
}

function scrapeNarRaceResult(raceId) {
  const html = fetchHTML(raceId);
  const $ = cheerio.load(html);

  // --- Race info ---
  // RaceName: "3歳以上 C4ー3"
  const raceName = $(".RaceName").text().replace(/\s+/g, " ").trim();
  const raceClass = parseClass(raceName);

  // RaceData01: "15:50発走 / ダ1200m (右) / 天候:晴 / 馬場:良"
  const data01 = $(".RaceData01").text().replace(/\s+/g, " ").trim();
  const surfaceMatch = data01.match(/(芝|ダ)[^\d]*(\d+)m/);
  const surface = surfaceMatch
    ? surfaceMatch[1] === "ダ" ? "ダート" : "芝"
    : "";
  const distance = surfaceMatch ? surfaceMatch[2] : "";
  const weatherMatch = data01.match(/天候[:：]\s*(\S+)/);
  const weather = weatherMatch ? weatherMatch[1] : "";
  const conditionMatch = data01.match(/馬場[:：]\s*(\S+)/);
  const condition = conditionMatch ? conditionMatch[1] : "";

  // RaceData02: "<span>2回</span><span>門別</span><span>1日目</span>"
  const data02Spans = $(".RaceData02 span");
  const kaisai = $(data02Spans[0]).text().trim();
  const basho = $(data02Spans[1]).text().trim();
  const nichime = $(data02Spans[2]).text().trim();

  const raceInfo = {
    競馬場名: basho,
    開催: kaisai,
    開催日: nichime,
    レース名: raceName,
    クラス: raceClass,
    "芝/ダート": surface,
    距離: distance,
    天候: weather,
    馬場: condition,
  };

  // --- コーナー通過順位 ---
  const cornerByHorse = parseCornerPassing($);

  // --- Result table ---
  const rows = [];
  $("#All_Result_Table tbody tr").each((i, tr) => {
    const tds = $(tr).find("td");
    if (tds.length === 0) return;

    // 列構成:
    // 0: 着順 (.Result_Num .Rank)
    // 1: 枠番 (.Num .Waku*)
    // 2: 馬番 (.Num .Waku)
    // 3: 馬名 (.Horse_Info .Horse_Name a)
    // 4: 性齢 (.Horse_Info .Detail_Left)
    // 5: 斤量 (.Jockey_Info .JockeyWeight)
    // 6: 騎手 (.Jockey a)
    // 7: タイム (.Time .RaceTime) - 走破タイム
    // 8: 着差 (.Time .RaceTime)
    // 9: 人気 (.Odds .OddsPeople)
    // 10: 単勝オッズ (.Odds .Odds_Ninki)
    // 11: 後3F (.Time)
    // 12: 厩舎 (.Trainer)
    // 13: 馬体重 (.Weight)

    const chakujun = $(tds[0]).find(".Rank").text().trim();
    const wakuban = $(tds[1]).find("div").text().trim();
    const umaban = $(tds[2]).find("div").text().trim();
    const bamei = $(tds[3]).find(".Horse_Name a").text().trim();
    const seirei = $(tds[4]).find(".Detail_Left").text().replace(/\s+/g, "").trim();
    const kinryo = $(tds[5]).find(".JockeyWeight").text().trim();
    const kishu = $(tds[6]).find("a").text().replace(/\s+/g, "").trim();
    const time = $(tds[7]).find(".RaceTime").text().trim();
    const chakusa = $(tds[8]).find(".RaceTime").text().trim();
    const ninki = $(tds[9]).find(".OddsPeople").text().trim();
    const odds = $(tds[10]).find(".Odds_Ninki").text().trim();
    const agari3f = $(tds[11]).text().replace(/\s+/g, "").trim();
    const weight = $(tds[13]).text().replace(/\s+/g, "").trim();
    const passing = (cornerByHorse[umaban] || []).join("-");

    rows.push({
      着順: chakujun,
      枠番: wakuban,
      馬番: umaban,
      馬名: bamei,
      性齢: seirei,
      斤量: kinryo,
      騎手: kishu,
      タイム: time,
      着差: chakusa,
      通過: passing,
      上がり: agari3f,
      人気: ninki,
      単勝オッズ: odds,
      馬体重: weight,
    });
  });

  if (rows.length === 0) {
    throw new Error(`No data found for race_id: ${raceId}`);
  }

  // --- Build CSV ---
  const raceInfoHeaders = [
    "競馬場名", "開催", "開催日", "レース名", "クラス", "芝/ダート", "距離", "天候", "馬場",
  ];
  const headers = [
    ...raceInfoHeaders,
    "着順", "枠番", "馬番", "馬名", "性齢", "斤量", "騎手",
    "タイム", "着差", "通過", "上がり", "人気", "単勝オッズ", "馬体重",
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

  const outputPath = path.join(__dirname, "..", "nar_race_result") + "/";
  const outputFile = `${outputPath}result_${raceId}.csv`;
  fs.writeFileSync(outputFile, csvLines.join("\n"), "utf-8");
  console.log(`Saved: ${outputFile} (${rows.length} rows)`);
}

// netkeiba NAR keibajo_code → 会場名（対応会場を増やす際はここに追加）
const NAR_VENUES = {
  "30": "門別",
  "35": "盛岡",
  "36": "水沢",
  "42": "浦和",
  "43": "船橋",
  "44": "大井",
  "45": "川崎",
};
// 現在スクレイピング対象にしている会場
const NAR_ACTIVE_CODES = ["30", "35", "36", "42", "43", "44", "45"];

module.exports = { scrapeNarRaceResult, parseClass, NAR_VENUES, NAR_ACTIVE_CODES };

// CLI direct execution
if (require.main === module) {
  const raceId = process.argv[2];
  if (!raceId) {
    console.error("Usage: node nar_scraper.js <race_id>");
    console.error("  e.g. node nar_scraper.js 202630042903");
    process.exit(1);
  }
  try {
    scrapeNarRaceResult(raceId);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
