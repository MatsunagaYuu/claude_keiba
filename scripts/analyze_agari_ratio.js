#!/usr/bin/env node
// scripts/analyze_agari_ratio.js
// 上がり指数の absoluteAgari 比率変更インパクト分析
// Usage: node scripts/analyze_agari_ratio.js [--top=20]

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const BT_ARRAY        = JSON.parse(fs.readFileSync(path.join(ROOT, 'base_times.json'),          'utf8'));
const BABA_DATA       = JSON.parse(fs.readFileSync(path.join(ROOT, 'external_baba_diff.json'), 'utf8'));
const RACE_RESULT_DIR = path.join(ROOT, 'race_result_fromDB');

const CALIBRATION_FACTOR = 6.667;
const CALIBRATION_DIST   = 2000;
const DRAFT_FACTOR       = 0.6;

// 比較する比率パターン [abs比率, rel比率]
const RATIOS = [
  [0.5, 0.5],
  [0.3, 0.7],
  [0.2, 0.8],
  [0.0, 1.0],
];

const globalAvgStddev = BT_ARRAY.reduce((s, r) => s + (r['上がり標準偏差'] || 0), 0) / BT_ARRAY.length;

// ── ユーティリティ ──

function timeToSec(t) {
  if (!t) return null;
  const m = t.match(/^(\d+):(\d+\.\d+)$/);
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2]);
  const s = parseFloat(t);
  return isNaN(s) ? null : s;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, '');
    });
    return obj;
  });
}

function getBabaDiff(dateStr, venue, surface, dist) {
  const [y, m, d] = dateStr.split('/');
  const dateKey = `${y}/${m.padStart(2,'0')}/${d.padStart(2,'0')}`;
  const rec = BABA_DATA.find(r => r['日付'] === dateKey && r['競馬場'] === venue);
  if (!rec) return null;
  if (surface === '芝') {
    const v = rec['芝馬場差'];
    return (v !== null && v !== undefined) ? v * (dist / 2000) : null;
  } else {
    const v = rec['ダート馬場差'];
    return (v !== null && v !== undefined) ? v * (0.000425 * dist + 0.352) : null;
  }
}

function getAgeClass(cls) {
  if (/2歳.*新馬/.test(cls))   return '2歳新馬';
  if (/2歳.*未勝利/.test(cls)) return '2歳未勝利';
  if (/2歳.*1勝/.test(cls))    return '2歳1勝';
  if (/2歳.*OP/.test(cls))     return '2歳OP';
  if (/3歳.*新馬/.test(cls))   return '3歳新馬';
  if (/3歳.*未勝利/.test(cls)) return '3歳未勝利';
  if (/3歳以上.*1勝/.test(cls)) return '3歳以上1勝';
  if (/3歳以上.*2勝/.test(cls)) return '3歳以上2勝';
  if (/3歳以上.*3勝/.test(cls)) return '3歳以上3勝';
  if (/3歳以上.*OP/.test(cls))  return '3歳以上OP';
  if (/3歳.*1勝/.test(cls))    return '3歳1勝';
  if (/3歳.*OP/.test(cls))     return '3歳OP';
  if (/4歳以上.*1勝/.test(cls)) return '4歳以上1勝';
  if (/4歳以上.*2勝/.test(cls)) return '4歳以上2勝';
  if (/4歳以上.*3勝/.test(cls)) return '4歳以上3勝';
  if (/4歳以上.*OP/.test(cls))  return '4歳以上OP';
  return null;
}

function findBt(surface, venue, dist, ageClass) {
  const d = String(dist);
  let rec = BT_ARRAY.find(r =>
    r['芝/ダート'] === surface && r['競馬場'] === venue &&
    String(r['距離']) === d && r['クラス'] === ageClass
  );
  if (rec) return rec;
  for (const fb of ['3歳以上OP', '4歳以上OP']) {
    rec = BT_ARRAY.find(r =>
      r['芝/ダート'] === surface && r['競馬場'] === venue &&
      String(r['距離']) === d && r['クラス'] === fb
    );
    if (rec) return rec;
  }
  return null;
}

// ── メイン処理 ──

