/**
 * 外部馬場差の距離スケーリング回帰分析
 *
 * 現在の線形スケーリング (芝馬場差 * dist/2000) が実態に合っているか検証し、
 * より良い換算式を導出する。
 */

const fs = require('fs');
const path = require('path');

// ── 定数 ──
const PROJECT_ROOT = path.join(__dirname, '..');
const BABA_DIFF_PATH = path.join(PROJECT_ROOT, 'external_baba_diff.json');
const RACE_INDEX_DIR = path.join(PROJECT_ROOT, 'race_index');

const VENUE_CODES = {
  '札幌': '01', '函館': '02', '福島': '03', '新潟': '04',
  '東京': '05', '中山': '06', '中京': '07', '京都': '08',
  '阪神': '09', '小倉': '10'
};

const MIN_ABS_BABA = 0.1; // 全体馬場差がこれ未満は比率計算から除外

// ── ユーティリティ ──
function median(arr) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// 最小二乗線形回帰: y = a*x + b
function linearRegression(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let ssxx = 0, ssxy = 0, ssyy = 0;
  for (let i = 0; i < n; i++) {
    ssxx += (xs[i] - mx) ** 2;
    ssxy += (xs[i] - mx) * (ys[i] - my);
    ssyy += (ys[i] - my) ** 2;
  }
  const a = ssxy / ssxx;
  const b = my - a * mx;
  const r2 = ssyy === 0 ? NaN : (ssxy ** 2) / (ssxx * ssyy);
  return { a, b, r2 };
}

// 非線形べき乗モデル: ratio = a * dist^b  →  log(ratio) = log(a) + b*log(dist)
// ratioが正のデータのみ使用
function powerRegression(xs, ys) {
  const logXs = [], logYs = [];
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] > 0) {
      logXs.push(Math.log(xs[i]));
      logYs.push(Math.log(ys[i]));
    }
  }
  if (logXs.length < 3) return { a: NaN, b: NaN, r2: NaN, n: logXs.length };
  const reg = linearRegression(logXs, logYs);
  return { a: Math.exp(reg.b), b: reg.a, r2: reg.r2, n: logXs.length };
}

// R²計算（任意の予測値に対して）
function calcR2(ys, yPreds) {
  const my = mean(ys);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < ys.length; i++) {
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - yPreds[i]) ** 2;
  }
  return ssTot === 0 ? NaN : 1 - ssRes / ssTot;
}

