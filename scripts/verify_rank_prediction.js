// 着順予測精度の検証（Stage 0 基線測定）。ペア一致率を算出する。
//
// 定義:
//   対象: race_index/*.csv（JRA）の --since 年以降（既定2019）のレース
//   各出走馬の「直近過去走」= 同ファイル群内で当該レースより前・365日以内の最新走の
//     能力指数（無ければ総合指数、それも無ければ対象外）
//   レース内の全2頭組合せのうち両方に直近過去走指数がある組について、
//     指数が高い方が先着していれば正解（同指数の組・同着の組は除外）
//
// 出力: 全体一致率、路面別、年の偶奇別（汎化確認用）、対象ペア数
//
// 使い方: node scripts/verify_rank_prediction.js [--since 2019]

const fs = require("fs");
const path = require("path");
const { parseCSVLine } = require("./csv_util");

const ROOT = path.join(__dirname, "..");
const indirIdx = process.argv.indexOf("--indir");
const IDX_DIR = indirIdx >= 0 ? path.join(ROOT, process.argv[indirIdx + 1]) : path.join(ROOT, "race_index");

const sinceIdx = process.argv.indexOf("--since");
const SINCE = sinceIdx >= 0 ? parseInt(process.argv[sinceIdx + 1]) : 2019;

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}
function d2n(date) {
  // date: "YYYY/MM/DD"
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400000;
}

function main() {
  // 全レースをファイル名（=raceId昇順）ではなく日付でソートして処理する必要があるため、
  // 一旦全レースをメモリに読み込んでから日付順に並べ替える。
  const files = fs.readdirSync(IDX_DIR).filter(f => f.endsWith(".csv"));
  console.log(`files: ${files.length}`);

  // race: { date, dateNum, year, surface, entries: [{horse, finish, total, ability}] }
  const races = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(IDX_DIR, f), "utf-8").split("\n").filter(l => l.trim());
    if (lines.length < 2) continue;
    const H = parseCSVLine(lines[0]);
    const col = {};
    H.forEach((h, i) => (col[h] = i));
    if (col["総合指数"] === undefined) continue;

    const r0 = parseCSVLine(lines[1]);
    const surface = r0[col["芝/ダート"]];
    if (surface !== "芝" && surface !== "ダート") continue;
    const dm = (r0[col["日付"]] || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!dm) continue;
    const year = +dm[1];
    if (year < SINCE) continue;
    const date = `${dm[1]}/${dm[2].padStart(2, "0")}/${dm[3].padStart(2, "0")}`;
    const dateNum = d2n(date);

    const entries = [];
    for (let i = 1; i < lines.length; i++) {
      const c = parseCSVLine(lines[i]);
      const finishStr = c[col["着順"]];
      if (!/^\d+$/.test(finishStr)) continue; // 中止・除外・失格等は除外
      const finish = parseInt(finishStr);
      const total = parseFloat(c[col["総合指数"]]);
      const ability = parseFloat(c[col["能力指数"]]);
      const horse = c[col["馬名"]];
      if (!horse) continue;
      entries.push({ horse, finish, total: isNaN(total) ? null : total, ability: isNaN(ability) ? null : ability });
    }
    if (entries.length < 2) continue;
    races.push({ file: f, date, dateNum, year, surface, entries });
  }
  console.log(`races: ${races.length}`);

  // 日付順にソート（同日は元のファイル名順で安定ソート）
  races.sort((a, b) => a.dateNum - b.dateNum || a.file.localeCompare(b.file));

  // 馬別の走歴を日付順に構築しながら、各レース処理時点での「直近過去走指数」を引く
  const lastRun = new Map(); // horse -> { dateNum, idx }

  let totalPairs = 0, totalCorrect = 0;
  const bySurface = { 芝: { pairs: 0, correct: 0 }, ダート: { pairs: 0, correct: 0 } };
  const byParity = { even: { pairs: 0, correct: 0 }, odd: { pairs: 0, correct: 0 } };

  for (const race of races) {
    // このレース時点での各馬の直近過去走指数（365日以内）を引く
    const prevIdx = new Map();
    for (const e of race.entries) {
      const prev = lastRun.get(e.horse);
      if (prev && race.dateNum - prev.dateNum <= 365 && race.dateNum - prev.dateNum > 0) {
        prevIdx.set(e.horse, prev.idx);
      }
    }

    // ペア判定: 直近過去走指数を両方持つ馬同士の全組合せ
    const withIdx = race.entries.filter(e => prevIdx.has(e.horse));
    const parity = race.year % 2 === 0 ? "even" : "odd";
    for (let i = 0; i < withIdx.length; i++) {
      for (let j = i + 1; j < withIdx.length; j++) {
        const a = withIdx[i], b = withIdx[j];
        if (a.finish === b.finish) continue; // 同着は除外
        const ia = prevIdx.get(a.horse), ib = prevIdx.get(b.horse);
        if (ia === ib) continue; // 同指数は除外
        const predictedWinner = ia > ib ? a : b; // 指数が高い方が先着すると予測
        const actualWinner = a.finish < b.finish ? a : b;
        const correct = predictedWinner === actualWinner ? 1 : 0;

        totalPairs++;
        totalCorrect += correct;
        bySurface[race.surface].pairs++;
        bySurface[race.surface].correct += correct;
        byParity[parity].pairs++;
        byParity[parity].correct += correct;
      }
    }

    // このレースの結果を走歴に反映（能力指数優先、無ければ総合指数）
    for (const e of race.entries) {
      const idx = e.ability !== null ? e.ability : e.total;
      if (idx === null) continue;
      const prev = lastRun.get(e.horse);
      if (!prev || race.dateNum > prev.dateNum) {
        lastRun.set(e.horse, { dateNum: race.dateNum, idx });
      }
    }
  }

  const result = {
    since: SINCE,
    generatedAt: new Date().toISOString(),
    files: files.length,
    races: races.length,
    overall: { pairs: totalPairs, correct: totalCorrect, accuracy: totalCorrect / totalPairs },
    bySurface: {},
    byYearParity: {},
  };
  for (const [k, v] of Object.entries(bySurface)) {
    result.bySurface[k] = { pairs: v.pairs, correct: v.correct, accuracy: v.pairs ? v.correct / v.pairs : null };
  }
  for (const [k, v] of Object.entries(byParity)) {
    result.byYearParity[k] = { pairs: v.pairs, correct: v.correct, accuracy: v.pairs ? v.correct / v.pairs : null };
  }

  console.log(`\n=== 着順予測ペア一致率（${SINCE}年以降） ===`);
  console.log(`全体: ${(result.overall.accuracy * 100).toFixed(2)}% (pairs=${totalPairs})`);
  for (const [k, v] of Object.entries(result.bySurface)) {
    console.log(`${k}: ${v.accuracy !== null ? (v.accuracy * 100).toFixed(2) + "%" : "-"} (pairs=${v.pairs})`);
  }
  for (const [k, v] of Object.entries(result.byYearParity)) {
    console.log(`${k === "even" ? "偶数年" : "奇数年"}: ${v.accuracy !== null ? (v.accuracy * 100).toFixed(2) + "%" : "-"} (pairs=${v.pairs})`);
  }

  console.log("\n" + JSON.stringify(result, null, 2));
}

main();
