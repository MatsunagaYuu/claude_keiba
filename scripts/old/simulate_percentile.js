const fs = require('fs');
const path = require('path');

const RACE_RESULT_DIR = './race_result';
const PERCENTILES = [0.50, 0.40, 0.30]; // P50(現行相当), P40, P30
const LINEAR_K = 10;
const BASE_WEIGHT = 57;
const WEIGHT_FACTOR = 0.2;

const CLASS_ORDER = ['OP','3勝クラス','2勝クラス','1勝クラス','未勝利'];
const CLASS_ANCHOR = { OP:315, '3勝クラス':310, '2勝クラス':305, '1勝クラス':300, '未勝利':280 };
const MIN_SAMPLES = 30;

function timeToSec(s) {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d+\.\d+)$/);
  return m ? parseInt(m[1])*60+parseFloat(m[2]) : null;
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

function parseCSV(content) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  });
}

function percentile(sorted, p) {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ======== Step 1: 全レース結果を読み込み、クラス別タイムを収集 ========
console.log('Loading all race results...');
const files = fs.readdirSync(RACE_RESULT_DIR).filter(f => f.endsWith('.csv'));

// 基準タイム用: key = surface_venue_dist_class → [totalSec, ...]
const classGroups = {};
// 馬場差用: key = surface_year_venue_kai_day → [{totalSec, baseSec(per percentile), dist, class}, ...]
const raceData = [];

for (const file of files) {
  const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) continue;

  const first = rows[0];
  const venue = first['競馬場名'], surface = first['芝/ダート'], dist = first['距離'];
  const cls = first['クラス'], cond = first['馬場'];
  const kaisai = first['開催'], nichime = first['開催日'];

  if (surface !== '芝' && surface !== 'ダート') continue;
  const category = classifyRace(cls);
  if (!category) continue;

  const raceId = file.replace('result_','').replace('.csv','');
  const year = raceId.substring(0,4);
  const kai = parseInt(kaisai.replace('回',''));
  const day = parseInt(nichime.replace('日目',''));

  // 良馬場のみ基準タイム用に収集
  const key = `${surface}_${venue}_${dist}_${category}`;

  for (const row of rows) {
    if (!/^\d+$/.test(row['着順'])) continue;
    const totalSec = timeToSec(row['タイム']);
    if (!totalSec) continue;

    if (cond === '良') {
      if (!classGroups[key]) classGroups[key] = [];
      classGroups[key].push(totalSec);
    }

    raceData.push({
      file, surface, venue, dist: parseInt(dist), category, year, kai, day,
      totalSec, weight: parseFloat(row['斤量']) || 57,
      rank: row['着順'], horseName: row['馬名'], timeStr: row['タイム'], cond
    });
  }
}

// ======== Step 2: パーセンタイル別の基準タイムを算出 ========
console.log('Calculating base times for each percentile...');
const baseMaps = {}; // { pctLabel: { key: baseSec } }

for (const pct of PERCENTILES) {
  const label = 'P' + Math.round(pct * 100);
  baseMaps[label] = {};

  for (const [key, times] of Object.entries(classGroups)) {
    if (times.length === 0) continue;
    const sorted = [...times].sort((a, b) => a - b);
    baseMaps[label][key] = { baseSec: percentile(sorted, pct), samples: times.length };
  }
}

// 比較: 主要コースの基準タイム差を表示
console.log('\n=== 基準タイム比較 (秒) ===');
console.log('コース                    クラス       サンプル   P50      P40      P30      P50-P30差');
const showKeys = [
  '芝_東京_1600_OP', '芝_東京_1600_2勝クラス', '芝_東京_1600_1勝クラス', '芝_東京_1600_未勝利',
  '芝_東京_2000_OP',
  'ダート_東京_1400_OP', 'ダート_東京_1400_2勝クラス',
  '芝_中山_2000_OP', '芝_阪神_1600_OP',
];
for (const key of showKeys) {
  const p50 = baseMaps['P50'][key], p40 = baseMaps['P40'][key], p30 = baseMaps['P30'][key];
  if (!p50) continue;
  const parts = key.split('_');
  const label = (parts[0]+parts[1]+parts[2]+'m').padEnd(22) + parts[3].padEnd(12);
  const diff = (p50.baseSec - p30.baseSec).toFixed(2);
  console.log(label + p50.samples.toString().padStart(6) + '   ' +
    p50.baseSec.toFixed(2).padStart(7) + '  ' + p40.baseSec.toFixed(2).padStart(7) + '  ' +
    p30.baseSec.toFixed(2).padStart(7) + '    ' + diff);
}

