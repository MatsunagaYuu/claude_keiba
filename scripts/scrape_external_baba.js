const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cheerio = require("cheerio");

const OUTPUT_FILE = path.join(__dirname, "..", "external_baba_diff.json");

const VENUES = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟",
  "05": "東京", "06": "中山", "07": "中京", "08": "京都",
  "09": "阪神", "10": "小倉",
};

// 馬場差の文字列をパース: "-2.6～-2.4" → -2.4 (最後の値), "±0" → 0, "---" → null
function parseBabaDiff(str) {
  if (!str || str.trim() === "---" || str.trim() === "") return null;
  let s = str.trim().replace(/±/g, "").replace(/\+/g, "");
  // →または～区切りの場合は最後の値
  if (s.includes("→") || s.includes("～")) {
    const parts = s.split(/[→～]/).map((p) => p.trim());
    s = parts[parts.length - 1];
  }
  const val = parseFloat(s);
  return isNaN(val) ? null : val;
}

// 馬場差の文字列をパース（変動情報付き）: "-2.6～-2.4" → { value: -2.4, from: -2.6 }
function parseBabaDiffFull(str) {
  if (!str || str.trim() === "---" || str.trim() === "") return { value: null, from: null };
  let s = str.trim().replace(/±/g, "").replace(/\+/g, "");
  if (s.includes("→") || s.includes("～")) {
    const parts = s.split(/[→～]/).map(p => p.trim());
    const from = parseFloat(parts[0]);
    const to = parseFloat(parts[parts.length - 1]);
    return { value: isNaN(to) ? null : to, from: isNaN(from) ? null : from };
  }
  const val = parseFloat(s);
  return { value: isNaN(val) ? null : val, from: null };
}

// 含水率パース: "13.7%" → 13.7, "---" → null
function parseMoisture(str) {
  if (!str || str.trim() === "---" || str.trim() === "") return null;
  const val = parseFloat(str.replace(/%/g, "").trim());
  return isNaN(val) ? null : val;
}

