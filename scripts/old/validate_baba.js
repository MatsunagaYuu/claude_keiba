const fs = require('fs');
const path = require('path');

const INDEX_DIR = './race_index';
const files = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith('.csv'));

function timeToSec(s) {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d+\.\d+)$/);
  return m ? parseInt(m[1]) * 60 + parseFloat(m[2]) : null;
}

// === Step 1: 全馬の全レース指数を収集 ===
console.log('Loading all race indexes...');
const horseRaces = {}; // horseName -> [{raceId, date, totalIdx, surface, venue, dist, cls}, ...]
const raceInfo = {};   // raceId -> {surface, venue, dist, cls, dayKey, date}

for (const file of files) {
  const content = fs.readFileSync(path.join(INDEX_DIR, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) continue;
  const h = lines[0].split(',');
  const idx = {
    venue: h.indexOf('競馬場名'), surface: h.indexOf('芝/ダート'), dist: h.indexOf('距離'),
    cls: h.indexOf('クラス'), rank: h.indexOf('着順'), name: h.indexOf('馬名'),
    total: h.indexOf('総合指数'), ability: h.indexOf('能力指数'),
    kaisai: h.indexOf('開催'), nichime: h.indexOf('開催日')
  };

  const raceId = file.replace('index_', '').replace('.csv', '');
  const firstVals = lines[1].split(',');
  const surface = firstVals[idx.surface];
  const venue = firstVals[idx.venue];
  const dist = firstVals[idx.dist];
  const cls = firstVals[idx.cls];
  const year = raceId.substring(0, 4);
  const kai = parseInt((firstVals[idx.kaisai] || '').replace('回', '')) || 0;
  const day = parseInt((firstVals[idx.nichime] || '').replace('日目', '')) || 0;
  const dayKey = `${surface}_${year}_${venue}_${kai}_${day}`;

  if (surface !== '芝' && surface !== 'ダート') continue;

  raceInfo[raceId] = { surface, venue, dist, cls, dayKey, year };

  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(',');
    const rank = parseInt(v[idx.rank]);
    const totalIdx = parseInt(v[idx.total]);
    const abilityIdx = parseInt(v[idx.ability]);
    const name = v[idx.name];
    if (isNaN(rank) || isNaN(totalIdx) || !name) continue;

    if (!horseRaces[name]) horseRaces[name] = [];
    horseRaces[name].push({ raceId, totalIdx, abilityIdx, surface, venue, dist, dayKey });
  }
}

console.log(`Horses: ${Object.keys(horseRaces).length}, Races: ${Object.keys(raceInfo).length}`);

// === Step 2: 各馬のレースごとに「過去平均からの乖離」を算出 ===
// 同一surface(芝/ダート)の過去走のみで平均を取る
console.log('\nCalculating per-horse deviations from historical average...');

const dayDeviations = {}; // dayKey -> [deviation, ...]

for (const [name, races] of Object.entries(horseRaces)) {
  if (races.length < 3) continue; // 最低3走

  // レースをraceId順にソート (時系列)
  races.sort((a, b) => a.raceId.localeCompare(b.raceId));

  for (let i = 2; i < races.length; i++) {
    const current = races[i];
    // 過去走(同一surface)の指数平均
    const past = races.slice(0, i).filter(r => r.surface === current.surface);
    if (past.length < 2) continue;

    const pastAvg = past.reduce((s, r) => s + r.totalIdx, 0) / past.length;
    const deviation = current.totalIdx - pastAvg;

    if (!dayDeviations[current.dayKey]) dayDeviations[current.dayKey] = [];
    dayDeviations[current.dayKey].push(deviation);
  }
}

// === Step 3: 日ごとの平均乖離 → 馬場差の過不足を検出 ===
console.log('\nAnalyzing per-day average deviation...');

