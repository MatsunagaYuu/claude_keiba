/**
 * patch_baba_from_detail.js
 *
 * baba.php で欠落（null）している開催日の馬場差を
 * time_analysis.php の個別レースデータから逆算して補完するスクリプト。
 *
 * 使い方:
 *   node scripts/patch_baba_from_detail.js <日付> <競馬場>
 *   node scripts/patch_baba_from_detail.js 2024/11/16 東京
 *   node scripts/patch_baba_from_detail.js 2024-11-16 05       # jyoコードでも可
 *   node scripts/patch_baba_from_detail.js 2025/08/10 新潟 --dry-run
 *
 * オプション:
 *   --dry-run      JSONを更新せず変更内容のみ表示
 *   --force        既に値がある場合でも上書き
 *   --allow-derive 芝T2000がない場合に他距離から逆算（デフォルトは参考状態維持）
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const cheerio = require("cheerio");

const OUTPUT_FILE = path.join(__dirname, "..", "external_baba_diff.json");

// ダートスケーリング係数 (calc_index.js と統一)
const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;

const VENUES = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟",
  "05": "東京", "06": "中山", "07": "中京", "08": "京都",
  "09": "阪神", "10": "小倉",
};
const VENUE_TO_CODE = Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [v, k]));

// 引数パース
function parseArgs() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const opts = process.argv.slice(2).filter(a => a.startsWith("--"));
  const dryRun      = opts.includes("--dry-run");
  const force       = opts.includes("--force");
  const allowDerive = opts.includes("--allow-derive");

  if (args.length < 2) {
    console.error("使い方: node scripts/patch_baba_from_detail.js <日付> <競馬場> [--dry-run] [--force]");
    console.error("例:     node scripts/patch_baba_from_detail.js 2024/11/16 東京");
    process.exit(1);
  }

  // 日付正規化: "2024-11-16" → "2024/11/16"
  const dateRaw = args[0].replace(/-/g, "/");
  const dateParts = dateRaw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!dateParts) {
    console.error(`日付フォーマットが不正です: ${args[0]}（YYYY/MM/DD または YYYY-MM-DD）`);
    process.exit(1);
  }
  const date     = dateRaw;           // "2024/11/16"
  const year     = parseInt(dateParts[1]);
  const dayParam = dateRaw.replace(/\//g, "-"); // "2024-11-16"

  // 会場解決
  const venueArg = args[1];
  let jyoCode, venueName;
  if (/^\d{2}$/.test(venueArg)) {
    jyoCode   = venueArg;
    venueName = VENUES[venueArg];
  } else {
    venueName = venueArg;
    jyoCode   = VENUE_TO_CODE[venueArg];
  }
  if (!jyoCode || !venueName) {
    console.error(`競馬場が認識できません: ${venueArg}`);
    console.error(`有効値: ${Object.values(VENUES).join(" / ")}`);
    process.exit(1);
  }

  return { date, year, dayParam, jyoCode, venueName, dryRun, force, allowDerive };
}

// time_analysis.php 取得（curl + iconv）
function fetchPage(year, dayParam, jyoCode) {
  const jyoNum = parseInt(jyoCode).toString(); // "05" → "5"
  const url = `https://ittai.net/RK/time_analysis.php?year=${year}&day=${dayParam}&jyo=${jyoNum}`;
  const tmpFile = `/tmp/patch_baba_${jyoCode}_${dayParam}.html`;
  const tmpUtf  = tmpFile + ".utf8";

  console.log(`取得中: ${url}`);
  const result = spawnSync("curl", ["-s", "-o", tmpFile, "-w", "%{http_code}", url], { timeout: 20000 });
  const code = (result.stdout || "").toString().trim();

  if (result.error) throw new Error(`curl失敗: ${result.error.message}`);
  if (code !== "200") {
    console.error(`HTTP ${code}: ${url}`);
    process.exit(1);
  }

  // Shift_JIS → UTF-8 変換
  const iconvResult = spawnSync("iconv", ["-f", "SHIFT_JIS", "-t", "UTF-8", tmpFile]);
  if (!iconvResult.error && iconvResult.status === 0) {
    fs.writeFileSync(tmpFile, iconvResult.stdout);
  }

  return fs.readFileSync(tmpFile, "utf-8");
}

// 馬場差文字列パース: "---", "設定不可" → null
function parseBabaDiff(str) {
  if (!str) return null;
  const s = str.trim();
  if (s === "---" || s === "設定不可" || s === "") return null;
  const val = parseFloat(s.replace(/±/g, "0").replace(/\+/g, ""));
  return isNaN(val) ? null : val;
}

/**
 * HTMLからレース別馬場差を抽出
 * 返り値: { turf: [{dist, raceNum, baba}], dirt: [{dist, raceNum, baba}] }
 *
 * 列順: R, 距離, 状, 勝ち馬, 2着, 性齢, 条件, 走破T, T差, P補正, 完T差, 馬場差, WL, TL, ML, 次走
 */
