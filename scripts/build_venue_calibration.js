// 会場×路面×距離帯キャリブレーション推定（期間別）
// 同一馬・同一路面・同一距離帯・±120日以内の異会場ペアから、会場×路面×距離帯の
// 指数系統誤差(offset)を期間ごとにネットワーク最小二乗で推定する。
// idx_i - idx_j ≈ offset_i - offset_j
// バイアスは経年ドリフトするため期間分割で吸収（ペアは中間日の年で期間に割当て）。
// ペアを同一距離帯内に限定する理由: 帯を跨ぐペアは路線変更の選択バイアス
// （距離適性・転厩時の成績変化）が混入し推定が不安定になるため。
// ゲージ（加重平均ゼロ正規化）も路面×距離帯ごとに独立。
// 距離帯セルはペア数に応じて会場×路面レベルの推定値へ縮約（シュリンク）:
//   offset = (ペア数×帯推定 + K×会場推定) / (ペア数 + K)
// オプション:
//   --fit-years even|odd  ペアを中間日の偶数/奇数年に限定（分割標本検証用）
//   --out <file>          出力先変更（既定: venue_calibration.json）
const fs = require("fs");
const path = require("path");

const RACE_INDEX_DIR = path.join(__dirname, "..", "race_index");
const fitYearsIdx = process.argv.indexOf("--fit-years");
const FIT_YEARS = fitYearsIdx >= 0 ? process.argv[fitYearsIdx + 1] : "all";
const outIdx = process.argv.indexOf("--out");
const OUTPUT_FILE = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(__dirname, "..", "venue_calibration.json");

const SINCE_YEAR = 2014;
const WINDOW_DAYS = 120;
const MIN_PAIRS = 2000; // 会場レベルの採用閾値
const SHRINK_K = 2000; // 距離帯→会場レベルへの縮約強度
// 期間区分（最終期間は開区間として将来レースにも適用）
const PERIODS = [
  { from: 2014, to: 2020 },
  { from: 2021, to: 2023 },
  { from: 2024, to: 9999 },
];

const VENUES = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];
const SURFACES = ["芝", "ダート"];
// 距離帯（calc_index.js の bandOfDist と一致させること）
const BANDS = ["短", "中", "長"];
function bandOfDist(d) {
  if (d <= 1400) return "短";
  if (d <= 2000) return "中";
  return "長";
}

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

// "2026/5/31" → 経過日数
function dateToDays(dateStr) {
  const m = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])) / 86400000;
}

function periodOfYear(year) {
  for (let p = 0; p < PERIODS.length; p++) {
    if (year >= PERIODS[p].from && year <= PERIODS[p].to) return p;
  }
  return year < PERIODS[0].from ? 0 : PERIODS.length - 1;
}

// 加重平均ゼロ制約（グループごと）付きネットワーク最小二乗
// groups[i] = セルiのゲージグループ（会場系: 路面、距離帯系: 路面×距離帯）
// 戻り値: {cellIndex: offset} or null（特異）
function solve(N, rhs, active, weights, groups) {
  const surfaces = groups;
  const n = active.length;
  const activeSurfaces = [...new Set(active.map(i => surfaces[i]))];
  const nS = activeSurfaces.length;
  const A = Array.from({ length: n + nS }, () => new Array(n + nS + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = N[active[i]][active[j]];
    const s = activeSurfaces.indexOf(surfaces[active[i]]);
    A[i][n + s] = weights[active[i]];
    A[i][n + nS] = rhs[active[i]];
  }
  for (let s = 0; s < nS; s++) {
    for (let j = 0; j < n; j++) {
      if (surfaces[active[j]] === activeSurfaces[s]) A[n + s][j] = weights[active[j]];
    }
  }
  const m = n + nS;
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= m; c++) A[r][c] -= f * A[col][c];
    }
  }
  const sol = {};
  for (let i = 0; i < n; i++) sol[active[i]] = A[i][m] / A[i][i];
  return sol;
}