const dayResults = [];
for (const [dayKey, devs] of Object.entries(dayDeviations)) {
  if (devs.length < 10) continue; // 最低10頭
  const avg = devs.reduce((a, b) => a + b, 0) / devs.length;
  const sorted = [...devs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  dayResults.push({ dayKey, avg, median, n: devs.length });
}

dayResults.sort((a, b) => b.avg - a.avg);
console.log(`Days with sufficient data: ${dayResults.length}`);

// 分布
const avgs = dayResults.map(d => d.avg).sort((a, b) => a - b);
const n = avgs.length;
console.log(`\n日ごとの平均乖離の分布:`);
console.log(`  P5=${avgs[Math.floor(n * 0.05)].toFixed(1)}, P25=${avgs[Math.floor(n * 0.25)].toFixed(1)}, P50=${avgs[Math.floor(n * 0.5)].toFixed(1)}, P75=${avgs[Math.floor(n * 0.75)].toFixed(1)}, P95=${avgs[Math.floor(n * 0.95)].toFixed(1)}`);

// 馬場差が不十分な日（指数が過去平均より系統的に高い=馬場が速い補正不足）
console.log(`\n平均乖離 > +5pt (馬場差不足=速い馬場の補正足りない): ${dayResults.filter(d => d.avg > 5).length}日`);
console.log(`平均乖離 > +10pt: ${dayResults.filter(d => d.avg > 10).length}日`);
console.log(`平均乖離 < -5pt (馬場差過剰=遅い馬場の補正過剰): ${dayResults.filter(d => d.avg < -5).length}日`);
console.log(`平均乖離 < -10pt: ${dayResults.filter(d => d.avg < -10).length}日`);

// 芝/ダートで分けて
for (const surf of ['芝', 'ダート']) {
  const surfDays = dayResults.filter(d => d.dayKey.startsWith(surf + '_'));
  if (surfDays.length === 0) continue;
  const savgs = surfDays.map(d => d.avg).sort((a, b) => a - b);
  const sn = savgs.length;
  console.log(`\n${surf} (${sn}日):`);
  console.log(`  P5=${savgs[Math.floor(sn * 0.05)].toFixed(1)}, P25=${savgs[Math.floor(sn * 0.25)].toFixed(1)}, P50=${savgs[Math.floor(sn * 0.5)].toFixed(1)}, P75=${savgs[Math.floor(sn * 0.75)].toFixed(1)}, P95=${savgs[Math.floor(sn * 0.95)].toFixed(1)}`);
  console.log(`  >+5pt: ${surfDays.filter(d => d.avg > 5).length}日, >+10pt: ${surfDays.filter(d => d.avg > 10).length}日`);
  console.log(`  <-5pt: ${surfDays.filter(d => d.avg < -5).length}日, <-10pt: ${surfDays.filter(d => d.avg < -10).length}日`);
}

// Top/Bottom 15
console.log('\n=== 馬場差不足（指数が過去平均より高すぎる日）Top15 ===');
console.log('dayKey                          平均乖離  中央値   N');
for (const d of dayResults.slice(0, 15)) {
  console.log(`  ${d.dayKey.padEnd(32)} ${d.avg.toFixed(1).padStart(6)}   ${d.median.toFixed(1).padStart(6)}   ${d.n}`);
}

console.log('\n=== 馬場差過剰（指数が過去平均より低すぎる日）Top15 ===');
for (const d of dayResults.slice(-15).reverse()) {
  console.log(`  ${d.dayKey.padEnd(32)} ${d.avg.toFixed(1).padStart(6)}   ${d.median.toFixed(1).padStart(6)}   ${d.n}`);
}

// === Step 4: 馬場差との相関 ===
const babaDiffs = JSON.parse(fs.readFileSync('./baba_diff.json', 'utf-8'));
const babaMap = {};
for (const bd of babaDiffs) {
  const key = `${bd['芝/ダート']}_${bd.年}_${bd.競馬場}_${bd.開催}_${bd.日次}`;
  babaMap[key] = bd.馬場差;
}

console.log('\n=== 馬場差 vs 平均乖離の関係 ===');
const matched = dayResults.filter(d => babaMap[d.dayKey] !== undefined).map(d => ({
  ...d, babaDiff: babaMap[d.dayKey]
}));

// 馬場差の区間別に平均乖離を集計
const bins = [
  { label: '極速(<-1.0)', test: v => v < -1.0 },
  { label: '速(-1.0~-0.5)', test: v => v >= -1.0 && v < -0.5 },
  { label: '稍速(-0.5~0)', test: v => v >= -0.5 && v < 0 },
  { label: '標準(0~0.5)', test: v => v >= 0 && v < 0.5 },
  { label: '稍遅(0.5~1.5)', test: v => v >= 0.5 && v < 1.5 },
  { label: '遅(1.5~3.0)', test: v => v >= 1.5 && v < 3.0 },
  { label: '極遅(3.0+)', test: v => v >= 3.0 },
];

console.log('馬場差区間         N    平均乖離(pt)  中央値   ← 0なら馬場差が正確');
for (const bin of bins) {
  const inBin = matched.filter(d => bin.test(d.babaDiff));
  if (inBin.length === 0) { console.log(`${bin.label.padEnd(18)} 0`); continue; }
  const avg = inBin.reduce((s, d) => s + d.avg, 0) / inBin.length;
  const sorted = inBin.map(d => d.avg).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`${bin.label.padEnd(18)} ${inBin.length.toString().padStart(4)}      ${avg.toFixed(1).padStart(6)}    ${med.toFixed(1).padStart(6)}`);
}

// 芝のみ
console.log('\n芝のみ:');
const turfMatched = matched.filter(d => d.dayKey.startsWith('芝_'));
for (const bin of bins) {
  const inBin = turfMatched.filter(d => bin.test(d.babaDiff));
  if (inBin.length === 0) { console.log(`${bin.label.padEnd(18)} 0`); continue; }
  const avg = inBin.reduce((s, d) => s + d.avg, 0) / inBin.length;
  const sorted = inBin.map(d => d.avg).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`${bin.label.padEnd(18)} ${inBin.length.toString().padStart(4)}      ${avg.toFixed(1).padStart(6)}    ${med.toFixed(1).padStart(6)}`);
}