// クッション値パース
function parseCushion(str) {
  if (!str || str.trim() === "---" || str.trim() === "") return null;
  const val = parseFloat(str.trim());
  return isNaN(val) ? null : val;
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function scrapeVenueYear(year, jyoCode, venueName) {
  const url = `https://ittai.net/RK/baba.php?year=${year}&jyo=${jyoCode}`;
  const tmpFile = `/tmp/baba_ext_${jyoCode}_${year}.html`;

  try {
    const code = execSync(
      `curl -s -o "${tmpFile}" -w "%{http_code}" "${url}"`,
      { timeout: 20000 }
    ).toString().trim();

    if (code !== "200") {
      console.error(`  HTTP ${code}: ${url}`);
      return [];
    }
  } catch (e) {
    console.error(`  Fetch error: ${url} - ${e.message}`);
    return [];
  }

  // Shift_JIS → UTF-8 変換
  try {
    execSync(`iconv -f SHIFT_JIS -t UTF-8 "${tmpFile}" > "${tmpFile}.utf8" && mv "${tmpFile}.utf8" "${tmpFile}"`);
  } catch {
    // iconv失敗時はそのまま読む
  }
  const html = fs.readFileSync(tmpFile, "utf-8");
  const $ = cheerio.load(html);
  const records = [];

  // ヘッダーから列位置を動的に判定
  // 標準(9-10列): 日付, 回次, 芝, G前含水, 4角含水, クッション値, ダート, [ダ距離], G前含水, 4角含水
  // 新潟(11-12列): 日付, 回次, 芝, 芝直線, G前含水, 4角含水, クッション値, ダート, ダ1200, [G前含水], 4角含水
  // 中京(12-13列): 日付, 回次, 芝, 1400, G前含水, 4角含水, クッション値, ダート, ダ1200, [ダ1400], G前含水, 4角含水
  const table = $("table").eq(1);
  if (!table.length) return records;

  const headerRow = table.find("tr").first();
  const headerTexts = [];
  headerRow.find("th,td").each((_, c) => headerTexts.push($(c).text().trim()));

  // クッション値の列を基準に位置を特定
  const cushionIdx = headerTexts.findIndex((h) => h.includes("クッション"));

  // 「ダート」列を探す
  const dirtIdx = headerTexts.findIndex((h) => h === "ダート");
  if (dirtIdx < 0) return records;

  // ダート距離別列を探す: "ダ1200", "ダ1400", "ダ1600" など
  const dirtDistCols = {};
  for (let i = dirtIdx + 1; i < headerTexts.length; i++) {
    const h = headerTexts[i];
    const distMatch = h.match(/ダ(\d{4})/);
    if (distMatch) {
      const dist = distMatch[1];
      dirtDistCols[dist] = i;
    }
    // 「G前含水」が出たら距離別列の終わり
    if (h.includes("含水")) break;
  }

  let colMap;
  if (cushionIdx >= 0) {
    // 2020年以降: クッション値列あり
    colMap = {
      turf: 2,
      turfMoistGoal: cushionIdx - 2,
      turfMoist4corner: cushionIdx - 1,
      cushion: cushionIdx,
      dirt: dirtIdx,
      dirtDistCols: dirtDistCols,
      dirtMoistGoal: headerTexts.length - 2,
      dirtMoist4corner: headerTexts.length - 1,
    };
  } else {
    // 2019年: クッション値列なし (8列: 日付, 回次, 芝, G前含水, 4角含水, ダート, G前含水, 4角含水)
    colMap = {
      turf: 2,
      turfMoistGoal: 3,
      turfMoist4corner: 4,
      cushion: -1,
      dirt: dirtIdx,
      dirtDistCols: dirtDistCols,
      dirtMoistGoal: headerTexts.length - 2,
      dirtMoist4corner: headerTexts.length - 1,
    };
  }

  table.find("tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < headerTexts.length) return;

    const dateText = $(tds[0]).text().trim();
    const kaisaiText = $(tds[1]).text().trim();

    const dateMatch = dateText.match(/(\d{2})\/(\d{2})/);
    if (!dateMatch) return;
    const fullDate = `${year}/${dateMatch[1]}/${dateMatch[2]}`;

    const kaisaiMatch = kaisaiText.match(/(\d+)回.+?(\d+)日目/);
    const courseMatch = kaisaiText.match(/\(([A-D])\)/);
    const kai = kaisaiMatch ? parseInt(kaisaiMatch[1]) : null;
    const dayNum = kaisaiMatch ? parseInt(kaisaiMatch[2]) : null;
    const course = courseMatch ? courseMatch[1] : null;

    const turfFull = parseBabaDiffFull($(tds[colMap.turf]).text());
    const dirtFull = parseBabaDiffFull($(tds[colMap.dirt]).text());

    const record = {
      年: year,
      競馬場: venueName,
      日付: fullDate,
      回: kai,
      日次: dayNum,
      コース区分: course,
      芝馬場差: turfFull.value,
      芝馬場差変動前: turfFull.from,
      ダート馬場差: dirtFull.value,
      ダート馬場差変動前: dirtFull.from,
      芝G前含水率: parseMoisture($(tds[colMap.turfMoistGoal]).text()),
      芝4角含水率: parseMoisture($(tds[colMap.turfMoist4corner]).text()),
      クッション値: colMap.cushion >= 0 ? parseCushion($(tds[colMap.cushion]).text()) : null,
      ダートG前含水率: parseMoisture($(tds[colMap.dirtMoistGoal]).text()),
      ダート4角含水率: parseMoisture($(tds[colMap.dirtMoist4corner]).text()),
    };

    // ダート距離別馬場差を追加
    if (Object.keys(colMap.dirtDistCols).length > 0) {
      record.ダート距離別馬場差 = {};
      record.ダート距離別馬場差変動前 = {};
      let hasDistFrom = false;
      for (const [dist, colIdx] of Object.entries(colMap.dirtDistCols)) {
        const distFull = parseBabaDiffFull($(tds[colIdx]).text());
        record.ダート距離別馬場差[dist] = distFull.value;
        if (distFull.from !== null) {
          record.ダート距離別馬場差変動前[dist] = distFull.from;
          hasDistFrom = true;
        }
      }
      if (!hasDistFrom) delete record.ダート距離別馬場差変動前;
    }

    records.push(record);
  });

  return records;
}

