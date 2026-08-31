// 指数の健全性検証（Stage 0 基線測定）。
// race_index/*.csv（JRA, 既定2019年以降）・base_times.json・baba_diff.json を読み、
// 以下を算出する:
//   1. 馬内中心化残差の回帰傾き（paceDev / raceEff への単回帰・重回帰、路面別）
//   2. クラス恒等式（anchor + factor*基準走破秒）のコース内レンジ
//   3. 年次中央値（路面×クラス×年）
//   4. 同一馬・同条件・60日以内ペアの総合指数RMS/√2（距離別）
//   5. 会場別の中心化残差平均とpaceDev
//   6. 芝の月別中心化残差平均
//   7. base_times.json のサンプル数分布
//
// 使い方: node scripts/verify_index_health.js [--since 2019] [--out <file>]
//
// paceDev / raceEff の定義は診断スクリプト（diag_jra.js）と同一。
// classifyRace / getBaseTimes / timeToSeconds は calc_index.js と同一ロジックを踏襲。

const fs = require("fs");
const path = require("path");
const { parseCSVLine } = require("./csv_util");

const ROOT = path.join(__dirname, "..");
const indirIdx = process.argv.indexOf("--indir");
const IDX_DIR = indirIdx >= 0 ? path.join(ROOT, process.argv[indirIdx + 1]) : path.join(ROOT, "race_index");
const BASE_TIMES_FILE = path.join(ROOT, "base_times.json");
const BABA_DIFF_FILE = path.join(ROOT, "baba_diff.json");

const sinceIdx = process.argv.indexOf("--since");
const SINCE = sinceIdx >= 0 ? parseInt(process.argv[sinceIdx + 1]) : 2019;
const outIdx = process.argv.indexOf("--out");
const OUT_FILE = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const DIRT_SCALE_A = 0.000425;
const DIRT_SCALE_B = 0.352;
const CALIBRATION_FACTOR = 6.667;
const CALIBRATION_DIST = 2000;
const MIN_BT_SAMPLES = 20;

// calc_index.js の CLASS_ANCHOR_TURF/DIRT をそのまま複製（クラス恒等式レンジ算出用）
const CLASS_ANCHOR_TURF = {
  "2歳新馬": 283, "2歳未勝利": 293, "2歳1勝": 299, "2歳OP": 300,
  "3歳新馬": 282, "3歳未勝利": 297, "3歳1勝": 303, "3歳OP": 309,
  "3歳以上1勝": 305, "3歳以上2勝": 307, "3歳以上3勝": 311, "3歳以上OP": 315,
  "4歳以上1勝": 304, "4歳以上2勝": 307, "4歳以上3勝": 311, "4歳以上OP": 315,
};
const CLASS_ANCHOR_DIRT = {
  "2歳新馬": 272, "2歳未勝利": 279, "2歳1勝": 296, "2歳OP": 300,
  "3歳新馬": 271, "3歳未勝利": 283, "3歳1勝": 297, "3歳OP": 305,
  "3歳以上1勝": 298, "3歳以上2勝": 304, "3歳以上3勝": 309, "3歳以上OP": 315,
  "4歳以上1勝": 296, "4歳以上2勝": 304, "4歳以上3勝": 310, "4歳以上OP": 316,
};
function getClassAnchor(surface, ageClass) {
  const tbl = surface === "ダート" ? CLASS_ANCHOR_DIRT : CLASS_ANCHOR_TURF;
  return tbl[ageClass] || 280;
}

