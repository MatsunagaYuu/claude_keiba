const fs = require('fs');
const path = require('path');

const RACE_DIR = path.join(__dirname, 'race_index');

// Class hierarchy mapping
function getClassLevel(className) {
  if (/新馬/.test(className)) return 1;
  if (/未勝利/.test(className)) return 1;
  if (/1勝|500万下/.test(className)) return 2;
  if (/2勝|1000万下/.test(className)) return 3;
  if (/3勝|1600万下/.test(className)) return 4;
  if (/オープン|G[1-3]|リステッド|重賞/.test(className)) return 5;
  return 0; // unknown
}

const CLASS_LEVEL_NAMES = { 1: '未勝利/新馬', 2: '1勝', 3: '2勝', 4: '3勝', 5: 'OP/重賞' };

// Parse time string like "1:50.1" to seconds
function parseTime(timeStr) {
  if (!timeStr || timeStr === '') return null;
  const match = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!match) return null;
  return parseInt(match[1]) * 60 + parseFloat(match[2]);
}

// Parse a CSV line (simple - no quoted commas expected)
function parseLine(line) {
  const cols = line.split(',');
  if (cols.length < 24) return null;
  return {
    venue: cols[0],
    className: cols[3],
    surface: cols[4],
    distance: cols[5],
    weather: cols[6],
    condition: cols[7],
    rank: parseInt(cols[8]),
    horseName: cols[11],
    time: cols[15],
    sougouIndex: parseFloat(cols[21]) || 0,
    agariIndex: parseFloat(cols[22]) || 0,
    nouryokuIndex: parseFloat(cols[23]) || 0,
  };
}

console.log('Reading race_index files...');
const files = fs.readdirSync(RACE_DIR).filter(f => f.endsWith('.csv'));
console.log(`Found ${files.length} files.`);

// Phase 1: Group races by day-venue prefix and collect all race winners
// Also build a horse -> race history map

// Map: raceId -> { className, classLevel, surface, distance, venue, winner }
// Map: dayVenueKey -> [raceId, ...]
// Map: horseName -> [{ raceId, className, classLevel, rank, sougouIndex, time, ... }]

const dayVenueRaces = {}; // key: YYYYVVKKDD -> [{raceId, className, classLevel, surface, distance, winner}]
const horseHistory = {};  // horseName -> [{raceId, className, classLevel, rank, sougouIndex, time}]

let processedCount = 0;

for (const file of files) {
  const raceId = file.replace('index_', '').replace('.csv', '');
  const dayVenueKey = raceId.substring(0, 10);

  const content = fs.readFileSync(path.join(RACE_DIR, file), 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) continue;

  // Parse header + first data line to get race info
  let winner = null;
  const raceHorses = [];

  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (!parsed) continue;

    const classLevel = getClassLevel(parsed.className);

    const horseEntry = {
      raceId,
      className: parsed.className,
      classLevel,
      rank: parsed.rank,
      sougouIndex: parsed.sougouIndex,
      time: parsed.time,
      timeSec: parseTime(parsed.time),
      venue: parsed.venue,
      surface: parsed.surface,
      distance: parsed.distance,
      horseName: parsed.horseName,
      condition: parsed.condition,
    };

    // Track horse history
    if (!horseHistory[parsed.horseName]) horseHistory[parsed.horseName] = [];
    horseHistory[parsed.horseName].push(horseEntry);

    if (parsed.rank === 1 && !winner) {
      winner = horseEntry;
    }
  }

  if (winner && winner.classLevel > 0) {
    if (!dayVenueRaces[dayVenueKey]) dayVenueRaces[dayVenueKey] = [];
    dayVenueRaces[dayVenueKey].push(winner);
  }

  processedCount++;
  if (processedCount % 5000 === 0) {
    console.log(`  Processed ${processedCount}/${files.length} files...`);
  }
}