// 逆引き: 競馬場名 → jyoCode
const VENUE_TO_CODE = {};
for (const [code, name] of Object.entries(VENUES)) {
  VENUE_TO_CODE[name] = code;
}

// time_analysis.php からレース別馬場差を取得
function scrapeRaceBaba(year, dateStr, jyoCode) {
  // dateStr: "2026/01/11" → "2026-01-11"
  const day = dateStr.replace(/\//g, "-");
  const url = `https://ittai.net/RK/time_analysis.php?year=${year}&day=${day}&jyo=${parseInt(jyoCode)}`;
  const tmpFile = `/tmp/race_baba_${jyoCode}_${day}.html`;

  try {
    const code = execSync(
      `curl -s -o "${tmpFile}" -w "%{http_code}" "${url}"`,
      { timeout: 20000 }
    ).toString().trim();

    if (code !== "200") {
      console.error(`    HTTP ${code}: ${url}`);
      return null;
    }
  } catch (e) {
    console.error(`    Fetch error: ${url} - ${e.message}`);
    return null;
  }

  try {
    execSync(`iconv -f SHIFT_JIS -t UTF-8 "${tmpFile}" > "${tmpFile}.utf8" && mv "${tmpFile}.utf8" "${tmpFile}"`);
  } catch {
    // iconv失敗時はそのまま読む
  }
  const html = fs.readFileSync(tmpFile, "utf-8");
  const $ = cheerio.load(html);

  const raceBaba = {};

  // タイム分析テーブル内の各行からR列と馬場差列を取得
  // テーブル構造: R, 距離, 状, 勝ち馬, 2着, 性齢, 条件, 走破T, T差, P補正, 完T差, 馬場差, WL, TL, ML, 次走
  // 馬場差は12列目（0-indexed: 11）
  $("table.table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 12) return;

    const rText = $(tds[0]).text().trim();
    const rMatch = rText.match(/^(\d+)R$/);
    if (!rMatch) return;

    const raceNum = rMatch[1];
    const babaDiffText = $(tds[11]).text().trim();
    const val = parseBabaDiff(babaDiffText);
    if (val !== null) {
      raceBaba[raceNum] = val;
    }
  });

  return Object.keys(raceBaba).length > 0 ? raceBaba : null;
}

function main() {
  const yearStart = parseInt(process.argv[2]) || 2019;
  const yearEnd = parseInt(process.argv[3]) || 2025;
  const allData = [];

  for (let year = yearStart; year <= yearEnd; year++) {
    for (const [code, name] of Object.entries(VENUES)) {
      process.stdout.write(`${year} ${name}...`);
      const records = scrapeVenueYear(year, code, name);
      allData.push(...records);
      console.log(` ${records.length} days`);
      sleep(2000);
    }
  }

  // 変動ありの開催日にレース別馬場差を取得
  let raceBabaCount = 0;
  for (const record of allData) {
    const hasVariation = record.芝馬場差変動前 !== null || record.ダート馬場差変動前 !== null;
    if (!hasVariation) continue;

    const jyoCode = VENUE_TO_CODE[record.競馬場];
    if (!jyoCode) continue;

    process.stdout.write(`  Race baba: ${record.日付} ${record.競馬場}...`);
    sleep(2000);
    const raceBaba = scrapeRaceBaba(record.年, record.日付, jyoCode);
    if (raceBaba) {
      record.レース別馬場差 = raceBaba;
      raceBabaCount++;
      console.log(` ${Object.keys(raceBaba).length} races`);
    } else {
      console.log(` no data`);
    }
  }
  console.log(`Race baba fetched: ${raceBabaCount} days`);

  // 日付ソート
  allData.sort((a, b) => a.日付.localeCompare(b.日付) || a.競馬場.localeCompare(b.競馬場));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allData, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${allData.length} records)`);
}

main();