// ── Step 1: データ結合 ──
function loadAndJoin() {
  console.log('=== Step 1: データ結合 ===\n');

  const babaDiff = JSON.parse(fs.readFileSync(BABA_DIFF_PATH, 'utf8'));

  // race_indexのファイル一覧をキャッシュ
  const indexFiles = new Set(fs.readdirSync(RACE_INDEX_DIR));

  // レース→距離・芝ダートのマッピングキャッシュ
  const raceDistCache = {};

  function getRaceDist(raceId) {
    if (raceDistCache[raceId] !== undefined) return raceDistCache[raceId];
    const fname = `index_${raceId}.csv`;
    if (!indexFiles.has(fname)) {
      raceDistCache[raceId] = null;
      return null;
    }
    try {
      const content = fs.readFileSync(path.join(RACE_INDEX_DIR, fname), 'utf8');
      const lines = content.split('\n');
      if (lines.length < 2) { raceDistCache[raceId] = null; return null; }
      const header = lines[0].split(',');
      const distIdx = header.indexOf('距離');
      const surfIdx = header.indexOf('芝/ダート');
      if (distIdx < 0 || surfIdx < 0) { raceDistCache[raceId] = null; return null; }
      const row = lines[1].split(',');
      const dist = parseInt(row[distIdx], 10);
      const surface = row[surfIdx];
      const result = { dist, surface };
      raceDistCache[raceId] = result;
      return result;
    } catch {
      raceDistCache[raceId] = null;
      return null;
    }
  }

  const turfData = [];   // { dist, overallBaba, raceBaba, ratio }
  const dirtData = [];
  const dirtDistData = []; // ダート距離別馬場差（補足データ）

  let totalRecords = 0, totalDirtDistRecords = 0;
  let matchedTurf = 0, matchedDirt = 0;
  let skippedNoFile = 0, skippedNoOverall = 0;

  for (const rec of babaDiff) {
    const venueCode = VENUE_CODES[rec['競馬場']];
    if (!venueCode) continue;

    const year = rec['年'];
    const kai = String(rec['回']).padStart(2, '0');
    const nichi = String(rec['日次']).padStart(2, '0');

    // レース別馬場差（芝・ダート両方含む → race_indexから芝/ダートを判定して振り分け）
    if (rec['レース別馬場差']) {
      for (const [rNum, raceBaba] of Object.entries(rec['レース別馬場差'])) {
        totalRecords++;
        const raceNum = String(rNum).padStart(2, '0');
        const raceId = `${year}${venueCode}${kai}${nichi}${raceNum}`;
        const info = getRaceDist(raceId);
        if (!info) { skippedNoFile++; continue; }

        const surface = info.surface;
        const overallBaba = surface === '芝' ? rec['芝馬場差'] : rec['ダート馬場差'];
        if (overallBaba == null) { skippedNoOverall++; continue; }

        const entry = { dist: info.dist, overallBaba, raceBaba: parseFloat(raceBaba) };
        if (Math.abs(overallBaba) >= MIN_ABS_BABA) {
          entry.ratio = entry.raceBaba / overallBaba;
        }

        if (surface === '芝') {
          matchedTurf++;
          turfData.push(entry);
        } else {
          matchedDirt++;
          dirtData.push(entry);
        }
      }
    }

    // ダート距離別馬場差（レース別馬場差がない場合の補足）
    if (rec['ダート距離別馬場差'] && rec['ダート馬場差'] != null) {
      const overallBaba = rec['ダート馬場差'];
      for (const [distStr, raceBaba] of Object.entries(rec['ダート距離別馬場差'])) {
        totalDirtDistRecords++;
        const dist = parseInt(distStr, 10);
        const entry = { dist, overallBaba, raceBaba: parseFloat(raceBaba), source: 'dist_key' };
        if (Math.abs(overallBaba) >= MIN_ABS_BABA) {
          entry.ratio = entry.raceBaba / overallBaba;
        }
        dirtDistData.push(entry);
      }
    }
  }

  console.log(`外部馬場差レコード数: ${babaDiff.length}`);
  console.log(`レース別馬場差データ計: ${totalRecords}`);
  console.log(`  芝マッチ: ${matchedTurf}`);
  console.log(`  ダートマッチ: ${matchedDirt}`);
  console.log(`  ファイルなしスキップ: ${skippedNoFile}`);
  console.log(`  全体馬場差なしスキップ: ${skippedNoOverall}`);
  console.log(`ダート距離別馬場差データ計: ${totalDirtDistRecords} (参考)`);
  console.log(`  |全体馬場差| < ${MIN_ABS_BABA} で比率除外: 芝=${turfData.filter(d => d.ratio === undefined).length}, ダ=${dirtData.filter(d => d.ratio === undefined).length}`);
  console.log();

  return { turfData, dirtData, dirtDistData };
}