// ======== Step 3: パーセンタイル別の馬場差を算出 ========
console.log('\nCalculating baba_diff for each percentile...');
const babaMaps = {}; // { pctLabel: { dayKey: babaDiff2000m } }

for (const pct of PERCENTILES) {
  const label = 'P' + Math.round(pct * 100);
  babaMaps[label] = {};

  // 日ごとに偏差を収集
  const dayGroups = {};
  for (const r of raceData) {
    const btKey = `${r.surface}_${r.venue}_${r.dist}_${r.category}`;
    const bt = baseMaps[label][btKey];
    if (!bt) continue;

    const dayKey = `${r.surface}_${r.year}_${r.venue}_${r.kai}_${r.day}`;
    if (!dayGroups[dayKey]) dayGroups[dayKey] = [];
    const rawDev = r.totalSec - bt.baseSec;
    const normDev = rawDev * (2000 / r.dist);
    dayGroups[dayKey].push(normDev);
  }

  for (const [dayKey, devs] of Object.entries(dayGroups)) {
    if (devs.length < 3) continue;
    babaMaps[label][dayKey] = devs.reduce((a, b) => a + b, 0) / devs.length;
  }
}

// 馬場差比較
console.log('\n=== 馬場差比較 (対象日) ===');
const targetDays = ['芝_2026_東京_1_5', '芝_2026_東京_1_6', 'ダート_2026_東京_1_6'];
console.log('日                          P50      P40      P30');
for (const dk of targetDays) {
  const vals = PERCENTILES.map(p => {
    const label = 'P' + Math.round(p * 100);
    const v = babaMaps[label][dk];
    return v !== undefined ? (v >= 0 ? '+' : '') + v.toFixed(2) : '  N/A';
  });
  console.log(dk.padEnd(28) + vals.map(v => v.padStart(7)).join('  '));
}

// ======== Step 4: サンプルレースで指数比較 ========
function getAnchor(baseMap, surface, venue, dist) {
  for (const cls of CLASS_ORDER) {
    const key = `${surface}_${venue}_${dist}_${cls}`;
    const bt = baseMap[key];
    if (bt && bt.samples >= MIN_SAMPLES) return { baseSec: bt.baseSec, anchorIndex: CLASS_ANCHOR[cls] };
  }
  for (const cls of CLASS_ORDER) {
    const key = `${surface}_${venue}_${dist}_${cls}`;
    if (baseMap[key]) return { baseSec: baseMap[key].baseSec, anchorIndex: CLASS_ANCHOR[cls] };
  }
  return null;
}

const sampleRaces = [
  { file: 'result_202605010505.csv', desc: '3歳未勝利 芝1400' },
  { file: 'result_202605010512.csv', desc: '1勝クラス 芝1600' },
  { file: 'result_202605010608.csv', desc: '2勝クラス 芝1600' },
  { file: 'result_202605010609.csv', desc: '3勝クラス 芝1600' },
  { file: 'result_202605010511.csv', desc: '3歳OP 芝1600' },
  { file: 'result_202605010610.csv', desc: 'OP ダート1400' },
  { file: 'result_202605010612.csv', desc: '2勝 ダート1400' },
];