const args  = process.argv.slice(2);
const topN  = parseInt((args.find(a => a.startsWith('--top=')) || '--top=20').split('=')[1]);

process.stderr.write('2026年レース読み込み中...\n');

const allFiles = fs.readdirSync(RACE_RESULT_DIR)
  .filter(f => f.startsWith('result_2026') && f.endsWith('.csv'));

const raceResults = [];

for (const file of allFiles) {
  const rows = parseCsv(fs.readFileSync(path.join(RACE_RESULT_DIR, file), 'utf8'));
  const validRows = rows.filter(r => /^\d+$/.test(r['着順']));
  if (validRows.length < 4) continue;

  const first    = rows[0];
  const surface  = first['芝/ダート'];
  const venue    = first['競馬場名'];
  const dist     = parseInt(first['距離']);
  const dateStr  = first['日付'];
  const cls      = first['クラス'];
  const raceName = first['レース名'] || cls;

  const ageClass = getAgeClass(cls);
  if (!ageClass) continue;

  const bt = findBt(surface, venue, dist, ageClass);
  if (!bt) continue;

  let babaDiff = getBabaDiff(dateStr, venue, surface, dist);
  if (babaDiff === null) babaDiff = 0;

  const factor          = CALIBRATION_FACTOR * (CALIBRATION_DIST / dist);
  const anchorEarlyBase = bt['基準前半秒'] + babaDiff * 0.6;
  const anchorLast3fBase = bt['基準上がり秒'] + babaDiff * 0.4;
  const slope           = bt['回帰スロープ'] || 0;
  const courseStddev    = bt['上がり標準偏差'] || globalAvgStddev;
  const courseFactor    = globalAvgStddev / courseStddev;

  // 先頭の前半タイム
  let leaderEarly = Infinity;
  for (const r of validRows) {
    const tot = timeToSec(r['タイム']);
    const l3f = parseFloat(r['上がり']);
    if (tot && l3f && !isNaN(l3f)) {
      const e = tot - l3f;
      if (e < leaderEarly) leaderEarly = e;
    }
  }
  if (!isFinite(leaderEarly)) continue;

  const raceEarlyDiff = leaderEarly - anchorEarlyBase;

  // 各馬の中間値を計算
  const horses = [];
  for (const r of validRows) {
    const tot = timeToSec(r['タイム']);
    const l3f = parseFloat(r['上がり']);
    if (!tot || !l3f || isNaN(l3f)) continue;

    const earlySec    = tot - l3f;
    const earlyDiff   = earlySec - anchorEarlyBase;
    const expectedL3f = anchorLast3fBase + slope * earlyDiff;
    const posGap      = earlySec - leaderEarly;
    const adjL3f      = l3f + posGap * DRAFT_FACTOR;

    const absAgari = anchorLast3fBase - l3f;
    const relAgari = expectedL3f - adjL3f;

    const agariByRatio = RATIOS.map(([ar, rr]) =>
      Math.round((absAgari * ar + relAgari * rr) * courseFactor * factor)
    );

    horses.push({
      rank: parseInt(r['着順']),
      name: r['馬名'],
      last3f: l3f,
      absAgari,
      relAgari,
      agariByRatio,
    });
  }
  if (!horses.length) continue;

  const positiveRatio = RATIOS.map((_, ri) =>
    horses.filter(h => h.agariByRatio[ri] > 0).length / horses.length
  );

  raceResults.push({
    raceId: file.replace('result_','').replace('.csv',''),
    label: `${raceName} ${venue}${dist}m ${dateStr}`,
    cls,
    raceEarlyDiff,
    positiveRatio,
    horses,
  });
}

process.stderr.write(`処理完了: ${raceResults.length}レース\n`);

// スロー度でソート
raceResults.sort((a, b) => b.raceEarlyDiff - a.raceEarlyDiff);

// ── 出力 ──

const W = 92;
console.log(`\n${'═'.repeat(W)}`);
console.log(`  上がり指数 絶対評価比率 変更インパクト分析（2026年 全${raceResults.length}レース）`);
console.log('═'.repeat(W));
console.log(`  パターン: ${RATIOS.map(([a,r]) => `abs${(a*100).toFixed(0)}:rel${(r*100).toFixed(0)}`).join(' → ')}`);

