// Stage 1: レース効果補正係数の推定。
// race_index/*.csv（JRA）を路面別に「馬内中心化した総合指数残差」を paceDev / raceEff
// の2変数に重回帰し、係数を反転（打ち消す方向）して出力する。
// NAR（nar_race_index/*.csv）は raceEff のみの単回帰（総合指数のみのため paceDev 不使用）。
//
// 定義（verify_index_health.js と同一であること）:
//   scale = ダート: 0.000425*dist+0.352 / 芝: dist/2000
//   paceDev = (先頭馬前半 − (基準前半秒 + babaDiff*0.6)) / scale
//   raceEff = レース別馬場差(距離補正済み秒)/scale − 日次馬場差（レース別が無ければ0）
//
// 使い方: node scripts/build_race_calibration.js [--since 2019] [--indir race_index]
//         [--nar-indir nar_race_index] [--out race_effect_calibration.json]

const fs = require("fs");
const path = require("path");
const { parseCSVLine } = require("./csv_util");

const ROOT = path.join(__dirname, "..");

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const SINCE = parseInt(argVal("--since", "2019"));
const JRA_INDIR = path.join(ROOT, argVal("--indir", "race_index"));
const NAR_INDIR = path.join(ROOT, argVal("--nar-indir", "nar_race_index"));
const OUT_FILE = path.isAbsolute(argVal("--out", "race_effect_calibration.json"))
  ? argVal("--out", "race_effect_calibration.json")
  : path.join(ROOT, argVal("--out", "race_effect_calibration.json"));

const BASE_TIMES_FILE = path.join(ROOT, "base_times.json");
const BABA_DIFF_FILE = path.join(ROOT, "baba_diff.json");
const NAR_BABA_DIFF_FILE = path.join(ROOT, "nar_baba_diff.json");

const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;
const MIN_BT_SAMPLES = 20;