for (const race of sampleRaces) {
  const fp = path.join(RACE_RESULT_DIR, race.file);
  if (!fs.existsSync(fp)) continue;
  const content = fs.readFileSync(fp, 'utf-8');
  const rows = parseCSV(content);
  if (rows.length === 0) continue;

  const first = rows[0];
  const venue = first['競馬場名'], surface = first['芝/ダート'], dist = parseInt(first['距離']);
  const cls = first['クラス'], cond = first['馬場'];
  const kai = parseInt(first['開催'].replace('回','')), day = parseInt(first['開催日'].replace('日目',''));
  const raceId = race.file.replace('result_','').replace('.csv','');
  const year = raceId.substring(0,4);
  const dayKey = `${surface}_${year}_${venue}_${kai}_${day}`;

  // 各パーセンタイルでアンカーと馬場差を取得
  const configs = {};
  for (const pct of PERCENTILES) {
    const label = 'P' + Math.round(pct * 100);
    const anchor = getAnchor(baseMaps[label], surface, venue, String(dist));
    const babaDiff2000 = babaMaps[label][dayKey] || 0;
    const babaDiff = babaDiff2000 * (dist / 2000);
    configs[label] = { anchor, babaDiff };
  }

  console.log('\n' + '='.repeat(100));
  const babaStr = PERCENTILES.map(p => {
    const l = 'P'+Math.round(p*100);
    const bd = configs[l].babaDiff;
    return l+'='+(bd>=0?'+':'')+bd.toFixed(2);
  }).join(' / ');
  console.log(raceId + '  ' + venue+' '+surface+dist+'m '+cls+'  馬場:'+cond);
  console.log('馬場差(実距離): ' + babaStr);
  console.log('-'.repeat(100));
  console.log('着順  馬名                斤量  タイム     現行P1.5   P50線形   P40線形   P30線形');
  console.log('-'.repeat(100));

  for (const row of rows) {
    if (!/^\d+$/.test(row['着順'])) continue;
    const totalSec = timeToSec(row['タイム']);
    if (!totalSec) continue;
    const weight = parseFloat(row['斤量']) || 57;
    const weightAdj = (weight - BASE_WEIGHT) * WEIGHT_FACTOR * (dist / 2000);
    const distScale = 2000 / dist;

    // 現行 (P50相当 + POWER=1.5)
    const c50 = configs['P50'];
    const oldTimeDiff = (c50.anchor.baseSec + c50.babaDiff) - totalSec + weightAdj;
    const oldIdx = Math.round(c50.anchor.anchorIndex +
      Math.sign(oldTimeDiff) * Math.pow(Math.abs(oldTimeDiff), 1.5) * 3.565 * distScale);

    // 各パーセンタイル × 線形K=10
    const newIdxs = {};
    for (const pct of PERCENTILES) {
      const label = 'P' + Math.round(pct * 100);
      const c = configs[label];
      if (!c.anchor) { newIdxs[label] = '-'; continue; }
      const timeDiff = (c.anchor.baseSec + c.babaDiff) - totalSec + weightAdj;
      newIdxs[label] = Math.round(c.anchor.anchorIndex + timeDiff * LINEAR_K * distScale);
    }

    const name = (row['馬名'] + '                ').substring(0, 16);
    const rank = row['着順'].padStart(2);
    console.log(rank + '    ' + name + '  ' + weight.toString().padStart(4) + '  ' +
      row['タイム'].padStart(7) + '       ' +
      oldIdx.toString().padStart(4) + '      ' +
      newIdxs['P50'].toString().padStart(4) + '      ' +
      newIdxs['P40'].toString().padStart(4) + '      ' +
      newIdxs['P30'].toString().padStart(4));
  }
}

console.log('\n\n=== 凡例 ===');
console.log('現行P1.5: POWER=1.5, POWER_K=3.565, trimmed mean基準タイム');
console.log('P50線形:  POWER=1.0, K=10, 50パーセンタイル基準タイム');
console.log('P40線形:  POWER=1.0, K=10, 40パーセンタイル基準タイム');
console.log('P30線形:  POWER=1.0, K=10, 30パーセンタイル基準タイム');
console.log('※馬場差は各パーセンタイルの基準タイムから再計算');
