// キャリブレーション検証（時間窓付き・分割標本）
// 同一馬・同一路面・同一距離帯・±120日以内・異会場ペアに対し、
// 指定キャリブレーションを適用した上でのセル別平均残差を算出する。
// 分割標本検証: 偶数年ペアで推定した offset を --calib で渡し、
// --verify-years odd で奇数年ペアのみで検証する（循環のない汎化評価）。
// 合否基準: 検証ペア数が十分なセルで |残差| <= 0.5
// 使い方:
//   node scripts/verify_venue_calibration.js --calib /tmp/calib_even.json --verify-years odd
//   node scripts/verify_venue_calibration.js --no-calib --verify-years odd   # 補正なしベースライン
const fs = require("fs");
const path = require("path");

const indirIdx = process.argv.indexOf("--indir");
const RACE_INDEX_DIR = indirIdx >= 0
  ? path.resolve(process.argv[indirIdx + 1])
  : path.join(__dirname, "..", "race_index");
const SINCE_YEAR = 2014;
const WINDOW_DAYS = 120;
const MIN_VERIFY_PAIRS = 300;
const THRESHOLD = 0.5;

const calibIdx = process.argv.indexOf("--calib");
const CALIB_FILE = process.argv.includes("--no-calib")
  ? null
  : calibIdx >= 0 ? path.resolve(process.argv[calibIdx + 1]) : path.join(__dirname, "..", "venue_calibration.json");
const vyIdx = process.argv.indexOf("--verify-years");
const VERIFY_YEARS = vyIdx >= 0 ? process.argv[vyIdx + 1] : "all";

const VENUES = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];
const bandOfDist = d => (d <= 1400 ? "短" : d <= 2000 ? "中" : "長");

function splitCSV(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function dateToDays(dateStr) {
  const m = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])) / 86400000;
}