// calc_index.js / verify_index_health.js と同一ロジック
function classifyRace(className) {
  if (!className) return null;
  if (className.includes("障害")) return null;
  let age;
  if (className.includes("2歳")) age = "2歳";
  else if (className.includes("4歳以上")) age = "4歳以上";
  else if (className.includes("3歳以上")) age = "3歳以上";
  else if (className.includes("3歳")) age = "3歳";
  else age = "3歳以上";
  if (className.includes("新馬")) return `${age}新馬`;
  if (className.includes("未勝利")) return `${age}未勝利`;
  if (className.includes("1勝") || className.includes("500万下")) return `${age}1勝`;
  if (className.includes("2勝") || className.includes("1000万下")) return `${age}2勝`;
  if (className.includes("3勝") || className.includes("1600万下")) return `${age}3勝`;
  if (className.includes("オープン") || className.includes("OP")) return `${age}OP`;
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return `${age}OP`;
  return null;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

// 単回帰: y ~ x
function reg1(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
    dy2 += (ys[i] - my) ** 2;
  }
  return { slope: num / den, r: num / Math.sqrt(den * dy2) };
}
// 重回帰: y ~ x1 + x2
function reg2(x1, x2, y) {
  const n = y.length;
  const m1 = x1.reduce((a, b) => a + b, 0) / n;
  const m2 = x2.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0;
  for (let i = 0; i < n; i++) {
    const a = x1[i] - m1, b = x2[i] - m2, c = y[i] - my;
    s11 += a * a; s22 += b * b; s12 += a * b; s1y += a * c; s2y += b * c;
  }
  const det = s11 * s22 - s12 * s12;
  return { b1: (s22 * s1y - s12 * s2y) / det, b2: (s11 * s2y - s12 * s1y) / det };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function buildJra() {
  if (!fs.existsSync(JRA_INDIR)) {
    console.warn(`JRA indir not found: ${JRA_INDIR}`);
    return null;
  }
  const baseTimes = JSON.parse(fs.readFileSync(BASE_TIMES_FILE, "utf-8"));
  const baseMap = {};
  for (const bt of baseTimes) baseMap[`${bt["芝/ダート"]}_${bt.競馬場}_${bt.距離}_${bt.クラス}`] = bt;
  function getBaseTimes(surface, venue, dist, ageClass) {
    const key = `${surface}_${venue}_${dist}_${ageClass}`;
    const bt = baseMap[key];
    if (bt && bt.サンプル数 >= MIN_BT_SAMPLES) return { bt, matchedClass: ageClass };
    const grade = ageClass.replace(/^(2歳|3歳|3歳以上|4歳以上)/, "");
    const fallbacks = ["3歳以上", "4歳以上"];
    for (const fb of fallbacks) {
      const fbClass = `${fb}${grade}`;
      const fbBt = baseMap[`${surface}_${venue}_${dist}_${fbClass}`];
      if (fbBt && fbBt.サンプル数 >= MIN_BT_SAMPLES) return { bt: fbBt, matchedClass: fbClass };
    }
    if (bt) return { bt, matchedClass: ageClass };
    for (const fb of fallbacks) {
      const fbClass = `${fb}${grade}`;
      const fbBt = baseMap[`${surface}_${venue}_${dist}_${fbClass}`];
      if (fbBt) return { bt: fbBt, matchedClass: fbClass };
    }
    return null;
  }

  const babaDiffs = JSON.parse(fs.readFileSync(BABA_DIFF_FILE, "utf-8"));
  const babaMap = {};
  for (const b of babaDiffs) babaMap[`${b.日付}_${b.競馬場}`] = b;

  const files = fs.readdirSync(JRA_INDIR).filter(f => f.endsWith(".csv") && +f.slice(6, 10) >= SINCE);
  console.log(`[JRA] files: ${files.length} (${SINCE}+)`);

  const obs = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(JRA_INDIR, f), "utf-8").split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const H = parseCSVLine(lines[0]);
    const col = {};
    H.forEach((h, i) => (col[h] = i));
    if (col["総合指数"] === undefined) continue;

    const r0 = parseCSVLine(lines[1]);
    const venue = r0[col["競馬場名"]];
    const surface = r0[col["芝/ダート"]];
    const dist = parseInt(r0[col["距離"]]);
    if ((surface !== "芝" && surface !== "ダート") || isNaN(dist)) continue;

    const ageClass = classifyRace(r0[col["クラス"]]);
    if (!ageClass) continue;
    const btResult = getBaseTimes(surface, venue, r0[col["距離"]], ageClass);
    if (!btResult) continue;
    const { bt } = btResult;

    const dm = (r0[col["日付"]] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!dm) continue;
    const date = `${dm[1]}/${dm[2].padStart(2, "0")}/${dm[3].padStart(2, "0")}`;

    const rec = babaMap[`${date}_${venue}`];
    if (!rec) continue;

    const raceNum = String(parseInt(f.slice(16, 18)));
    const scale = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : dist / 2000;
    const dayVal = surface === "芝" ? rec.芝馬場差 : rec.ダート馬場差;
    if (dayVal === null || dayVal === undefined) continue;

    let raceBaba = null;
    if (rec.レース別馬場差 && typeof rec.レース別馬場差[raceNum] === "number") {
      raceBaba = rec.レース別馬場差[raceNum];
    }
    const babaDiff = raceBaba !== null ? raceBaba : dayVal * scale;
    const raceEff = raceBaba !== null ? raceBaba / scale - dayVal : 0;

    let leaderEarly = Infinity;
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = parseCSVLine(lines[i]);
      if (!/^\d+$/.test(c[col["着順"]])) continue;
      const sec = timeToSeconds(c[col["タイム"]]);
      const a3 = parseFloat(c[col["上がり"]]);
      if (!sec || !a3 || isNaN(a3)) continue;
      const early = sec - a3;
      if (early < leaderEarly) leaderEarly = early;
      rows.push(c);
    }
    if (!rows.length || leaderEarly === Infinity) continue;

    const paceDev = (leaderEarly - (bt.基準前半秒 + babaDiff * 0.6)) / scale;

    for (const c of rows) {
      const total = parseFloat(c[col["総合指数"]]);
      if (isNaN(total)) continue;
      obs.push({ horse: c[col["馬名"]], total, paceDev, raceEff, surface });
    }
  }
  console.log(`[JRA] obs: ${obs.length}`);

  const byHorse = new Map();
  for (const o of obs) {
    if (!byHorse.has(o.horse)) byHorse.set(o.horse, []);
    byHorse.get(o.horse).push(o);
  }
  for (const [, list] of byHorse) {
    if (list.length < 3) continue;
    const mT = list.reduce((s, o) => s + o.total, 0) / list.length;
    for (const o of list) { o.rT = o.total - mT; o.use = true; }
  }
  const U = obs.filter(o => o.use);
  console.log(`[JRA] centered obs (horses>=3 runs): ${U.length}`);

  const jra = {};
  for (const surf of ["芝", "ダート"]) {
    const S = U.filter(o => o.surface === surf);
    const pace = S.map(o => o.paceDev);
    const reff = S.map(o => o.raceEff);
    const jT = reg2(pace, reff, S.map(o => o.rT));
    const gamma = round3(-jT.b1);
    const kappa = round3(-jT.b2);
    jra[surf] = { gamma, kappa, n: S.length, b_pace: round3(jT.b1), b_raceEff: round3(jT.b2) };
    console.log(`[JRA] ${surf}: n=${S.length} gamma=${gamma} kappa=${kappa} (b_pace=${jT.b1.toFixed(3)}, b_raceEff=${jT.b2.toFixed(3)})`);
  }
  return jra;
}

