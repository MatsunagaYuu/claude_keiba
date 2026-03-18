const fs = require('fs');
const path = require('path');

const RACE_RESULT_DIR = './race_result';
const baseTimes = JSON.parse(fs.readFileSync('./base_times.json', 'utf-8'));

const baseMap = {};
for (const bt of baseTimes) {
  const key = `${bt['芝/ダート']}_${bt.競馬場}_${bt.距離}_${bt.クラス}`;
  baseMap[key] = bt;
}

function timeToSec(s) {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d+\.\d+)$/);
  return m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : null;
}

function classifyRace(cn) {
  if (!cn) return null;
  if (cn.includes('障害')) return null;
  if (cn.includes('新馬') || cn.includes('未勝利')) return '未勝利';
  if (cn.includes('1勝') || cn.includes('500万下')) return '1勝クラス';
  if (cn.includes('2勝') || cn.includes('1000万下')) return '2勝クラス';
  if (cn.includes('3勝') || cn.includes('1600万下')) return '3勝クラス';
  if (cn.includes('オープン') || cn.includes('OP')) return 'OP';
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(cn)) return 'OP';
  return null;
}

const files = fs.readdirSync(RACE_RESULT_DIR).filter(f => f.endsWith('.csv'));

// 日ごとの偏差を収集
const dayGroups = {};

for (const file of files) {
  const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) continue;
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  });

  const first = rows[0];
  const venue = first['競馬場名'], surface = first['芝/ダート'], dist = first['距離'];
  const cls = first['クラス'], kaisai = first['開催'], nichime = first['開催日'];
  if (surface !== '芝' && surface !== 'ダート') continue;
  const category = classifyRace(cls);
  if (!category) continue;

  const btKey = `${surface}_${venue}_${dist}_${category}`;
  const bt = baseMap[btKey];
  if (!bt) continue;

  const raceId = file.replace('result_', '').replace('.csv', '');
  const year = raceId.substring(0, 4);
  const kai = parseInt(kaisai.replace('回', ''));
  const day = parseInt(nichime.replace('日目', ''));
  const dayKey = `${surface}_${year}_${venue}_${kai}_${day}`;

  if (!dayGroups[dayKey]) dayGroups[dayKey] = {
    surface, rawDevs: [], weightAdjDevs: [], earlyDevs: [], last3fDevs: []
  };

  for (const row of rows) {
    if (!/^\d+$/.test(row['着順'])) continue;
    const totalSec = timeToSec(row['タイム']);
    const last3f = parseFloat(row['上がり']);
    const weight = parseFloat(row['斤量']) || 57;
    if (!totalSec) continue;

    const d = parseInt(dist);
    // 現行: 斤量補正なし
    const rawDev = (totalSec - bt.基準走破秒) * (2000 / d);
    dayGroups[dayKey].rawDevs.push(rawDev);

    // 斤量補正: 重い斤量で遅いのは馬場のせいではない
    const weightAdj = (weight - 57) * 0.2 * (d / 2000);
    const adjTime = totalSec - weightAdj; // 57kgだったら何秒で走ったか
    const adjDev = (adjTime - bt.基準走破秒) * (2000 / d);
    dayGroups[dayKey].weightAdjDevs.push(adjDev);

    // 前半/上がり分離
    if (last3f && !isNaN(last3f)) {
      const earlySec = totalSec - last3f;
      const earlyDev = (earlySec - bt.基準前半秒) * (2000 / d);
      const last3fDev = (last3f - bt.基準上がり秒) * (2000 / d);
      dayGroups[dayKey].earlyDevs.push(earlyDev);
      dayGroups[dayKey].last3fDevs.push(last3fDev);
    }
  }
}

// === 1. 斤量補正の影響 ===
console.log('=== 1. 斤量補正の影響 ===');
const diffs = [];
for (const [key, g] of Object.entries(dayGroups)) {
  if (g.rawDevs.length < 3) continue;
  const rawAvg = g.rawDevs.reduce((a, b) => a + b, 0) / g.rawDevs.length;
  const adjAvg = g.weightAdjDevs.reduce((a, b) => a + b, 0) / g.weightAdjDevs.length;
  diffs.push({ key, surface: g.surface, raw: rawAvg, adj: adjAvg, diff: adjAvg - rawAvg, n: g.rawDevs.length });
}
diffs.sort((a, b) => a.diff - b.diff);
console.log(`全${diffs.length}日`);
const absDiffs = diffs.map(d => Math.abs(d.diff));
absDiffs.sort((a, b) => a - b);
console.log(`補正差の絶対値 平均: ${(absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length).toFixed(3)}秒`);
console.log(`補正差の絶対値 P50: ${absDiffs[Math.floor(absDiffs.length * 0.5)].toFixed(3)}秒`);
console.log(`補正差の絶対値 P90: ${absDiffs[Math.floor(absDiffs.length * 0.9)].toFixed(3)}秒`);
console.log(`補正差の絶対値 max: ${absDiffs[absDiffs.length - 1].toFixed(3)}秒`);
console.log(`|差|>0.05秒: ${diffs.filter(d => Math.abs(d.diff) > 0.05).length}日`);
console.log(`|差|>0.1秒: ${diffs.filter(d => Math.abs(d.diff) > 0.1).length}日`);
console.log('\n差が大きい日 (top5 each direction):');
for (const d of diffs.slice(0, 5)) {
  console.log(`  ${d.key}: raw=${d.raw.toFixed(2)}, adj=${d.adj.toFixed(2)}, diff=${d.diff.toFixed(3)} (n=${d.n})`);
}
console.log('  ...');
for (const d of diffs.slice(-5)) {
  console.log(`  ${d.key}: raw=${d.raw.toFixed(2)}, adj=${d.adj.toFixed(2)}, diff=${d.diff.toFixed(3)} (n=${d.n})`);
}