function main() {
  // キャリブレーション読み込み（期間別・距離帯別）
  let calibPeriods = null;
  if (CALIB_FILE && fs.existsSync(CALIB_FILE)) {
    const calib = JSON.parse(fs.readFileSync(CALIB_FILE, "utf-8"));
    calibPeriods = calib.periods.map(p => {
      const map = {};
      for (const o of p.offsets) map[`${o["芝/ダート"]}_${o.競馬場}_${o.距離帯}`] = o.offset;
      return { from: p.from, to: p.to, map };
    });
    console.log(`Calibration: ${CALIB_FILE} (fitYears=${calib.params.fitYears || "?"}, ${calibPeriods.length} periods)`);
  } else {
    console.log("Calibration: なし（ベースライン）");
  }
  const offsetOf = (surf, venue, band, year) => {
    if (!calibPeriods) return 0;
    const pd = calibPeriods.find(p => year >= p.from && year <= p.to)
      || (year < calibPeriods[0].from ? calibPeriods[0] : calibPeriods[calibPeriods.length - 1]);
    return pd.map[`${surf}_${venue}_${band}`] || 0;
  };

  const files = fs.readdirSync(RACE_INDEX_DIR).filter(f => {
    if (!f.endsWith(".csv")) return false;
    return parseInt(f.slice(6, 10)) >= SINCE_YEAR;
  });

  const horses = {};
  for (const f of files) {
    const lines = fs.readFileSync(path.join(RACE_INDEX_DIR, f), "utf-8").split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const headers = splitCSV(lines[0]);
    const col = {};
    headers.forEach((h, i) => col[h] = i);
    if (col["総合指数"] === undefined || col["日付"] === undefined) continue;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCSV(lines[i]);
      const name = c[col["馬名"]];
      const venue = c[col["競馬場名"]];
      const surf = c[col["芝/ダート"]];
      const dist = parseInt(c[col["距離"]]);
      const idx = parseFloat(c[col["総合指数"]]);
      if (!name || !VENUES.includes(venue) || isNaN(idx) || isNaN(dist)) continue;
      if (col["参考"] !== undefined && c[col["参考"]] === "1") continue;
      const day = dateToDays(c[col["日付"]]);
      if (day === null) continue;
      const year = new Date(day * 86400000).getUTCFullYear();
      const band = bandOfDist(dist);
      // 補正後指数（offset減算）
      const cIdx = idx - offsetOf(surf, venue, band, year);
      if (!horses[name]) horses[name] = [];
      horses[name].push({ venue, surf, band, day, idx: cIdx });
    }
  }
  console.log(`馬数: ${Object.keys(horses).length}, 検証年: ${VERIFY_YEARS}`);

  // セル別残差集計: key = "surf_venue_band" → { sum, n }
  const cells = {};
  for (const name in horses) {
    const runs = horses[name];
    runs.sort((a, b) => a.day - b.day);
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[j].day - runs[i].day > WINDOW_DAYS) break;
        const a = runs[i], b = runs[j];
        if (a.surf !== b.surf || a.band !== b.band || a.venue === b.venue) continue;
        const midYear = new Date((a.day + b.day) / 2 * 86400000).getUTCFullYear();
        if (VERIFY_YEARS === "even" && midYear % 2 !== 0) continue;
        if (VERIFY_YEARS === "odd" && midYear % 2 !== 1) continue;
        const d = a.idx - b.idx;
        const ka = `${a.surf}_${a.venue}_${a.band}`;
        const kb = `${b.surf}_${b.venue}_${b.band}`;
        if (!cells[ka]) cells[ka] = { sum: 0, n: 0 };
        if (!cells[kb]) cells[kb] = { sum: 0, n: 0 };
        cells[ka].sum += d;
        cells[ka].n++;
        cells[kb].sum -= d;
        cells[kb].n++;
      }
    }
  }

  // 会場×路面レベル（帯集約）も算出
  const vcells = {};
  for (const [k, c] of Object.entries(cells)) {
    const [surf, venue] = k.split("_");
    const vk = `${surf}_${venue}`;
    if (!vcells[vk]) vcells[vk] = { sum: 0, n: 0 };
    vcells[vk].sum += c.sum;
    vcells[vk].n += c.n;
  }

  console.log("\n=== 会場×路面（帯集約）残差 ===");
  const vrows = Object.entries(vcells).map(([k, c]) => ({ k, d: c.sum / c.n, n: c.n }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  let ngV = 0;
  for (const r of vrows) {
    const flag = Math.abs(r.d) > THRESHOLD ? " ← ±0.5超" : "";
    if (flag) ngV++;
    console.log(`${r.k.padEnd(12)} ${r.d.toFixed(2).padStart(7)} (pairs=${r.n})${flag}`);
  }
  console.log(`±0.5超: ${ngV}/${vrows.length}`);

  console.log(`\n=== 会場×路面×距離帯残差（検証ペア${MIN_VERIFY_PAIRS}以上のみ判定） ===`);
  const brows = Object.entries(cells).map(([k, c]) => ({ k, d: c.sum / c.n, n: c.n }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  let ngB = 0, judged = 0;
  for (const r of brows) {
    if (r.n < MIN_VERIFY_PAIRS) continue;
    judged++;
    const flag = Math.abs(r.d) > THRESHOLD ? " ← ±0.5超" : "";
    if (flag) { ngB++; console.log(`${r.k.padEnd(14)} ${r.d.toFixed(2).padStart(7)} (pairs=${r.n})${flag}`); }
  }
  console.log(`±0.5超: ${ngB}/${judged}（判定対象セル）`);
  // 全体RMS
  const rms = Math.sqrt(brows.filter(r => r.n >= MIN_VERIFY_PAIRS).reduce((a, r) => a + r.d * r.d * r.n, 0)
    / brows.filter(r => r.n >= MIN_VERIFY_PAIRS).reduce((a, r) => a + r.n, 0));
  console.log(`ペア加重RMS残差: ${rms.toFixed(3)}`);
}

main();