function extractRaceData(html) {
  const $ = cheerio.load(html);
  const turf = [];
  const dirt = [];

  $("table.table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 12) return;

    const rText    = $(tds[0]).text().trim();
    const distText = $(tds[1]).text().trim();
    const babaText = $(tds[11]).text().trim();

    const rMatch    = rText.match(/^(\d+)R$/);
    const distMatch = distText.match(/^([TD])(\d{3,4})$/);
    if (!rMatch || !distMatch) return;

    const raceNum = parseInt(rMatch[1]);
    const surface = distMatch[1] === "T" ? "芝" : "ダート";
    const dist    = parseInt(distMatch[2]);
    const baba    = parseBabaDiff(babaText);

    if (baba === null) {
      console.log(`  ${raceNum}R (${distText}): 設定不可 → スキップ`);
      return;
    }

    (surface === "芝" ? turf : dirt).push({ raceNum, dist, baba });
  });

  return { turf, dirt };
}

/**
 * 芝馬場差を算出
 * calc_index.js: babaDiff = 芝馬場差 * (dist / 2000)
 * T2000レースが必須。設定不可または未施行の場合は null を返す（参考状態維持）。
 * --allow-derive を指定した場合のみ他距離から逆算して平均を返す。
 */
function calcTurfBaba(turfRaces, allowDerive = false) {
  if (turfRaces.length === 0) return null;

  const t2000 = turfRaces.find(r => r.dist === 2000);
  if (t2000) {
    console.log(`  芝: T2000 (${t2000.raceNum}R) の値 ${t2000.baba} を採用`);
    return t2000.baba;
  }

  if (!allowDerive) {
    console.log(`  芝: T2000レースなし（設定不可 or 未施行）→ null のまま（参考状態維持）`);
    console.log(`       他距離から逆算する場合は --allow-derive を指定してください`);
    return null;
  }

  const normalized = turfRaces.map(r => r.baba * (2000 / r.dist));
  const avg = normalized.reduce((s, v) => s + v, 0) / normalized.length;
  const avgRounded = Math.round(avg * 10) / 10;
  console.log(`  芝: T2000なし → ${turfRaces.map((r, i) => `${r.raceNum}R(T${r.dist})→${normalized[i].toFixed(2)}`).join(", ")} → 平均 ${avgRounded}`);
  return avgRounded;
}

/**
 * ダート馬場差を算出
 * calc_index.js: babaDiff = ダート馬場差 * (SCALE_A * dist + SCALE_B)
 * 逆算: ダート馬場差 = race_baba / (SCALE_A * dist + SCALE_B)
 * 全レース平均（距離スケーリングを逆算して正規化）
 */
function calcDirtBaba(dirtRaces) {
  if (dirtRaces.length === 0) return null;

  const normalized = dirtRaces.map(r => r.baba / (DIRT_SCALE_A * r.dist + DIRT_SCALE_B));
  const avg = normalized.reduce((s, v) => s + v, 0) / normalized.length;
  const avgRounded = Math.round(avg * 10) / 10;
  console.log(`  ダ: ${dirtRaces.map((r, i) => `${r.raceNum}R(D${r.dist})→${normalized[i].toFixed(2)}`).join(", ")} → 平均 ${avgRounded}`);
  return avgRounded;
}

