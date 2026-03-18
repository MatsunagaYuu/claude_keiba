const fs = require('fs');
const path = require('path');
const dir = './race_index';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
const stats = {};
for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(l => l.trim());
  if (lines.length < 2) continue;
  const h = lines[0].split(',');
  const si = h.indexOf('芝/ダート'), ci = h.indexOf('クラス'), ti = h.indexOf('総合指数'), ri = h.indexOf('着順');
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(',');
    const surf = v[si], cls = v[ci], idx = parseInt(v[ti]), rank = parseInt(v[ri]);
    if (isNaN(idx) || isNaN(rank)) continue;
    let cat;
    if (cls.includes('障害')) continue;
    if (cls.includes('新馬') || cls.includes('未勝利')) cat = '未勝利';
    else if (cls.includes('1勝') || cls.includes('500万下')) cat = '1勝';
    else if (cls.includes('2勝') || cls.includes('1000万下')) cat = '2勝';
    else if (cls.includes('3勝') || cls.includes('1600万下')) cat = '3勝';
    else if (cls.includes('オープン') || cls.includes('OP') || /G[1-3I]|リステッド|L$/.test(cls)) cat = 'OP';
    else continue;
    const key = surf + '_' + cat;
    if (!stats[key]) stats[key] = { vals: [] };
    stats[key].vals.push(idx);
  }
}
const order = ['未勝利', '1勝', '2勝', '3勝', 'OP'];
for (const surf of ['芝', 'ダート']) {
  console.log('\n=== ' + surf + ' 総合指数 (線形K=10) ===');
  console.log('クラス      N     平均  中央値   >=295  >=300  >=305  >=310  >=315  >=320');
  for (const cat of order) {
    const s = stats[surf + '_' + cat];
    if (!s) continue;
    const sorted = [...s.vals].sort((a, b) => a - b);
    const n = s.vals.length;
    const med = sorted[Math.floor(n / 2)];
    const avg = (s.vals.reduce((a, b) => a + b, 0) / n).toFixed(1);
    const pcts = [295, 300, 305, 310, 315, 320].map(t =>
      (s.vals.filter(v => v >= t).length / n * 100).toFixed(1) + '%'
    );
    console.log(cat.padEnd(8) + n.toString().padStart(7) + avg.padStart(8) + med.toString().padStart(7) +
      pcts.map(p => p.padStart(7)).join(''));
  }
}
