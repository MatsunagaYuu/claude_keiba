const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cheerio = require("cheerio");

const OUTPUT_FILE = path.join(__dirname, "..", "external_base_times.json");

const VENUES = {
  1: "札幌", 2: "函館", 3: "福島", 4: "新潟",
  5: "東京", 6: "中山", 7: "中京", 8: "京都",
  9: "阪神", 10: "小倉",
};

const YEARS = [];
for (let y = 2018; y <= 2026; y++) YEARS.push(y);

// タイム文字列 → 秒数: "1:09.3" → 69.3, "0:59.0" → 59.0
function timeToSeconds(timeStr) {
  if (!timeStr || !timeStr.trim()) return null;
  const m = timeStr.trim().match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

function fetchPage(year, jyo) {
  const url = `https://ittai.net/RK/KT.php?year=${year}&jyo=${jyo}`;
  try {
    const raw = execSync(
      `curl -s "${url}" | iconv -f SHIFT_JIS -t UTF-8 2>/dev/null`,
      { maxBuffer: 5 * 1024 * 1024, timeout: 30000 }
    );
    return raw.toString();
  } catch (e) {
    console.error(`  Failed to fetch: ${url}`);
    return null;
  }
}

function parsePage(html, year, venue) {
  const $ = cheerio.load(html);
  const results = [];

  // 各基準タイムテーブルを処理
  $("table.table-striped").each((_, table) => {
    const $table = $(table);
    const caption = $table.find("caption").text().trim();
    if (!caption) return;

    // caption例: "2024年1回小倉 (2024/01/13〜2024/02/04)"
    const capMatch = caption.match(/(\d+)年(\d+)回(.+?)\s*\((.+?)〜(.+?)\)/);
    if (!capMatch) return;

    const kaisaiYear = parseInt(capMatch[1]);
    const kai = parseInt(capMatch[2]);
    const venueName = capMatch[3];
    const periodFrom = capMatch[4];
    const periodTo = capMatch[5];

    // ヘッダーから距離とサーフェスを取得
    const headerCells = $table.find("thead tr th, thead tr td").toArray();
    const columns = []; // [{surface, dist}]
    for (const cell of headerCells) {
      const $cell = $(cell);
      const text = $cell.text().trim();
      if (text === "クラス") continue; // 最初の列はクラス名

      const dist = parseInt(text);
      if (isNaN(dist)) continue;

      // bg-success = 芝, bg-dirt = ダート
      const cls = $cell.attr("class") || "";
      let surface;
      if (cls.includes("bg-success")) {
        surface = "芝";
      } else if (cls.includes("bg-dirt")) {
        surface = "ダート";
      } else {
        surface = "不明";
      }
      columns.push({ surface, dist });
    }

    if (columns.length === 0) return;

    // データ行を処理
    $table.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("td").toArray();
      if (cells.length === 0) return;

      const className = $(cells[0]).text().trim();
      if (!className) return;

      // 各距離のタイムを取得
      for (let i = 1; i < cells.length && i - 1 < columns.length; i++) {
        const timeStr = $(cells[i]).text().trim();
        if (!timeStr) continue;

        const sec = timeToSeconds(timeStr);
        if (sec === null) continue;

        const col = columns[i - 1];
        results.push({
          年: kaisaiYear,
          競馬場: venueName,
          回: kai,
          期間開始: periodFrom,
          期間終了: periodTo,
          "芝/ダート": col.surface,
          距離: col.dist,
          クラス: className,
          基準タイム: timeStr,
          基準タイム秒: parseFloat(sec.toFixed(1)),
        });
      }
    });
  });

  return results;
}

function main() {
  const allResults = [];
  let totalPages = 0;

  for (const year of YEARS) {
    for (const [jyo, venue] of Object.entries(VENUES)) {
      console.log(`Fetching: ${year} ${venue} (jyo=${jyo})`);
      const html = fetchPage(year, jyo);
      if (!html) continue;

      const results = parsePage(html, year, venue);
      console.log(`  → ${results.length} entries`);
      allResults.push(...results);
      totalPages++;

      // リクエスト間隔
      if (totalPages > 0) {
        execSync("sleep 1");
      }
    }
  }

  // ソート: 年 → 競馬場 → 回 → 芝/ダート → 距離 → クラス
  allResults.sort((a, b) =>
    a.年 - b.年 ||
    a.競馬場.localeCompare(b.競馬場) ||
    a.回 - b.回 ||
    a["芝/ダート"].localeCompare(b["芝/ダート"]) ||
    a.距離 - b.距離 ||
    a.クラス.localeCompare(b.クラス)
  );

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${allResults.length} entries from ${totalPages} pages)`);
}

main();