// calc_index.js と同一ロジック
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

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * p));
  return s[idx];
}
function d2n(date) {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400000;
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

function main() {
  const files = fs.readdirSync(IDX_DIR).filter(f => f.endsWith(".csv") && +f.slice(6, 10) >= SINCE);
  console.log(`files: ${files.length} (${SINCE}+)`);

  // obs: 1レコード=1出走馬
  const obs = [];
  let nRaces = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(IDX_DIR, f), "utf-8").split("\n").filter(l => l.trim());
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
    const { bt, matchedClass } = btResult;

    const dm = (r0[col["日付"]] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!dm) continue;
    const date = `${dm[1]}/${dm[2].padStart(2, "0")}/${dm[3].padStart(2, "0")}`;
    const year = +dm[1];
    const month = +dm[2];

    const rec = babaMap[`${date}_${venue}`];
    if (!rec) continue;

    // ファイル名 index_YYYYVVKKDDRR.csv → レース番号（先頭ゼロを除去した文字列）
    const raceNum = String(parseInt(f.slice(16, 18)));
    const scale = surface === "ダート" ? (DIRT_SCALE_A * dist + DIRT_SCALE_B) : dist / 2000;
    const dayVal = surface === "芝" ? rec.芝馬場差 : rec.ダート馬場差;
    if (dayVal === null || dayVal === undefined) continue;

    let raceBaba = null;
    if (rec.レース別馬場差 && typeof rec.レース別馬場差[raceNum] === "number") {
      raceBaba = rec.レース別馬場差[raceNum]; // 距離補正済み秒
    }
    const babaDiff = raceBaba !== null ? raceBaba : dayVal * scale;
    // レース効果（2000m正規化秒）= レース別 − 日次
    const raceEff = raceBaba !== null ? raceBaba / scale - dayVal : 0;

    // 先頭馬前半タイム
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

    // paceDev: 先頭馬前半 − (基準前半 + 馬場差×0.6)、2000m正規化。正=スロー
    const paceDev = (leaderEarly - (bt.基準前半秒 + babaDiff * 0.6)) / scale;
    nRaces++;

    for (const c of rows) {
      const total = parseFloat(c[col["総合指数"]]);
      const agari = parseFloat(c[col["上がり指数"]]);
      const ability = parseFloat(c[col["能力指数"]]);
      if (isNaN(total) || isNaN(ability)) continue;
      obs.push({
        horse: c[col["馬名"]], total, agari: isNaN(agari) ? 0 : agari, ability,
        paceDev, raceEff, dist, surface, venue, year, month, date, ageClass, matchedClass,
      });
    }
  }
  console.log(`obs: ${obs.length}, races: ${nRaces}`);

  // 馬内中心化（3走以上）
  const byHorse = new Map();
  for (const o of obs) {
    if (!byHorse.has(o.horse)) byHorse.set(o.horse, []);
    byHorse.get(o.horse).push(o);
  }
  for (const [, list] of byHorse) {
    if (list.length < 3) continue;
    const mT = list.reduce((s, o) => s + o.total, 0) / list.length;
    const mA = list.reduce((s, o) => s + o.ability, 0) / list.length;
    const mG = list.reduce((s, o) => s + o.agari, 0) / list.length;
    for (const o of list) {
      o.rT = o.total - mT;
      o.rA = o.ability - mA;
      o.rG = o.agari - mG;
      o.use = true;
    }
  }
  const U = obs.filter(o => o.use);
  console.log(`centered obs (horses>=3 runs): ${U.length}`);

  const result = { since: SINCE, generatedAt: new Date().toISOString(), files: files.length, obs: obs.length, races: nRaces, centered: U.length };

  // 1. 回帰傾き（路面別）
  result.regressions = {};
  for (const surf of ["芝", "ダート"]) {
    const S = U.filter(o => o.surface === surf);
    const pace = S.map(o => o.paceDev);
    const reff = S.map(o => o.raceEff);
    const rT = reg1(pace, S.map(o => o.rT));
    const rA = reg1(pace, S.map(o => o.rA));
    const rG = reg1(pace, S.map(o => o.rG));
    const dT = reg1(reff, S.map(o => o.rT));
    const dA = reg1(reff, S.map(o => o.rA));
    const jA = reg2(pace, reff, S.map(o => o.rA));
    const jT = reg2(pace, reff, S.map(o => o.rT));
    result.regressions[surf] = {
      n: S.length,
      paceDev: {
        mean: pace.reduce((a, b) => a + b, 0) / pace.length,
        sd: Math.sqrt(pace.reduce((s, x) => s + x * x, 0) / pace.length - (pace.reduce((a, b) => a + b, 0) / pace.length) ** 2),
      },
      total_vs_paceDev: rT,
      ability_vs_paceDev: rA,
      agari_vs_paceDev: rG,
      total_vs_raceEff: dT,
      ability_vs_raceEff: dA,
      ability_joint: jA,
      total_joint: jT,
    };
    console.log(`\n=== ${surf} (n=${S.length}) ===`);
    console.log(`総合残差 ~ paceDev: slope=${rT.slope.toFixed(3)} (r=${rT.r.toFixed(3)})`);
    console.log(`能力残差 ~ paceDev: slope=${rA.slope.toFixed(3)} (r=${rA.r.toFixed(3)})`);
    console.log(`上がり指数残差 ~ paceDev: slope=${rG.slope.toFixed(3)} (r=${rG.r.toFixed(3)})`);
    console.log(`総合残差 ~ raceEff: slope=${dT.slope.toFixed(3)} (r=${dT.r.toFixed(3)})`);
    console.log(`能力残差 ~ raceEff: slope=${dA.slope.toFixed(3)} (r=${dA.r.toFixed(3)})`);
    console.log(`joint 能力残差 ~ paceDev + raceEff: b_pace=${jA.b1.toFixed(3)}, b_raceEff=${jA.b2.toFixed(3)}`);
    console.log(`joint 総合残差 ~ paceDev + raceEff: b_pace=${jT.b1.toFixed(3)}, b_raceEff=${jT.b2.toFixed(3)}`);
  }

  // 2. クラス恒等式レンジ（コース＝路面×会場×距離、n>=50セル、3クラス以上）
  console.log("\n=== クラス恒等式レンジ（anchor + factor*基準走破秒） ===");
  const cellsByCourse = new Map(); // course -> {ageClass -> value}
  for (const bt of baseTimes) {
    const surface = bt["芝/ダート"];
    const dist = parseInt(bt.距離);
    if (isNaN(dist)) continue;
    if (bt.サンプル数 < 50) continue;
    const ageClass = bt.クラス;
    const anchor = getClassAnchor(surface, ageClass);
    const factor = CALIBRATION_FACTOR * (CALIBRATION_DIST / dist);
    const val = anchor + factor * bt.基準走破秒;
    const courseKey = `${surface}_${bt.競馬場}_${dist}`;
    if (!cellsByCourse.has(courseKey)) cellsByCourse.set(courseKey, {});
    cellsByCourse.get(courseKey)[ageClass] = val;
  }
  const courseRanges = [];
  for (const [course, vals] of cellsByCourse) {
    const vs = Object.values(vals);
    if (vs.length < 3) continue;
    const range = Math.max(...vs) - Math.min(...vs);
    courseRanges.push({ course, nClasses: vs.length, range, classes: vals });
  }
  courseRanges.sort((a, b) => b.range - a.range);
  const rangeVals = courseRanges.map(c => c.range);
  const rangeStats = rangeVals.length
    ? { median: median(rangeVals), p75: percentile(rangeVals, 0.75), max: Math.max(...rangeVals), nCourses: rangeVals.length }
    : { median: null, p75: null, max: null, nCourses: 0 };
  result.classIdentity = { rangeStats, worst5: courseRanges.slice(0, 5).map(c => ({ course: c.course, range: c.range, nClasses: c.nClasses })) };
  console.log(`コース数: ${rangeStats.nCourses}, レンジ中央値=${rangeStats.median?.toFixed(2)}, 75%点=${rangeStats.p75?.toFixed(2)}, 最大=${rangeStats.max?.toFixed(2)}`);
  console.log("ワースト5コース:");
  for (const c of courseRanges.slice(0, 5)) console.log(`  ${c.course}: range=${c.range.toFixed(2)} (n_classes=${c.nClasses})`);

  // 3. 年次中央値（路面×クラス×年、n>500のみ）
  console.log("\n=== 年次中央値（総合指数） ===");
  result.yearlyMedian = {};
  for (const surf of ["芝", "ダート"]) {
    result.yearlyMedian[surf] = {};
    for (const cls of ["3歳以上OP", "3歳以上2勝", "3歳未勝利"]) {
      const line = [];
      const perYear = {};
      for (let y = SINCE; y <= new Date().getFullYear(); y++) {
        const v = obs.filter(o => o.surface === surf && o.ageClass === cls && o.year === y).map(o => o.total);
        if (v.length > 500) { perYear[y] = median(v); line.push(`${y}:${median(v)}`); }
        else line.push(`${y}:-`);
      }
      result.yearlyMedian[surf][cls] = perYear;
      console.log(`${surf} ${cls}: ${line.join(" ")}`);
    }
  }

  // 4. 同一馬・同条件・60日以内ペアRMS（距離別、ペア>=300）
  console.log("\n=== 同一馬・同一路面同一距離・60日以内ペアの総合指数RMS/√2（距離帯別） ===");
  const rmsByDist = {};
  for (const [, list] of byHorse) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => d2n(a.date) - d2n(b.date));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (a.surface !== b.surface || a.dist !== b.dist) continue;
      if (d2n(b.date) - d2n(a.date) > 60) continue;
      const key = `${a.surface}_${a.dist}`;
      if (!rmsByDist[key]) rmsByDist[key] = { s: 0, n: 0 };
      rmsByDist[key].s += (a.total - b.total) ** 2;
      rmsByDist[key].n++;
    }
  }
  result.pairRms = {};
  for (const k of Object.keys(rmsByDist).filter(k => rmsByDist[k].n >= 300).sort()) {
    const { s, n } = rmsByDist[k];
    const rms = Math.sqrt(s / n / 2);
    result.pairRms[k] = { rms, pairs: n };
    console.log(`  ${k}: RMS/√2=${rms.toFixed(2)} pt (pairs=${n})`);
  }

  // 5. 会場別残差（路面別、n>=2000）
  console.log("\n=== 会場×路面別: 中心化残差平均と平均paceDev ===");
  result.venueResiduals = {};
  for (const surf of ["芝", "ダート"]) {
    result.venueResiduals[surf] = {};
    const venues = [...new Set(U.map(o => o.venue))];
    const rows = [];
    for (const v of venues) {
      const S = U.filter(o => o.venue === v && o.surface === surf);
      if (S.length < 2000) continue;
      const mT = S.reduce((s, o) => s + o.rT, 0) / S.length;
      const mA = S.reduce((s, o) => s + o.rA, 0) / S.length;
      const mP = S.reduce((s, o) => s + o.paceDev, 0) / S.length;
      rows.push({ v, n: S.length, mT, mA, mP });
    }
    rows.sort((a, b) => b.mA - a.mA);
    for (const r of rows) {
      result.venueResiduals[surf][r.v] = { n: r.n, meanResidTotal: r.mT, meanResidAbility: r.mA, meanPaceDev: r.mP };
      console.log(`  ${surf} ${r.v}: n=${r.n} 総合残差=${r.mT.toFixed(2)} 能力残差=${r.mA.toFixed(2)} 平均paceDev=${r.mP.toFixed(3)}`);
    }
  }

  // 6. 芝の月別残差（全会場込み）
  console.log("\n=== 芝: 月別（全会場込み）の中心化残差平均 ===");
  const byM = {};
  for (const o of U) {
    if (o.surface !== "芝") continue;
    if (!byM[o.month]) byM[o.month] = [];
    byM[o.month].push(o.rT);
  }
  result.turfMonthlyResidual = {};
  const line = [];
  for (let m = 1; m <= 12; m++) {
    const a = byM[m] || [];
    if (!a.length) continue;
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    result.turfMonthlyResidual[m] = { n: a.length, mean };
    line.push(`${m}月:${mean.toFixed(2)}`);
  }
  console.log(line.join("  "));

  // 7. base_times.json サンプル数分布
  console.log("\n=== base_times.json サンプル数分布 ===");
  const buckets = [20, 50, 100, 300, 1000];
  const counts = { "<20": 0, "<50": 0, "<100": 0, "<300": 0, "<1000": 0, ">=1000": 0 };
  for (const bt of baseTimes) {
    const n = bt.サンプル数 || 0;
    if (n < 20) counts["<20"]++;
    else if (n < 50) counts["<50"]++;
    else if (n < 100) counts["<100"]++;
    else if (n < 300) counts["<300"]++;
    else if (n < 1000) counts["<1000"]++;
    else counts[">=1000"]++;
  }
  result.btCellDistribution = { totalCells: baseTimes.length, ...counts };
  console.log(`total cells: ${baseTimes.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  if (OUT_FILE) {
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), "utf-8");
    console.log(`\nSaved: ${OUT_FILE}`);
  }
}

main();
