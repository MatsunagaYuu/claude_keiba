const fs = require('fs');
const path = require('path');

// Read JSON files
const baseTimesArray = JSON.parse(fs.readFileSync('/Users/matsunagayu/Documents/my-project/base_times.json', 'utf-8'));
const babaDiffArray = JSON.parse(fs.readFileSync('/Users/matsunagayu/Documents/my-project/baba_diff.json', 'utf-8'));

// Convert arrays to lookup objects
const baseTimes = {};
baseTimesArray.forEach(entry => {
  const key = `${entry['芝/ダート']}_${entry['競馬場']}_${entry['距離']}`;
  if (!baseTimes[key]) {
    baseTimes[key] = {};
  }
  baseTimes[key][entry['クラス']] = {
    基準タイム秒: entry['基準走破秒'],
    サンプル数: entry['サンプル数']
  };
});

const babaDiff = {};
babaDiffArray.forEach(entry => {
  const key = `${entry['芝/ダート']}_${entry['年']}_${entry['競馬場']}_${entry['開催']}_${entry['日次']}`;
  babaDiff[key] = entry['馬場差'];
});

const CLASS_ANCHOR_INDEX = {
  'オープン': 315,
  '3歳オープン': 315,
  '4歳以上オープン': 315,
  '3勝クラス': 310,
  '4歳以上3勝クラス': 310,
  '2勝クラス': 305,
  '4歳以上2勝クラス': 305,
  '1勝クラス': 300,
  '4歳以上1勝クラス': 300,
  '未勝利': 280,
  '3歳未勝利': 280,
  '4歳以上未勝利': 280
};

function signedPow(x, power) {
  return Math.sign(x) * Math.pow(Math.abs(x), power);
}

function timeToSeconds(timeStr) {
  if (!timeStr || timeStr === '') return null;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return null;
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    results.push(row);
  }
  return results;
}

function getBaseTime(surface, venue, dist, raceClass) {
  const key = `${surface}_${venue}_${dist}`;
  const baseTimeEntry = baseTimes[key];
  
  if (!baseTimeEntry) return null;
  
  // Map race class names
  const classMapping = {
    '3歳オープン': 'OP',
    '4歳以上オープン': 'OP',
    'オープン': 'OP',
    '4歳以上3勝クラス': '3勝クラス',
    '4歳以上2勝クラス': '2勝クラス',
    '4歳以上1勝クラス': '1勝クラス',
    '3歳未勝利': '未勝利',
    '4歳以上未勝利': '未勝利'
  };
  
  // Try to get OP base time first
  const classOrder = ['OP', '3勝クラス', '2勝クラス', '1勝クラス', '未勝利'];
  
  for (const cls of classOrder) {
    if (baseTimeEntry[cls] && baseTimeEntry[cls].サンプル数 >= 30) {
      return {
        baseSec: baseTimeEntry[cls].基準タイム秒,
        anchorIndex: CLASS_ANCHOR_INDEX[cls] || CLASS_ANCHOR_INDEX[raceClass] || 280
      };
    }
  }
  
  return null;
}

function getBabaDiff(surface, year, venue, kai, day) {
  const key = `${surface}_${year}_${venue}_${kai}_${day}`;
  return babaDiff[key] || 0;
}

function calculateIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, power, powerK) {
  const baseTimeInfo = getBaseTime(surface, venue, dist, raceClass);
  if (!baseTimeInfo) return null;
  
  const { baseSec, anchorIndex } = baseTimeInfo;
  const year = 2026;
  const babaDiffValue = getBabaDiff(surface, year, venue, kai, day);
  const babaDiffScaled = babaDiffValue * (dist / 2000);
  
  const weightAdj = (weight - 57) * 0.2 * (dist / 2000);
  const distScale = 2000 / dist;
  
  const timeDiff = (baseSec + babaDiffScaled) - timeSec + weightAdj;
  const totalIdx = Math.round(anchorIndex + signedPow(timeDiff, power) * powerK * distScale);
  
  return {
    totalIdx,
    timeDiff,
    baseSec,
    babaDiffScaled,
    weightAdj,
    anchorIndex
  };
}

function calculateAsymmetricIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, powerK15, powerK18) {
  const baseTimeInfo = getBaseTime(surface, venue, dist, raceClass);
  if (!baseTimeInfo) return null;
  
  const { baseSec, anchorIndex } = baseTimeInfo;
  const year = 2026;
  const babaDiffValue = getBabaDiff(surface, year, venue, kai, day);
  const babaDiffScaled = babaDiffValue * (dist / 2000);
  
  const weightAdj = (weight - 57) * 0.2 * (dist / 2000);
  const distScale = 2000 / dist;
  
  const timeDiff = (baseSec + babaDiffScaled) - timeSec + weightAdj;
  
  // Use power=1.5 for positive timeDiff (faster), power=1.8 for negative (slower)
  let totalIdx;
  if (timeDiff >= 0) {
    totalIdx = Math.round(anchorIndex + signedPow(timeDiff, 1.5) * powerK15 * distScale);
  } else {
    totalIdx = Math.round(anchorIndex + signedPow(timeDiff, 1.8) * powerK18 * distScale);
  }
  
  return {
    totalIdx,
    timeDiff
  };
}