// ── Step 2: 分析 ──
function analyze(data, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${label} 分析 ===`);
  console.log(`${'='.repeat(60)}\n`);

  // 比率が計算できるデータのみ
  const withRatio = data.filter(d => d.ratio !== undefined);
  console.log(`比率計算可能データ数: ${withRatio.length} / ${data.length}\n`);

  if (withRatio.length < 10) {
    console.log('データ不足のため分析スキップ\n');
    return;
  }

  // ── 距離帯別の統計量 ──
  const distBins = [1000, 1200, 1400, 1600, 1700, 1800, 2000, 2200, 2400, 2500, 2600, 3000, 3200, 3400, 3600];
  const byDist = {};
  for (const d of withRatio) {
    const dist = d.dist;
    if (!byDist[dist]) byDist[dist] = [];
    byDist[dist].push(d.ratio);
  }

  console.log('--- 距離帯別統計（比率 = レース別馬場差 / 全体馬場差）---');
  console.log(
    '距離'.padEnd(6) +
    'N'.padStart(6) +
    '平均'.padStart(8) +
    '中央値'.padStart(8) +
    'SD'.padStart(8) +
    '  現行(d/2000)'.padStart(12) +
    '  差分'.padStart(8)
  );
  console.log('-'.repeat(70));

  const sortedDists = Object.keys(byDist).map(Number).sort((a, b) => a - b);
  for (const dist of sortedDists) {
    const ratios = byDist[dist];
    if (ratios.length < 3) continue;
    const m = mean(ratios);
    const med = median(ratios);
    const sd = stddev(ratios);
    const current = dist / 2000;
    const diff = m - current;
    console.log(
      String(dist).padEnd(6) +
      String(ratios.length).padStart(6) +
      m.toFixed(3).padStart(8) +
      med.toFixed(3).padStart(8) +
      sd.toFixed(3).padStart(8) +
      current.toFixed(3).padStart(12) +
      (diff >= 0 ? '+' : '') + diff.toFixed(3).padStart(7)
    );
  }
  console.log();

  // ── 線形回帰: ratio = a * dist + b ──
  const dists = withRatio.map(d => d.dist);
  const ratios = withRatio.map(d => d.ratio);

  const linReg = linearRegression(dists, ratios);
  console.log('--- 線形回帰: ratio = a * dist + b ---');
  console.log(`  a = ${linReg.a.toFixed(8)}`);
  console.log(`  b = ${linReg.b.toFixed(6)}`);
  console.log(`  R² = ${linReg.r2.toFixed(6)}`);
  console.log(`  → ratio ≈ ${linReg.a.toFixed(8)} * dist + (${linReg.b.toFixed(6)})`);
  console.log();

  // 現在のモデル: ratio = dist/2000 = 0.0005 * dist + 0
  const currentPreds = dists.map(d => d / 2000);
  const currentR2 = calcR2(ratios, currentPreds);
  console.log('--- 現行モデル: ratio = dist / 2000 ---');
  console.log(`  R² = ${currentR2.toFixed(6)}`);
  console.log();

  // 線形回帰モデルの予測
  const linPreds = dists.map(d => linReg.a * d + linReg.b);
  const linR2actual = calcR2(ratios, linPreds);
  console.log(`  線形回帰 R²(実測) = ${linR2actual.toFixed(6)}`);
  console.log();

  // ── 非線形回帰: ratio = a * dist^b ──
  const powReg = powerRegression(dists, ratios);
  console.log('--- 非線形べき乗モデル: ratio = a * dist^b ---');
  console.log(`  a = ${powReg.a.toFixed(8)}`);
  console.log(`  b = ${powReg.b.toFixed(6)}`);
  console.log(`  R²(対数空間) = ${powReg.r2.toFixed(6)}`);
  console.log(`  使用データ数(ratio>0): ${powReg.n}`);

  // 元の空間でのR²
  const posData = withRatio.filter(d => d.ratio > 0);
  if (posData.length > 0) {
    const posDists = posData.map(d => d.dist);
    const posRatios = posData.map(d => d.ratio);
    const powPreds = posDists.map(d => powReg.a * Math.pow(d, powReg.b));
    const powR2real = calcR2(posRatios, powPreds);
    console.log(`  R²(元の空間, ratio>0) = ${powR2real.toFixed(6)}`);
  }
  console.log();

  // ── 原点通過の線形回帰: ratio = a * dist（切片なし） ──
  // ratio = a*dist → a = Σ(dist*ratio) / Σ(dist²)
  let sumDR = 0, sumDD = 0;
  for (let i = 0; i < dists.length; i++) {
    sumDR += dists[i] * ratios[i];
    sumDD += dists[i] * dists[i];
  }
  const aNoIntercept = sumDR / sumDD;
  const noIntPreds = dists.map(d => aNoIntercept * d);
  const noIntR2 = calcR2(ratios, noIntPreds);

  console.log('--- 原点通過の線形モデル: ratio = a * dist ---');
  console.log(`  a = ${aNoIntercept.toFixed(8)}`);
  console.log(`  R² = ${noIntR2.toFixed(6)}`);
  console.log(`  → 換算式: 馬場差 = 全体馬場差 * ${aNoIntercept.toFixed(8)} * dist`);
  console.log(`  現行 a=0.0005(=1/2000) との比: ${(aNoIntercept / 0.0005).toFixed(4)}`);
  console.log(`  → 等価基準距離: ${(1 / aNoIntercept).toFixed(0)}m（現行2000m）`);
  console.log();

  // ── 中央値ベースの距離帯別フィット ──
  console.log('--- 距離帯別: 中央値ベースの比率 vs 現行モデル ---');
  console.log(
    '距離'.padEnd(6) +
    'N'.padStart(6) +
    '中央値'.padStart(8) +
    '現行'.padStart(8) +
    '線形回帰'.padStart(10) +
    'べき乗'.padStart(10) +
    '原点通過'.padStart(10)
  );
  console.log('-'.repeat(64));
  for (const dist of sortedDists) {
    const r = byDist[dist];
    if (r.length < 3) continue;
    const med = median(r);
    console.log(
      String(dist).padEnd(6) +
      String(r.length).padStart(6) +
      med.toFixed(3).padStart(8) +
      (dist / 2000).toFixed(3).padStart(8) +
      (linReg.a * dist + linReg.b).toFixed(3).padStart(10) +
      (powReg.a * Math.pow(dist, powReg.b)).toFixed(3).padStart(10) +
      (aNoIntercept * dist).toFixed(3).padStart(10)
    );
  }
  console.log();

  // ── まとめ ──
  console.log(`--- ${label} モデル比較まとめ ---`);
  console.log(`  現行 (ratio=dist/2000)         : R² = ${currentR2.toFixed(6)}`);
  console.log(`  線形回帰 (ratio=a*dist+b)      : R² = ${linR2actual.toFixed(6)}`);
  console.log(`  原点通過 (ratio=a*dist)         : R² = ${noIntR2.toFixed(6)}`);
  if (!isNaN(powReg.r2)) {
    console.log(`  べき乗 (ratio=a*dist^b, 対数空間): R² = ${powReg.r2.toFixed(6)}`);
  }
  console.log();

  return {
    linear: linReg,
    currentR2,
    noIntercept: { a: aNoIntercept, r2: noIntR2 },
    power: powReg,
    byDist,
    n: withRatio.length
  };
}

// ── Step 3: 結果出力・改善提案 ──
function summarize(turfResult, dirtResult) {
  console.log('\n' + '='.repeat(60));
  console.log('=== 改善提案 ===');
  console.log('='.repeat(60) + '\n');

  if (turfResult) {
    const equiv = (1 / turfResult.noIntercept.a).toFixed(0);
    console.log(`【芝】`);
    console.log(`  現行式: 馬場差 = 全体馬場差 * dist / 2000`);
    console.log(`  提案1（原点通過線形）: 馬場差 = 全体馬場差 * dist / ${equiv}`);
    console.log(`    → R² 改善: ${turfResult.currentR2.toFixed(4)} → ${turfResult.noIntercept.r2.toFixed(4)}`);
    if (!isNaN(turfResult.linear.b) && Math.abs(turfResult.linear.b) > 0.01) {
      console.log(`  提案2（切片あり線形）: 馬場差 = 全体馬場差 * (${turfResult.linear.a.toFixed(8)} * dist + ${turfResult.linear.b.toFixed(4)})`);
      console.log(`    → R² = ${turfResult.linear.r2.toFixed(4)}`);
    }
    if (!isNaN(turfResult.power.b)) {
      console.log(`  提案3（べき乗）: 馬場差 = 全体馬場差 * ${turfResult.power.a.toFixed(6)} * dist^${turfResult.power.b.toFixed(4)}`);
    }
    console.log();
  }

  if (dirtResult) {
    const equiv = (1 / dirtResult.noIntercept.a).toFixed(0);
    console.log(`【ダート】`);
    console.log(`  現行式: 馬場差 = 全体馬場差 * dist / 2000`);
    console.log(`  提案1（原点通過線形）: 馬場差 = 全体馬場差 * dist / ${equiv}`);
    console.log(`    → R² 改善: ${dirtResult.currentR2.toFixed(4)} → ${dirtResult.noIntercept.r2.toFixed(4)}`);
    if (!isNaN(dirtResult.linear.b) && Math.abs(dirtResult.linear.b) > 0.01) {
      console.log(`  提案2（切片あり線形）: 馬場差 = 全体馬場差 * (${dirtResult.linear.a.toFixed(8)} * dist + ${dirtResult.linear.b.toFixed(4)})`);
      console.log(`    → R² = ${dirtResult.linear.r2.toFixed(4)}`);
    }
    if (!isNaN(dirtResult.power.b)) {
      console.log(`  提案3（べき乗）: 馬場差 = 全体馬場差 * ${dirtResult.power.a.toFixed(6)} * dist^${dirtResult.power.b.toFixed(4)}`);
    }
    console.log();
  }
}

// ── メイン ──
function main() {
  console.log('外部馬場差 距離スケーリング回帰分析\n');

  const { turfData, dirtData } = loadAndJoin();

  const turfResult = analyze(turfData, '芝');
  const dirtResult = analyze(dirtData, 'ダート');

  summarize(turfResult, dirtResult);
}

main();