function main() {
  const { date, year, dayParam, jyoCode, venueName, dryRun, force, allowDerive } = parseArgs();

  console.log(`\n=== ${date} ${venueName} の馬場差補完 ===`);
  if (dryRun) console.log("（--dry-run モード: JSONは更新しません）");

  // 既存エントリ確認（なければ新規作成）
  const allData = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  const idx = allData.findIndex(r => r["日付"] === date && r["競馬場"] === venueName);
  let entry;
  if (idx < 0) {
    console.log(`エントリなし → 新規エントリを作成します`);
    entry = {
      年: year, 競馬場: venueName, 日付: date,
      回: null, 日次: null, コース区分: null,
      芝馬場差: null, 芝馬場差変動前: null,
      ダート馬場差: null, ダート馬場差変動前: null,
      芝G前含水率: null, 芝4角含水率: null, クッション値: null,
      ダートG前含水率: null, ダート4角含水率: null,
    };
    allData.push(entry);
  } else {
    entry = allData[idx];
    console.log(`既存エントリ: 芝馬場差=${entry["芝馬場差"]}, ダート馬場差=${entry["ダート馬場差"]}`);
  }

  if (!force && idx >= 0 && entry["芝馬場差"] !== null && entry["ダート馬場差"] !== null) {
    console.log("両馬場差が既に設定済みです。上書きするには --force を指定してください。");
    process.exit(0);
  }

  // HTML取得・解析
  const html = fetchPage(year, dayParam, jyoCode);
  const { turf, dirt } = extractRaceData(html);

  console.log(`\n取得結果: 芝 ${turf.length}レース, ダート ${dirt.length}レース`);
  if (turf.length > 0) console.log(`  芝:   ${turf.map(r => `${r.raceNum}R T${r.dist}=${r.baba}`).join(", ")}`);
  if (dirt.length > 0) console.log(`  ダート: ${dirt.map(r => `${r.raceNum}R D${r.dist}=${r.baba}`).join(", ")}`);

  // 馬場差計算
  console.log("\n馬場差算出:");
  const newTurfBaba = (!force && entry["芝馬場差"] !== null) ? entry["芝馬場差"] : calcTurfBaba(turf, allowDerive);
  const newDirtBaba = (!force && entry["ダート馬場差"] !== null) ? entry["ダート馬場差"] : calcDirtBaba(dirt);

  // レース別馬場差（全レースをまとめる）
  const raceBaba = {};
  for (const r of [...turf, ...dirt]) {
    raceBaba[String(r.raceNum)] = r.baba;
  }

  // 変更内容表示
  console.log("\n変更内容:");
  const turfChanged = entry["芝馬場差"] !== newTurfBaba;
  const dirtChanged = entry["ダート馬場差"] !== newDirtBaba;
  console.log(`  芝馬場差:     ${entry["芝馬場差"]} → ${newTurfBaba}${turfChanged ? "" : "（変更なし）"}`);
  console.log(`  ダート馬場差: ${entry["ダート馬場差"]} → ${newDirtBaba}${dirtChanged ? "" : "（変更なし）"}`);
  console.log(`  レース別馬場差: ${JSON.stringify(raceBaba)}`);

  if (dryRun) {
    console.log("\n--dry-run のため保存をスキップしました。");
    return;
  }

  // エントリ更新
  entry["芝馬場差"]    = newTurfBaba;
  entry["ダート馬場差"] = newDirtBaba;
  if (Object.keys(raceBaba).length > 0) {
    entry["レース別馬場差"] = Object.assign({}, entry["レース別馬場差"] || {}, raceBaba);
  }

  allData.sort((a, b) => a.日付.localeCompare(b.日付) || a.競馬場.localeCompare(b.競馬場));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allData), "utf-8");
  console.log(`\n保存完了: ${OUTPUT_FILE} (${allData.length} records)`);
}

main();