// Calibrate POWER_K values
// イクイノックス: timeDiff=3.26, target=21 points → POWER_K = 21 / (3.26^POWER)
function calibratePowerK(power) {
  const equinoxTimeDiff = 3.26;
  const targetPoints = 21;
  return targetPoints / Math.pow(equinoxTimeDiff, power);
}

const POWER_K_15 = calibratePowerK(1.5);
const POWER_K_17 = calibratePowerK(1.7);
const POWER_K_18 = calibratePowerK(1.8);
const POWER_K_20 = calibratePowerK(2.0);

console.log('POWER_K values:');
console.log(`POWER=1.5: ${POWER_K_15.toFixed(4)}`);
console.log(`POWER=1.7: ${POWER_K_17.toFixed(4)}`);
console.log(`POWER=1.8: ${POWER_K_18.toFixed(4)}`);
console.log(`POWER=2.0: ${POWER_K_20.toFixed(4)}`);
console.log('');

// Selected races from different classes
const races = [
  { file: 'result_202605010505.csv', name: '東京5日5R 3歳未勝利 芝1400' },
  { file: 'result_202605010512.csv', name: '東京5日12R 4歳以上1勝クラス 芝1600' },
  { file: 'result_202605010608.csv', name: '東京6日8R 4歳以上2勝クラス 芝1600' },
  { file: 'result_202605010511.csv', name: '東京5日11R 3歳オープン 芝1600' }
];

races.forEach(race => {
  console.log('='.repeat(120));
  console.log(`Race: ${race.name}`);
  console.log('='.repeat(120));
  
  const results = parseCSV(`/Users/matsunagayu/Documents/my-project/race_result/${race.file}`);
  
  if (results.length === 0) {
    console.log('No results found');
    console.log('');
    return;
  }
  
  const firstRow = results[0];
  const surface = firstRow['芝/ダート'];
  const venue = firstRow['競馬場名'];
  const dist = parseInt(firstRow['距離']);
  const kai = parseInt(firstRow['開催'].replace('回', ''));
  const dayMatch = firstRow['開催日'].match(/(\d+)日目/);
  const day = dayMatch ? parseInt(dayMatch[1]) : 1;
  const raceClass = firstRow['クラス'];
  
  console.log(`Surface: ${surface}, Venue: ${venue}, Distance: ${dist}m, Class: ${raceClass}`);
  console.log('');
  
  // Calculate for each horse
  const tableData = [];
  
  for (const row of results) {
    const chakujun = row['着順'];
    const horseName = row['馬名'];
    const timeStr = row['タイム'];
    const weight = parseFloat(row['斤量']);
    
    const timeSec = timeToSeconds(timeStr);
    if (!timeSec) continue;
    
    const idx15 = calculateIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, 1.5, POWER_K_15);
    const idx17 = calculateIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, 1.7, POWER_K_17);
    const idx18 = calculateIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, 1.8, POWER_K_18);
    const idx20 = calculateIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, 2.0, POWER_K_20);
    const idxAsym = calculateAsymmetricIndex(timeSec, weight, dist, surface, venue, kai, day, raceClass, POWER_K_15, POWER_K_18);
    
    if (!idx15 || !idx17 || !idx18 || !idx20 || !idxAsym) continue;
    
    tableData.push({
      chakujun,
      horseName,
      timeStr,
      timeDiff: idx15.timeDiff,
      idx15: idx15.totalIdx,
      idx17: idx17.totalIdx,
      idx18: idx18.totalIdx,
      idx20: idx20.totalIdx,
      idxAsym: idxAsym.totalIdx
    });
  }
  
  // Print table header
  console.log('着順    馬名                  タイム       timeDiff  idx(1.5)  idx(1.7)  idx(1.8)  idx(2.0)  idx(asym)');
  console.log('-'.repeat(120));
  
  // Print table rows
  tableData.forEach(data => {
    console.log(
      data.chakujun.padEnd(8) +
      data.horseName.padEnd(22) +
      data.timeStr.padEnd(13) +
      data.timeDiff.toFixed(2).padStart(8) +
      '  ' +
      data.idx15.toString().padStart(8) +
      '  ' +
      data.idx17.toString().padStart(8) +
      '  ' +
      data.idx18.toString().padStart(8) +
      '  ' +
      data.idx20.toString().padStart(8) +
      '  ' +
      data.idxAsym.toString().padStart(9)
    );
  });
  
  console.log('');
  console.log('Note: Asymmetric uses POWER=1.5 for positive timeDiff (faster) and POWER=1.8 for negative timeDiff (slower)');
  console.log('');
});

console.log('Simulation complete!');