console.log(`Processed all ${processedCount} files.`);
console.log(`Unique day-venue groups: ${Object.keys(dayVenueRaces).length}`);
console.log(`Unique horses tracked: ${Object.keys(horseHistory).length}`);

// Phase 2: Find cross-class time inversions
console.log('\n=== Phase 2: Finding cross-class time inversions ===\n');

const inversions = [];
let totalComparablePairs = 0;

for (const [dayKey, races] of Object.entries(dayVenueRaces)) {
  // Group by surface + distance
  const groups = {};
  for (const race of races) {
    const key = `${race.surface}_${race.distance}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(race);
  }

  for (const [groupKey, groupRaces] of Object.entries(groups)) {
    if (groupRaces.length < 2) continue;

    // Compare all pairs
    for (let i = 0; i < groupRaces.length; i++) {
      for (let j = i + 1; j < groupRaces.length; j++) {
        const a = groupRaces[i];
        const b = groupRaces[j];

        if (a.classLevel === b.classLevel) continue;
        if (!a.timeSec || !b.timeSec) continue;

        totalComparablePairs++;

        const lower = a.classLevel < b.classLevel ? a : b;
        const upper = a.classLevel < b.classLevel ? b : a;

        // Inversion: lower class winner ran faster (smaller time)
        if (lower.timeSec < upper.timeSec) {
          inversions.push({ lower, upper, timeDiff: upper.timeSec - lower.timeSec });
        }
      }
    }
  }
}

console.log(`Total comparable pairs (same day/venue/surface/distance, different class): ${totalComparablePairs}`);
console.log(`Time inversions (lower class faster): ${inversions.length}`);
console.log(`Inversion rate: ${(inversions.length / totalComparablePairs * 100).toFixed(1)}%`);

// Sort by time difference descending
inversions.sort((a, b) => b.timeDiff - a.timeDiff);

// Phase 3: Track future performance of faster lower-class horses
console.log('\n=== Phase 3: Tracking future performance of faster lower-class horses ===\n');

let trackedCount = 0;
let laterHigherClassCount = 0;
let laterHigherClassWinOrPlace = 0;

const detailedCases = [];

for (const inv of inversions) {
  const horseName = inv.lower.horseName;
  const history = horseHistory[horseName] || [];

  // Find subsequent races at a higher class level
  const laterRaces = history.filter(h =>
    h.raceId > inv.lower.raceId && h.classLevel > inv.lower.classLevel
  );

  const laterWinsOrPlaces = laterRaces.filter(h => h.rank <= 3);
  const laterWins = laterRaces.filter(h => h.rank === 1);

  trackedCount++;
  if (laterRaces.length > 0) laterHigherClassCount++;
  if (laterWinsOrPlaces.length > 0) laterHigherClassWinOrPlace++;

  // Also get upper class horse future
  const upperHistory = horseHistory[inv.upper.horseName] || [];
  const upperLaterRaces = upperHistory.filter(h => h.raceId > inv.upper.raceId);

  detailedCases.push({
    ...inv,
    laterRaces,
    laterWinsOrPlaces,
    laterWins,
    upperLaterRaces: upperLaterRaces.slice(0, 5),
  });
}

// Phase 4: Output concrete examples
console.log('\n=== Phase 4: Concrete examples of time inversions ===\n');

// Show top 15 by time difference
const examples = detailedCases.slice(0, 20);

for (let i = 0; i < Math.min(examples.length, 20); i++) {
  const ex = examples[i];
  console.log(`--- Example ${i + 1} ---`);
  console.log(`  Date/Venue: ${ex.lower.raceId.substring(0, 4)}年 venue-prefix=${ex.lower.raceId.substring(0, 10)}, ${ex.lower.venue}`);
  console.log(`  Surface/Distance: ${ex.lower.surface} ${ex.lower.distance}m, 馬場: ${ex.lower.condition}`);
  console.log(`  [LOWER CLASS] ${ex.lower.className} (Lv${ex.lower.classLevel})`);
  console.log(`    Winner: ${ex.lower.horseName}, Time: ${ex.lower.time} (${ex.lower.timeSec.toFixed(1)}s), 総合指数: ${ex.lower.sougouIndex}`);
  console.log(`  [UPPER CLASS] ${ex.upper.className} (Lv${ex.upper.classLevel})`);
  console.log(`    Winner: ${ex.upper.horseName}, Time: ${ex.upper.time} (${ex.upper.timeSec.toFixed(1)}s), 総合指数: ${ex.upper.sougouIndex}`);
  console.log(`  Time diff: ${ex.timeDiff.toFixed(1)}s (lower class was faster)`);
  console.log(`  Lower class winner's subsequent higher-class races: ${ex.laterRaces.length}`);
  if (ex.laterRaces.length > 0) {
    for (const lr of ex.laterRaces.slice(0, 5)) {
      console.log(`    -> ${lr.className}(Lv${lr.classLevel}) 着順:${lr.rank} 総合指数:${lr.sougouIndex} Time:${lr.time}`);
    }
  }
  if (ex.laterWinsOrPlaces.length > 0) {
    console.log(`  ★ Won or placed (top 3) in higher class: ${ex.laterWinsOrPlaces.length} times`);
  }
  console.log('');
}

// Phase 5: Summary statistics
console.log('\n=== Phase 5: Summary Statistics ===\n');

console.log(`Total comparable cross-class pairs: ${totalComparablePairs}`);
console.log(`Time inversions (lower class winner faster): ${inversions.length} (${(inversions.length / totalComparablePairs * 100).toFixed(1)}%)`);
console.log('');

// Average time diff for inversions
const avgTimeDiff = inversions.reduce((s, i) => s + i.timeDiff, 0) / inversions.length;
console.log(`Average time difference in inversions: ${avgTimeDiff.toFixed(2)}s`);
console.log(`Median time difference: ${inversions[Math.floor(inversions.length / 2)].timeDiff.toFixed(2)}s`);
console.log('');

// Future performance
console.log(`Tracked lower-class faster horses: ${trackedCount}`);
console.log(`  Later raced at higher class: ${laterHigherClassCount} (${(laterHigherClassCount / trackedCount * 100).toFixed(1)}%)`);
console.log(`  Won or placed (top 3) at higher class: ${laterHigherClassWinOrPlace} (${(laterHigherClassWinOrPlace / trackedCount * 100).toFixed(1)}%)`);
console.log('');

// Index comparison
const lowerIndices = inversions.map(i => i.lower.sougouIndex).filter(x => x > 0);
const upperIndices = inversions.map(i => i.upper.sougouIndex).filter(x => x > 0);
const avgLowerIdx = lowerIndices.reduce((s, x) => s + x, 0) / lowerIndices.length;
const avgUpperIdx = upperIndices.reduce((s, x) => s + x, 0) / upperIndices.length;

console.log(`Average 総合指数 of faster lower-class winners: ${avgLowerIdx.toFixed(1)}`);
console.log(`Average 総合指数 of slower upper-class winners: ${avgUpperIdx.toFixed(1)}`);
console.log(`Difference: ${(avgLowerIdx - avgUpperIdx).toFixed(1)}`);
console.log('');

// Breakdown by class level gap
const byGap = {};
for (const inv of inversions) {
  const gap = inv.upper.classLevel - inv.lower.classLevel;
  if (!byGap[gap]) byGap[gap] = { count: 0, timeDiffs: [], lowerIdx: [], upperIdx: [] };
  byGap[gap].count++;
  byGap[gap].timeDiffs.push(inv.timeDiff);
  if (inv.lower.sougouIndex > 0) byGap[gap].lowerIdx.push(inv.lower.sougouIndex);
  if (inv.upper.sougouIndex > 0) byGap[gap].upperIdx.push(inv.upper.sougouIndex);
}

console.log('Breakdown by class level gap:');
for (const [gap, data] of Object.entries(byGap).sort((a, b) => a[0] - b[0])) {
  const avgTD = data.timeDiffs.reduce((s, x) => s + x, 0) / data.timeDiffs.length;
  const avgLI = data.lowerIdx.length > 0 ? data.lowerIdx.reduce((s, x) => s + x, 0) / data.lowerIdx.length : 0;
  const avgUI = data.upperIdx.length > 0 ? data.upperIdx.reduce((s, x) => s + x, 0) / data.upperIdx.length : 0;
  console.log(`  Gap=${gap}: ${data.count} cases, avg time diff=${avgTD.toFixed(2)}s, lower avg idx=${avgLI.toFixed(1)}, upper avg idx=${avgUI.toFixed(1)}`);
}

// Future success rate breakdown by class gap
console.log('\nFuture success rate by class level gap:');
const futureByGap = {};
for (const dc of detailedCases) {
  const gap = dc.upper.classLevel - dc.lower.classLevel;
  if (!futureByGap[gap]) futureByGap[gap] = { total: 0, raced: 0, placed: 0 };
  futureByGap[gap].total++;
  if (dc.laterRaces.length > 0) futureByGap[gap].raced++;
  if (dc.laterWinsOrPlaces.length > 0) futureByGap[gap].placed++;
}

for (const [gap, data] of Object.entries(futureByGap).sort((a, b) => a[0] - b[0])) {
  console.log(`  Gap=${gap}: ${data.total} horses, ${data.raced} (${(data.raced / data.total * 100).toFixed(1)}%) raced higher, ${data.placed} (${(data.placed / data.total * 100).toFixed(1)}%) placed top 3`);
}

// Compare future indices
console.log('\nFuture 総合指数 comparison (lower-class fast horses vs upper-class winners):');
const lowerFutureIndices = [];
const upperFutureIndices = [];
for (const dc of detailedCases) {
  for (const lr of dc.laterRaces) {
    if (lr.sougouIndex > 0) lowerFutureIndices.push(lr.sougouIndex);
  }
  for (const ur of dc.upperLaterRaces) {
    if (ur.sougouIndex > 0) upperFutureIndices.push(ur.sougouIndex);
  }
}

if (lowerFutureIndices.length > 0) {
  const avgLF = lowerFutureIndices.reduce((s, x) => s + x, 0) / lowerFutureIndices.length;
  console.log(`  Faster lower-class horses' future avg 総合指数: ${avgLF.toFixed(1)} (n=${lowerFutureIndices.length})`);
}
if (upperFutureIndices.length > 0) {
  const avgUF = upperFutureIndices.reduce((s, x) => s + x, 0) / upperFutureIndices.length;
  console.log(`  Slower upper-class winners' future avg 総合指数: ${avgUF.toFixed(1)} (n=${upperFutureIndices.length})`);
}

// Correlation: does larger time advantage predict future success?
console.log('\nDoes larger time advantage predict future success?');
const quartile = Math.floor(inversions.length / 4);
const buckets = [
  { label: 'Top 25% time diff', cases: detailedCases.slice(0, quartile) },
  { label: '25-50%', cases: detailedCases.slice(quartile, quartile * 2) },
  { label: '50-75%', cases: detailedCases.slice(quartile * 2, quartile * 3) },
  { label: 'Bottom 25%', cases: detailedCases.slice(quartile * 3) },
];

for (const bucket of buckets) {
  const total = bucket.cases.length;
  const raced = bucket.cases.filter(c => c.laterRaces.length > 0).length;
  const placed = bucket.cases.filter(c => c.laterWinsOrPlaces.length > 0).length;
  const avgTD = bucket.cases.reduce((s, c) => s + c.timeDiff, 0) / total;
  console.log(`  ${bucket.label}: n=${total}, avg time diff=${avgTD.toFixed(2)}s, raced higher=${(raced/total*100).toFixed(1)}%, placed top3=${(placed/total*100).toFixed(1)}%`);
}

console.log('\n=== Analysis Complete ===');