// ── 1. 全体統計 ──
console.log(`\n${'─'.repeat(W)}`);
console.log('  【全体統計】上がり指数がプラスの馬の平均比率（全レース）');
console.log('─'.repeat(W));
RATIOS.forEach(([ar, rr], i) => {
  const avg = raceResults.reduce((s, r) => s + r.positiveRatio[i], 0) / raceResults.length;
  const bar = '█'.repeat(Math.round(avg * 40));
  console.log(`  abs${(ar*100).toFixed(0)}:rel${(rr*100).toFixed(0)}  ${(avg*100).toFixed(1).padStart(5)}%  ${bar}`);
});

// ── 2. スロー上位N件 ──
console.log(`\n${'─'.repeat(W)}`);
console.log(`  【スローペースTOP${topN}】前半が基準より遅かったレース`);
console.log('─'.repeat(W));
const header = `  ${'レース'.padEnd(34)} ${'クラス'.padEnd(10)} ${'前半差'.padStart(5)}秒  ` +
  RATIOS.map(([a,r]) => `${('abs'+Math.round(a*100)+':rel'+Math.round(r*100)).padStart(10)}`).join(' ');
console.log(header);
console.log('  ' + '-'.repeat(W - 2));

for (const race of raceResults.slice(0, topN)) {
  const lbl  = race.label.length > 32 ? race.label.slice(0,31) + '…' : race.label.padEnd(32);
  const cls  = race.cls.padEnd(10);
  const diff = `+${race.raceEarlyDiff.toFixed(1)}`.padStart(5);
  const pcts = race.positiveRatio.map(r => `${(r*100).toFixed(0)}%`.padStart(10)).join(' ');
  console.log(`  ${lbl}  ${cls} ${diff}秒  ${pcts}`);
}

// ── 3. ハイペース上位N件（比較用） ──
const hiPace = [...raceResults].sort((a,b) => a.raceEarlyDiff - b.raceEarlyDiff);
console.log(`\n${'─'.repeat(W)}`);
console.log(`  【ハイペースTOP${topN}】前半が基準より速かったレース`);
console.log('─'.repeat(W));
console.log(header);
console.log('  ' + '-'.repeat(W - 2));

for (const race of hiPace.slice(0, topN)) {
  const lbl  = race.label.length > 32 ? race.label.slice(0,31) + '…' : race.label.padEnd(32);
  const cls  = race.cls.padEnd(10);
  const diff = `${race.raceEarlyDiff.toFixed(1)}`.padStart(5);
  const pcts = race.positiveRatio.map(r => `${(r*100).toFixed(0)}%`.padStart(10)).join(' ');
  console.log(`  ${lbl}  ${cls} ${diff}秒  ${pcts}`);
}

// ── 4. スロー上位5レースの馬別詳細 ──
console.log(`\n${'─'.repeat(W)}`);
console.log('  【スローTOP5 馬別詳細】abs秒差 / rel秒差 / 上がり指数（各比率）');
console.log('─'.repeat(W));

for (const race of raceResults.slice(0, 5)) {
  console.log(`\n  ${race.label}（前半 +${race.raceEarlyDiff.toFixed(2)}秒 スロー）`);
  console.log(`  ${'着'.padStart(2)} ${'馬名'.padEnd(14)} ${'上がり'.padStart(5)}  ${'abs秒'.padStart(6)} ${'rel秒'.padStart(6)}  ` +
    RATIOS.map(([a,r]) => `${('abs'+Math.round(a*100)).padStart(6)}`).join(' '));
  for (const h of [...race.horses].sort((a,b) => a.rank - b.rank)) {
    const idxs = h.agariByRatio.map(v => String(v).padStart(6)).join(' ');
    console.log(`  ${String(h.rank).padStart(2)} ${h.name.padEnd(14)} ${h.last3f.toFixed(1).padStart(5)}  ${h.absAgari.toFixed(2).padStart(6)} ${h.relAgari.toFixed(2).padStart(6)}  ${idxs}`);
  }
}