// === 2. 前半 vs 上がりの乖離 ===
console.log('\n=== 2. 前半/上がりの乖離 ===');
const splitDiffs = [];
for (const [key, g] of Object.entries(dayGroups)) {
  if (g.earlyDevs.length < 3) continue;
  const earlyAvg = g.earlyDevs.reduce((a, b) => a + b, 0) / g.earlyDevs.length;
  const last3fAvg = g.last3fDevs.reduce((a, b) => a + b, 0) / g.last3fDevs.length;
  splitDiffs.push({ key, surface: g.surface, early: earlyAvg, last3f: last3fAvg, gap: earlyAvg - last3fAvg });
}
splitDiffs.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
const absGaps = splitDiffs.map(d => Math.abs(d.gap)).sort((a, b) => a - b);
console.log(`全${splitDiffs.length}日`);
console.log(`前半-上がり乖離|絶対値| 平均: ${(absGaps.reduce((a, b) => a + b, 0) / absGaps.length).toFixed(3)}秒`);
console.log(`P50: ${absGaps[Math.floor(absGaps.length * 0.5)].toFixed(3)}秒`);
console.log(`P90: ${absGaps[Math.floor(absGaps.length * 0.9)].toFixed(3)}秒`);
console.log(`|乖離|>0.5秒: ${splitDiffs.filter(d => Math.abs(d.gap) > 0.5).length}日 (${(splitDiffs.filter(d => Math.abs(d.gap) > 0.5).length / splitDiffs.length * 100).toFixed(1)}%)`);
console.log(`|乖離|>1.0秒: ${splitDiffs.filter(d => Math.abs(d.gap) > 1.0).length}日`);
console.log('\n乖離が大きい日 (top10):');
for (const d of splitDiffs.slice(0, 10)) {
  console.log(`  ${d.key}: 前半偏差=${d.early.toFixed(2)}, 上がり偏差=${d.last3f.toFixed(2)}, 乖離=${d.gap.toFixed(2)}`);
}

// 芝とダートで分けて
for (const surf of ['芝', 'ダート']) {
  const surfData = splitDiffs.filter(d => d.surface === surf);
  if (surfData.length === 0) continue;
  const gaps = surfData.map(d => Math.abs(d.gap)).sort((a, b) => a - b);
  console.log(`\n${surf} (${surfData.length}日):`);
  console.log(`  乖離|絶対値| P50=${gaps[Math.floor(gaps.length * 0.5)].toFixed(3)}, P90=${gaps[Math.floor(gaps.length * 0.9)].toFixed(3)}`);
  console.log(`  |乖離|>0.5秒: ${surfData.filter(d => Math.abs(d.gap) > 0.5).length}日 (${(surfData.filter(d => Math.abs(d.gap) > 0.5).length / surfData.length * 100).toFixed(1)}%)`);
}

// === 3. 馬場差の分布（閾値妥当性） ===
console.log('\n=== 3. 馬場差の分布 ===');
for (const surf of ['芝', 'ダート']) {
  const surfDays = diffs.filter(d => d.surface === surf);
  if (surfDays.length === 0) continue;
  const vals = surfDays.map(d => d.raw).sort((a, b) => a - b);
  const n = vals.length;
  console.log(`\n${surf} (${n}日):`);
  console.log(`  min=${vals[0].toFixed(2)}, P5=${vals[Math.floor(n * 0.05)].toFixed(2)}, P10=${vals[Math.floor(n * 0.1)].toFixed(2)}, P25=${vals[Math.floor(n * 0.25)].toFixed(2)}, P50=${vals[Math.floor(n * 0.5)].toFixed(2)}, P75=${vals[Math.floor(n * 0.75)].toFixed(2)}, P90=${vals[Math.floor(n * 0.9)].toFixed(2)}, P95=${vals[Math.floor(n * 0.95)].toFixed(2)}, max=${vals[n - 1].toFixed(2)}`);

  // 現行閾値
  const thresholds = [
    { label: '極速(<0.5)', test: v => v < 0.5 },
    { label: '速(0.5-1.0)', test: v => v >= 0.5 && v < 1.0 },
    { label: '稍速(1.0-1.5)', test: v => v >= 1.0 && v < 1.5 },
    { label: '標準(1.5-2.0)', test: v => v >= 1.5 && v < 2.0 },
    { label: '稍遅(2.0-3.0)', test: v => v >= 2.0 && v < 3.0 },
    { label: '遅(3.0-5.0)', test: v => v >= 3.0 && v < 5.0 },
    { label: '極遅(5.0+)', test: v => v >= 5.0 },
  ];
  console.log('  現行閾値:');
  for (const t of thresholds) {
    const count = vals.filter(t.test).length;
    console.log(`    ${t.label.padEnd(16)} ${count.toString().padStart(5)}日 (${(count / n * 100).toFixed(1)}%)`);
  }

  // 線形K=10での影響: 0.5秒 = 5pt差
  console.log(`  ※線形K=10換算: 0.5秒差=5pt, 1.0秒差=10pt`);
  console.log(`  P5-P95レンジ: ${(vals[Math.floor(n * 0.95)] - vals[Math.floor(n * 0.05)]).toFixed(2)}秒 = ${((vals[Math.floor(n * 0.95)] - vals[Math.floor(n * 0.05)]) * 10).toFixed(0)}pt`);
}
