#!/usr/bin/env node
// scripts/parse_baba_input.js
// 馬場差テキスト入力 → patch_baba_diff.js 用JSON変換
//
// Usage:
//   node scripts/parse_baba_input.js input.txt
//   node scripts/parse_baba_input.js input.txt | node scripts/patch_baba_diff.js /dev/stdin
//
// 入力フォーマット:
//   YYYYMMDD
//   競馬場名
//   　芝　　　-2.3(4,5R)→-2.7(7,9,10R)
//   　ダート　-1.7(1,2,3R)→-1.2(6,8,11,12R)(1200m=-0.6(3R)→-0.4(12R))
//
// 出力レース別馬場差キー:
//   "芝"          → 芝メイン変動
//   "ダート"       → ダートメイン変動
//   "芝_1000"     → 芝1000m変動
//   "ダート_1200"  → ダート1200m変動

'use strict';

const fs = require('fs');

// 全角マイナス・プラス・空白を正規化して全空白除去
function normalizeStr(str) {
  return str
    .replace(/−/g, '-')
    .replace(/＋/g, '+')
    .replace(/\s/g, '');
}

function parseFloat2(s) {
  return parseFloat(s.replace(/^\+/, ''));
}

function parseRaceNums(s) {
  return s.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
}

// "数値" or "数値(R,R,...R)" or "数値(R,R,...)" → {value, races: [...] or null}
function parseValueWithRaces(s) {
  s = s.trim();
  const m = s.match(/^([-+]?\d+\.?\d*)\(([^)]+)\)$/);
  if (m) {
    // Rを除去してからレース番号をパース (2R,3R → [2,3] / 2,3 → [2,3] 両対応)
    return { value: parseFloat2(m[1]), races: parseRaceNums(m[2].replace(/R/gi, '')) };
  }
  const vm = s.match(/^([-+]?\d+\.?\d*)$/);
  if (vm) return { value: parseFloat2(vm[1]), races: null };
  return null;
}

// ネスト括弧を考慮して (Xm=...) 部分を抽出し、残りのメイン文字列と分離
function extractDistanceParts(str) {
  const distParts = [];
  const toRemove = [];
  let i = 0;
  while (i < str.length) {
    const start = str.indexOf('(', i);
    if (start === -1) break;
    if (!/^\d+m=/.test(str.slice(start + 1))) { i = start + 1; continue; }
    let depth = 0, end = -1;
    for (let j = start; j < str.length; j++) {
      if (str[j] === '(') depth++;
      else if (str[j] === ')') { if (--depth === 0) { end = j; break; } }
    }
    if (end === -1) { i = start + 1; continue; }
    const inner = str.slice(start + 1, end);
    const dm = inner.match(/^(\d+)m=(.+)$/s);
    if (dm) distParts.push({ dist: parseInt(dm[1]), pattern: dm[2] });
    toRemove.push([start, end + 1]);
    i = end + 1;
  }
  let main = '', pos = 0;
  for (const [s, e] of toRemove) { main += str.slice(pos, s); pos = e; }
  main += str.slice(pos);
  return { main: main.trim(), distParts };
}

// "数値[(...R)]" or "数値[(...R)]→数値[(...R)]→..." (3段階以上も対応) → {mainValue, raceMap}
function parseMainPattern(str) {
  const parts = str.split('→');
  if (parts.length === 1) {
    const r = parseValueWithRaces(parts[0]);
    if (!r) return null;
    const raceMap = r.races
      ? Object.fromEntries(r.races.map(n => [String(n), r.value]))
      : null;
    return { mainValue: r.value, raceMap };
  }
  // 2段階以上: 各パートをすべて処理してraceMapに積む
  const raceMap = {};
  let lastValue = null;
  for (const part of parts) {
    const r = parseValueWithRaces(part.trim());
    if (!r) return null;
    if (r.races) r.races.forEach(n => { raceMap[String(n)] = r.value; });
    lastValue = r.value;
  }
  return { mainValue: lastValue, raceMap: Object.keys(raceMap).length > 0 ? raceMap : null };
}

// 芝/ダート行をパース
function parseSurfaceLine(line) {
  let s = normalizeStr(line);
  let surface;
  if (s.startsWith('芝'))       { surface = '芝';    s = s.slice(1); }
  else if (s.startsWith('ダート')) { surface = 'ダート'; s = s.slice(3); }
  else return null;

  const { main, distParts } = extractDistanceParts(s);
  const mainResult = parseMainPattern(main);
  if (!mainResult) return null;

  const parsedDists = distParts
    .map(dp => { const mr = parseMainPattern(dp.pattern); return mr ? { dist: dp.dist, ...mr } : null; })
    .filter(Boolean);

  return { surface, mainResult, distParts: parsedDists };
}

function dateToSlash(d8) {
  return `${d8.slice(0, 4)}/${d8.slice(4, 6)}/${d8.slice(6, 8)}`;
}

const VENUES = ['東京', '中山', '阪神', '京都', '中京', '小倉', '函館', '福島', '新潟', '札幌'];

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/parse_baba_input.js input.txt');
    process.exit(1);
  }

  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const patches = [];
  let currentDate = null;
  let currentVenue = null;
  let currentEntry = null;

  function flushEntry() {
    if (currentEntry) { patches.push(currentEntry); currentEntry = null; }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 日付行
    if (/^\d{8}$/.test(line)) {
      flushEntry();
      currentDate = line;
      currentVenue = null;
      continue;
    }

    // 競馬場行
    if (VENUES.includes(line)) {
      if (currentVenue !== line) {
        flushEntry();
        currentVenue = line;
      }
      continue;
    }

    if (!currentDate || !currentVenue) continue;

    const normalized = normalizeStr(line);
    if (!normalized.startsWith('芝') && !normalized.startsWith('ダート')) continue;

    const parsed = parseSurfaceLine(line);
    if (!parsed) {
      process.stderr.write(`Parse failed: ${line}\n`);
      continue;
    }

    if (!currentEntry) {
      currentEntry = { 日付: dateToSlash(currentDate), 競馬場: currentVenue };
    }

    const { surface, mainResult, distParts } = parsed;

    // メイン馬場差（最終値）
    if (surface === '芝') {
      currentEntry['芝馬場差'] = mainResult.mainValue;
    } else {
      currentEntry['ダート馬場差'] = mainResult.mainValue;
    }

    // メイン変動ありならレース別馬場差に記録
    if (mainResult.raceMap) {
      if (!currentEntry['レース別馬場差']) currentEntry['レース別馬場差'] = {};
      currentEntry['レース別馬場差'][surface] = mainResult.raceMap;
    }

    // 距離別馬場差
    for (const dp of distParts) {
      const distKey = surface === '芝' ? '芝距離別馬場差' : 'ダート距離別馬場差';
      if (!currentEntry[distKey]) currentEntry[distKey] = {};
      currentEntry[distKey][String(dp.dist)] = dp.mainValue;

      // 距離別変動ありならレース別馬場差に記録
      if (dp.raceMap) {
        if (!currentEntry['レース別馬場差']) currentEntry['レース別馬場差'] = {};
        currentEntry['レース別馬場差'][`${surface}_${dp.dist}`] = dp.raceMap;
      }
    }
  }

  flushEntry();
  console.log(JSON.stringify(patches, null, 2));
}

main();
