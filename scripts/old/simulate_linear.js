const fs = require('fs');
const path = require('path');

const baseTimes = JSON.parse(fs.readFileSync('./base_times.json','utf-8'));
const babaDiffs = JSON.parse(fs.readFileSync('./baba_diff.json','utf-8'));

const baseMap = {};
for (const bt of baseTimes) {
  const key = bt['芝/ダート']+'_'+bt.競馬場+'_'+bt.距離+'_'+bt.クラス;
  baseMap[key] = bt;
}
const babaMap = {};
for (const bd of babaDiffs) {
  const key = bd['芝/ダート']+'_'+bd.年+'_'+bd.競馬場+'_'+bd.開催+'_'+bd.日次;
  babaMap[key] = bd;
}

const CLASS_ORDER = ['OP','3勝クラス','2勝クラス','1勝クラス','未勝利'];
const CLASS_ANCHOR = { OP:315, '3勝クラス':310, '2勝クラス':305, '1勝クラス':300, '未勝利':280 };
const MIN_SAMPLES = 30;

function getAnchor(surface, venue, dist) {
  for (const cls of CLASS_ORDER) {
    const bt = baseMap[surface+'_'+venue+'_'+dist+'_'+cls];
    if (bt && bt.サンプル数 >= MIN_SAMPLES) return { bt, anchorIndex: CLASS_ANCHOR[cls] };
  }
  for (const cls of CLASS_ORDER) {
    const bt = baseMap[surface+'_'+venue+'_'+dist+'_'+cls];
    if (bt) return { bt, anchorIndex: CLASS_ANCHOR[cls] };
  }
  return null;
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

function timeToSec(s) {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d+\.\d+)$/);
  return m ? parseInt(m[1])*60+parseFloat(m[2]) : null;
}

function signedPow(x,p) { return Math.sign(x)*Math.pow(Math.abs(x),p); }

const races = [
  'result_202605010505.csv',  // 3歳未勝利 芝1400
  'result_202605010512.csv',  // 1勝クラス 芝1600
  'result_202605010608.csv',  // 2勝クラス 芝1600
  'result_202605010609.csv',  // 3勝クラス 芝1600
  'result_202605010511.csv',  // 3歳OP 芝1600
  'result_202605010610.csv',  // OP ダート1400
  'result_202605010612.csv',  // 2勝クラス ダート1400
];

const OLD_POWER = 1.5, OLD_K = 3.565;
const NEW_K = 10;

for (const file of races) {
  const fp = path.join('./race_result', file);
  if (!fs.existsSync(fp)) continue;
  const content = fs.readFileSync(fp,'utf-8');
  const lines = content.split('\n').filter(l=>l.trim());
  if (lines.length<2) continue;
  const headers = lines[0].split(',');
  const rows = [];
  for (let i=1;i<lines.length;i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h,idx) => row[h]=vals[idx]||'');
    rows.push(row);
  }

  const first = rows[0];
  const venue=first['競馬場名'], surface=first['芝/ダート'], dist=first['距離'];
  const cls=first['クラス'], cond=first['馬場'];
  const kai=parseInt(first['開催'].replace('回','')), day=parseInt(first['開催日'].replace('日目',''));

  const cat = classifyRace(cls);
  if (!cat) continue;
  const anchor = getAnchor(surface, venue, dist);
  if (!anchor) continue;
  const anchorBt = anchor.bt, anchorIdx = anchor.anchorIndex;
  const babaKey = surface+'_2026_'+venue+'_'+kai+'_'+day;
  const bd = babaMap[babaKey];
  const babaDiff = bd ? bd.馬場差 * (parseInt(dist)/2000) : 0;

  console.log('='.repeat(95));
  console.log(file.replace('result_','').replace('.csv','') + '  ' + venue+' '+surface+dist+'m '+cls+'  馬場:'+cond+'  anchor='+anchorBt.クラス+'('+anchorIdx+')  babaDiff='+(babaDiff>=0?'+':'')+babaDiff.toFixed(2));
  console.log('-'.repeat(95));
  console.log('着順  馬名                斤量  タイム    秒差(2000m)  現行(P1.5)  線形(K=10)  差分');
  console.log('-'.repeat(95));

  for (const row of rows) {
    if (!/^\d+$/.test(row['着順'])) continue;
    const totalSec = timeToSec(row['タイム']);
    if (!totalSec) continue;
    const weight = parseFloat(row['斤量']) || 57;
    const weightAdj = (weight-57)*0.2*(parseInt(dist)/2000);
    const distScale = 2000/parseInt(dist);
    const refBase = anchorBt.基準走破秒 + babaDiff;
    const timeDiff = refBase - totalSec + weightAdj;

    const oldIdx = Math.round(anchorIdx + signedPow(timeDiff, OLD_POWER)*OLD_K*distScale);
    const newIdx = Math.round(anchorIdx + timeDiff*NEW_K*distScale);
    const diff = newIdx - oldIdx;

    const name = (row['馬名']+'                ').substring(0,16);
    const rank = row['着順'].padStart(2);
    const diffStr = (diff>=0?'+':'')+diff;
    console.log(rank+'    '+name+'  '+weight.toString().padStart(4)+'  '+row['タイム'].padStart(7)+'     '+(timeDiff>=0?'+':'')+timeDiff.toFixed(2).padStart(6)+'       '+oldIdx.toString().padStart(4)+'        '+newIdx.toString().padStart(4)+'    '+diffStr);
  }
  console.log('');
}