function main() {
  // 距離帯セル（60）と会場セル（20、フォールバック用）
  const bIds = {}, bNames = [];
  const vIds = {}, vNames = [];
  for (const s of SURFACES) {
    for (const v of VENUES) {
      vIds[`${s}_${v}`] = vNames.length;
      vNames.push({ surface: s, venue: v });
      for (const b of BANDS) {
        bIds[`${s}_${v}_${b}`] = bNames.length;
        bNames.push({ surface: s, venue: v, band: b });
      }
    }
  }
  const nB = bNames.length, nV = vNames.length;
  const nP = PERIODS.length;
  const bGroups = bNames.map(c => `${c.surface}_${c.band}`); // ゲージは路面×距離帯ごと
  const vGroups = vNames.map(c => c.surface);

  const files = fs.readdirSync(RACE_INDEX_DIR).filter(f => {
    if (!f.endsWith(".csv")) return false;
    const y = parseInt(f.slice(6, 10));
    return y >= SINCE_YEAR;
  });
  console.log(`Input: ${files.length} files (${SINCE_YEAR}-)`);

  const horses = {};
  const raceCountsB = Array.from({ length: nP }, () => new Array(nB).fill(0));
  const raceCountsV = Array.from({ length: nP }, () => new Array(nV).fill(0));
  let noDate = 0, usedRows = 0;
  for (const f of files) {
    const fileYear = parseInt(f.slice(6, 10));
    const lines = fs.readFileSync(path.join(RACE_INDEX_DIR, f), "utf-8").split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const headers = splitCSV(lines[0]);
    const col = {};
    headers.forEach((h, i) => col[h] = i);
    if (col["総合指数"] === undefined || col["日付"] === undefined) continue;

    let counted = false;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCSV(lines[i]);
      const name = c[col["馬名"]];
      const venue = c[col["競馬場名"]];
      const surf = c[col["芝/ダート"]];
      const dist = parseInt(c[col["距離"]]);
      const ref = col["参考"] !== undefined ? c[col["参考"]] : "";
      const idx = parseFloat(c[col["総合指数"]]);
      if (isNaN(idx) || isNaN(dist) || !name || ref === "1") continue;
      const v = vIds[`${surf}_${venue}`];
      if (v === undefined) continue;
      const b = bIds[`${surf}_${venue}_${bandOfDist(dist)}`];
      const day = dateToDays(c[col["日付"]]);
      if (day === null) { noDate++; continue; }
      if (!horses[name]) horses[name] = [];
      horses[name].push({ b, v, day, idx });
      usedRows++;
      if (!counted) {
        const p = periodOfYear(fileYear);
        raceCountsB[p][b]++;
        raceCountsV[p][v]++;
        counted = true;
      }
    }
  }
  console.log(`馬数: ${Object.keys(horses).length}, 使用行: ${usedRows}, 日付なし: ${noDate}`);

  // ペア生成 → 期間別に距離帯系・会場系の正規方程式を蓄積
  const mkN = size => Array.from({ length: nP }, () => Array.from({ length: size }, () => new Array(size).fill(0)));
  const mkV = size => Array.from({ length: nP }, () => new Array(size).fill(0));
  const NB = mkN(nB), rhsB = mkV(nB), pairCountsB = mkV(nB);
  const NV = mkN(nV), rhsV = mkV(nV), pairCountsV = mkV(nV);
  const totalPairs = new Array(nP).fill(0);

  for (const name in horses) {
    const runs = horses[name];
    runs.sort((a, b) => a.day - b.day);
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[j].day - runs[i].day > WINDOW_DAYS) break;
        const a = runs[i], r2 = runs[j];
        if (bNames[a.b].surface !== bNames[r2.b].surface) continue;
        const midYear = new Date((a.day + r2.day) / 2 * 86400000).getUTCFullYear();
        if (FIT_YEARS === "even" && midYear % 2 !== 0) continue;
        if (FIT_YEARS === "odd" && midYear % 2 !== 1) continue;
        const p = periodOfYear(midYear);
        const d = a.idx - r2.idx;
        // 距離帯系: 同一距離帯・異会場のペアのみ（帯跨ぎは選択バイアス混入のため不使用）
        if (a.b !== r2.b && bNames[a.b].band === bNames[r2.b].band) {
          NB[p][a.b][a.b]++; NB[p][r2.b][r2.b]++;
          NB[p][a.b][r2.b]--; NB[p][r2.b][a.b]--;
          rhsB[p][a.b] += d; rhsB[p][r2.b] -= d;
          pairCountsB[p][a.b]++; pairCountsB[p][r2.b]++;
        }
        if (a.v !== r2.v) {
          NV[p][a.v][a.v]++; NV[p][r2.v][r2.v]++;
          NV[p][a.v][r2.v]--; NV[p][r2.v][a.v]--;
          rhsV[p][a.v] += d; rhsV[p][r2.v] -= d;
          pairCountsV[p][a.v]++; pairCountsV[p][r2.v]++;
          totalPairs[p]++;
        }
      }
    }
  }

  const result = {
    generated: new Date().toISOString().slice(0, 10),
    params: {
      sinceYear: SINCE_YEAR, windowDays: WINDOW_DAYS, minPairs: MIN_PAIRS, shrinkK: SHRINK_K,
      fitYears: FIT_YEARS, index: "総合指数", bands: { 短: "-1400", 中: "1401-2000", 長: "2001-" },
    },
    periods: [],
  };

  for (let p = 0; p < nP; p++) {
    const label = `${PERIODS[p].from}-${PERIODS[p].to === 9999 ? "" : PERIODS[p].to}`;
    console.log(`\n===== 期間 ${label}（会場間ペア総数: ${totalPairs[p]}） =====`);

    // 会場レベル（フォールバック用）
    const vActive = [];
    for (let i = 0; i < nV; i++) if (pairCountsV[p][i] >= MIN_PAIRS) vActive.push(i);
    const vSol = solve(NV[p], rhsV[p], vActive, raceCountsV[p], vGroups);
    if (!vSol) { console.error(`期間 ${label}: 会場レベルが特異行列で解けません`); process.exit(1); }
    const vOffsets = new Array(nV).fill(0);
    for (const i of vActive) vOffsets[i] = vSol[i];

    // 距離帯レベル（ペアが1つでもあれば推定に参加、信頼度は縮約で制御）
    const bActive = [];
    for (let i = 0; i < nB; i++) if (pairCountsB[p][i] > 0) bActive.push(i);
    const bSol = solve(NB[p], rhsB[p], bActive, raceCountsB[p], bGroups);
    if (!bSol) { console.error(`期間 ${label}: 距離帯レベルが特異行列で解けません`); process.exit(1); }

    // 統合: ペア数に応じて会場レベルへ縮約 → 路面×距離帯ごとに加重平均ゼロへ再正規化
    const offsets = new Array(nB).fill(0);
    const bandWeight = new Array(nB).fill(0);
    for (let i = 0; i < nB; i++) {
      const vOff = vOffsets[vIds[`${bNames[i].surface}_${bNames[i].venue}`]];
      const nPair = pairCountsB[p][i];
      if (bSol[i] !== undefined && nPair > 0) {
        bandWeight[i] = nPair / (nPair + SHRINK_K);
        offsets[i] = bandWeight[i] * bSol[i] + (1 - bandWeight[i]) * vOff;
      } else {
        offsets[i] = vOff;
      }
    }
    for (const s of SURFACES) {
      for (const b of BANDS) {
        let ws = 0, w = 0;
        for (let i = 0; i < nB; i++) {
          if (bNames[i].surface !== s || bNames[i].band !== b) continue;
          ws += offsets[i] * raceCountsB[p][i];
          w += raceCountsB[p][i];
        }
        if (!w) continue;
        const shift = ws / w;
        for (let i = 0; i < nB; i++) if (bNames[i].surface === s && bNames[i].band === b) offsets[i] -= shift;
      }
    }

    const rows = bNames.map((c, i) => ({
      競馬場: c.venue,
      "芝/ダート": c.surface,
      距離帯: c.band,
      offset: parseFloat(offsets[i].toFixed(3)),
      ペア数: pairCountsB[p][i],
      レース数: raceCountsB[p][i],
      帯重み: parseFloat(bandWeight[i].toFixed(2)),
    })).filter(r => r.レース数 > 0 || r.ペア数 > 0)
      .sort((a, b) => b.offset - a.offset);

    console.log("会場_路面_距離帯   offset   ペア数    レース数  帯重み");
    for (const r of rows) {
      console.log(`${(r.競馬場 + "|" + r["芝/ダート"] + "|" + r.距離帯).padEnd(15)} ${r.offset.toFixed(3).padStart(7)} ${String(r.ペア数).padStart(8)} ${String(r.レース数).padStart(8)} ${r.帯重み.toFixed(2).padStart(6)}`);
    }
    for (const s of SURFACES) {
      for (const b of BANDS) {
        const sr = rows.filter(r => r["芝/ダート"] === s && r.距離帯 === b && r.レース数 > 0);
        const wsum = sr.reduce((a, r) => a + r.レース数, 0);
        if (!wsum) continue;
        const wmean = sr.reduce((a, r) => a + r.offset * r.レース数, 0) / wsum;
        console.log(`レース数加重平均(${s}${b}): ${wmean.toFixed(4)}（≈0であること）`);
      }
    }

    result.periods.push({ from: PERIODS[p].from, to: PERIODS[p].to, offsets: rows });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE}`);
}

main();