function extractDateFromIndexFile(filename) {
  const id = filename.replace("index_", "").replace(".csv", "");
  const year = id.substring(0, 4);
  const mm = id.substring(6, 8);
  const dd = id.substring(8, 10);
  return `${year}/${mm}/${dd}`;
}

function buildNar() {
  if (!fs.existsSync(NAR_INDIR)) {
    console.warn(`NAR indir not found: ${NAR_INDIR}`);
    return null;
  }
  if (!fs.existsSync(NAR_BABA_DIFF_FILE)) {
    console.warn(`NAR baba diff not found: ${NAR_BABA_DIFF_FILE}`);
    return null;
  }
  const babaDiffs = JSON.parse(fs.readFileSync(NAR_BABA_DIFF_FILE, "utf-8"));
  const babaMap = {};
  for (const b of babaDiffs) babaMap[`${b.日付}_${b.競馬場}`] = b;

  const files = fs.readdirSync(NAR_INDIR).filter(f => f.endsWith(".csv") && +f.slice(6, 10) >= SINCE);
  console.log(`[NAR] files: ${files.length} (${SINCE}+)`);

  const obs = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(NAR_INDIR, f), "utf-8").split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const H = parseCSVLine(lines[0]);
    const col = {};
    H.forEach((h, i) => (col[h] = i));
    if (col["総合指数"] === undefined) continue;

    const r0 = parseCSVLine(lines[1]);
    const venue = r0[col["競馬場名"]];
    const surface = r0[col["芝/ダート"]];
    const dist = parseInt(r0[col["距離"]]);
    if ((surface !== "芝" && surface !== "ダート") || isNaN(dist)) continue;

    const date = extractDateFromIndexFile(f);
    const rec = babaMap[`${date}_${venue}`];
    if (!rec) continue;

    const raceNum = String(parseInt(f.slice(16, 18)));
    const scale = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : dist / 2000;
    const dayVal = surface === "芝" ? rec.芝馬場差 : rec.ダート馬場差;
    if (dayVal === null || dayVal === undefined) continue;

    let raceBaba = null;
    if (rec.レース別馬場差 && typeof rec.レース別馬場差[raceNum] === "number") {
      raceBaba = rec.レース別馬場差[raceNum];
    }
    const raceEff = raceBaba !== null ? raceBaba / scale - dayVal : 0;

    for (let i = 1; i < lines.length; i++) {
      const c = parseCSVLine(lines[i]);
      if (!/^\d+$/.test(c[col["着順"]])) continue;
      const total = parseFloat(c[col["総合指数"]]);
      if (isNaN(total)) continue;
      obs.push({ horse: c[col["馬名"]], total, raceEff, surface });
    }
  }
  console.log(`[NAR] obs: ${obs.length}`);

  const byHorse = new Map();
  for (const o of obs) {
    if (!byHorse.has(o.horse)) byHorse.set(o.horse, []);
    byHorse.get(o.horse).push(o);
  }
  for (const [, list] of byHorse) {
    if (list.length < 3) continue;
    const mT = list.reduce((s, o) => s + o.total, 0) / list.length;
    for (const o of list) { o.rT = o.total - mT; o.use = true; }
  }
  const U = obs.filter(o => o.use);
  console.log(`[NAR] centered obs (horses>=3 runs): ${U.length}`);

  const nar = {};
  for (const surf of ["ダート", "芝"]) {
    const S = U.filter(o => o.surface === surf);
    if (S.length < 100) { console.log(`[NAR] ${surf}: skipped (n=${S.length} < 100)`); continue; }
    const reff = S.map(o => o.raceEff);
    const rT = S.map(o => o.rT);
    const r1 = reg1(reff, rT);
    const kappa = round3(-r1.slope);
    nar[surf] = { kappa, n: S.length, b_raceEff: round3(r1.slope) };
    console.log(`[NAR] ${surf}: n=${S.length} kappa=${kappa} (b_raceEff=${r1.slope.toFixed(3)}, r=${r1.r.toFixed(3)})`);
  }
  return nar;
}

function main() {
  const jra = buildJra();
  const nar = buildNar();
  const result = {
    generated: new Date().toISOString(),
    since: SINCE,
    method: "centered-residual-slope-zeroing",
  };
  if (jra) result.jra = jra;
  if (nar) result.nar = nar;
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\nSaved: ${OUT_FILE}`);
  console.log(JSON.stringify(result, null, 2));
}

main();
