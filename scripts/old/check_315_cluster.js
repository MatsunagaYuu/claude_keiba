const fs = require('fs');
const path = require('path');
const dir = './race_index';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));

// 芝のクラス別: 各レースで315超え何頭いるか
const raceStats = {}; // class -> [{ file, total, above315 }, ...]

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(l => l.trim());
  if (lines.length < 2) continue;
  const h = lines[0].split(',');
  const si = h.indexOf('芝/ダート'), ci = h.indexOf('クラス'), ti = h.indexOf('総合指数'), ri = h.indexOf('着順');

  const first = lines[1].split(',');
  if (first[si] !== '芝') continue;

  const cls = first[ci];
  let cat;
  if (cls.includes('障害')) continue;
  if (cls.includes('新馬') || cls.includes('未勝利')) cat = '未勝利';
  else if (cls.includes('1勝') || cls.includes('500万下')) cat = '1勝';
  else if (cls.includes('2勝') || cls.includes('1000万下')) cat = '2勝';
  else if (cls.includes('3勝') || cls.includes('1600万下')) cat = '3勝';
  else if (cls.includes('オープン') || cls.includes('OP') || /G[1-3I]|リステッド|L$/.test(cls)) cat = 'OP';
  else continue;

  let total = 0, above315 = 0;
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(',');
    const idx = parseInt(v[ti]), rank = parseInt(v[ri]);
    if (isNaN(idx) || isNaN(rank)) continue;
    total++;
    if (idx >= 315) above315++;
  }

  if (!raceStats[cat]) raceStats[cat] = [];
  raceStats[cat].push({ file, total, above315 });
}

const order = ['未勝利', '1勝', '2勝', '3勝', 'OP'];
for (const cat of order) {
  const races = raceStats[cat];
  if (!races) continue;
  const totalRaces = races.length;
  const racesWithAny = races.filter(r => r.above315 > 0).length;
  const racesWithMultiple = races.filter(r => r.above315 >= 2).length;
  const racesWithMany = races.filter(r => r.above315 >= 4).length;

  // 315超えがいるレースでの平均頭数
  const withAny = races.filter(r => r.above315 > 0);
  const avgWhenPresent = withAny.length > 0
    ? (withAny.reduce((s, r) => s + r.above315, 0) / withAny.length).toFixed(1)
    : '0';

  // 分布
  const dist = {};
  for (const r of races) {
    const k = r.above315;
    dist[k] = (dist[k] || 0) + 1;
  }

  console.log(`\n=== 芝 ${cat} (${totalRaces}レース) ===`);
  console.log(`315超えなし: ${totalRaces - racesWithAny}レース (${((totalRaces - racesWithAny) / totalRaces * 100).toFixed(1)}%)`);
  console.log(`315超え1頭: ${(dist[1] || 0)}レース`);
  console.log(`315超え2-3頭: ${(dist[2] || 0) + (dist[3] || 0)}レース`);
  console.log(`315超え4頭以上: ${racesWithMany}レース (${(racesWithMany / totalRaces * 100).toFixed(1)}%)`);
  console.log(`315超えがいる場合の平均頭数: ${avgWhenPresent}頭`);

  // 上位の例を表示
  const top = [...races].sort((a, b) => b.above315 - a.above315).slice(0, 3);
  console.log('最多レース:');
  for (const r of top) {
    console.log(`  ${r.file}: ${r.above315}/${r.total}頭`);
  }
}
