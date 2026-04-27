#!/usr/bin/env node
// scripts/pedigree.js - 血統表・クロス表示ツール
// Usage: node scripts/pedigree.js <horse_name> [--gen=7] [--table]

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  database: process.env.PGDATABASE || 'mykeibadb',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  port:     parseInt(process.env.PGPORT || '5432'),
});

const MOSHOKU = {
  '00': '', '01': '栗毛', '02': '栃栗毛', '03': '鹿毛', '04': '黒鹿毛',
  '05': '青鹿毛', '06': '青毛', '07': '芦毛', '08': '栗粕毛',
  '09': '鹿粕毛', '10': '青粕毛', '11': '白毛',
};

const SEIBETSU = { '1': '牡', '2': '牝', '3': 'セン' };

// ──────── DB ────────

async function dbQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    client.release();
  }
}

async function findBaseHorse(bamei) {
  const rows = await dbQuery(
    `SELECT bamei, seinengappi,
            ketto1_hanshoku_toroku_bango, ketto2_hanshoku_toroku_bango
     FROM kyosoba_master2 WHERE bamei = $1
     ORDER BY seinengappi DESC LIMIT 1`,
    [bamei]
  );
  return rows[0] || null;
}

async function batchFetch(bangos) {
  const uniq = [...new Set(bangos.filter(Boolean).map(b => b.trim()))];
  if (!uniq.length) return {};
  const ph = uniq.map((_, i) => `$${i + 1}`).join(',');
  const rows = await dbQuery(
    `SELECT hanshoku_toroku_bango, bamei, seibetsu_code, moshoku_code, seinen,
            chichi_hanshoku_toroku_bango, haha_hanshoku_toroku_bango
     FROM hanshokuba_master2 WHERE hanshoku_toroku_bango IN (${ph})`,
    uniq
  );
  const map = {};
  for (const r of rows) {
    const bango = r.hanshoku_toroku_bango.trim();
    map[bango] = {
      bango,
      name:      (r.bamei || '').trim(),
      sex:       SEIBETSU[(r.seibetsu_code || '').trim()] || '',
      color:     MOSHOKU[(r.moshoku_code  || '').trim()] || '',
      year:      (r.seinen || '').trim(),
      sireBango: (r.chichi_hanshoku_toroku_bango || '').trim(),
      damBango:  (r.haha_hanshoku_toroku_bango  || '').trim(),
    };
  }
  return map;
}

// ──────── Pedigree tree builder ────────
// path: 'S' = 父, 'D' = 母, 'SS' = 父父, 'SD' = 父母 … etc.

async function buildPedigree(sireBango, damBango, maxGen) {
  const nodeMap = {};
  let pending = [];
  if (sireBango) pending.push({ bango: sireBango.trim(), path: 'S' });
  if (damBango)  pending.push({ bango: damBango.trim(),  path: 'D' });

  for (let gen = 1; gen <= maxGen && pending.length; gen++) {
    const fetched = await batchFetch(pending.map(p => p.bango));
    const nextPending = [];

    for (const { bango, path } of pending) {
      const data = fetched[bango] || null;
      nodeMap[path] = data;

      if (data && gen < maxGen) {
        if (data.sireBango) nextPending.push({ bango: data.sireBango, path: path + 'S' });
        if (data.damBango)  nextPending.push({ bango: data.damBango,  path: path + 'D' });
      }
    }
    pending = nextPending;
  }
  return nodeMap;
}

// ──────── Tree display ────────

function nodeLabel(node) {
  if (!node) return '(不明)';
  const attrs = [node.sex, node.color, node.year].filter(Boolean).join(' ');
  return node.name + (attrs ? `（${attrs}）` : '');
}

function printNode(nodeMap, path, prefix, isLast, maxGen) {
  const node   = nodeMap[path];
  const isSire = path.endsWith('S');
  const role   = isSire ? '父' : '母';
  const conn   = isLast ? '└─' : '├─';

  console.log(`${prefix}${conn}${role}: ${nodeLabel(node)}`);

  if (node && path.length < maxGen) {
    const childPfx = prefix + (isLast ? '    ' : '│   ');
    printNode(nodeMap, path + 'S', childPfx, false, maxGen);
    printNode(nodeMap, path + 'D', childPfx, true,  maxGen);
  }
}

function printTreeView(horseName, nodeMap, maxGen) {
  const line = '═'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${horseName}  血統表（${maxGen}世代）`);
  console.log(line);
  printNode(nodeMap, 'S', '', false, maxGen);
  printNode(nodeMap, 'D', '', true,  maxGen);
}

// ──────── Table display ────────

// 世代見出し（最大7世代）
const TABLE_HEADERS = ['父/母', '祖父母', '曾祖父母', '4代祖', '5代祖', '6代祖', '7代祖'];
// 各列の表示幅（半角文字数）
const TABLE_COL_WIDTHS = [16, 15, 15, 13, 13, 11, 11];

function truncateToWidth(str, maxW) {
  if (!str) return '';
  let w = 0, result = '';
  for (const ch of str) {
    const cw = ch.codePointAt(0) > 0xFF ? 2 : 1;
    if (w + cw > maxW) { result += '…'; break; }
    result += ch;
    w += cw;
  }
  return result;
}

function padToWidth(str, targetW) {
  return str + ' '.repeat(Math.max(0, targetW - displayWidth(str)));
}

// path中のSをi番目として0始まりのインデックスを返す
function pathToIndex(path) {
  let idx = 0;
  for (const ch of path) idx = idx * 2 + (ch === 'D' ? 1 : 0);
  return idx;
}

function printTableView(horseName, nodeMap, maxGen) {
  // gen g の祖先数 = 2^g、gen g の各ブロックが占める行数 = totalRows / 2^g
  // totalRows = 2^maxGen（最深世代が1行ずつ占める）
  const totalRows = Math.pow(2, maxGen);
  const colWidths = TABLE_COL_WIDTHS.slice(0, maxGen);
  const totalWidth = colWidths.reduce((a, b) => a + b + 1, 0);

  // grid[row][col] = 表示文字列
  const grid = Array.from({ length: totalRows }, () => Array(maxGen).fill(''));

  function place(path) {
    const gen = path.length;           // 1 〜 maxGen
    const col = gen - 1;
    const node = nodeMap[path];
    const blockSize = totalRows / Math.pow(2, gen);  // この祖先が占める行数
    const startRow  = pathToIndex(path) * blockSize;
    const centerRow = Math.floor(startRow + (blockSize - 1) / 2);

    if (node) {
      grid[centerRow][col] = truncateToWidth(node.name, colWidths[col]);
    }
    if (gen < maxGen) {
      place(path + 'S');
      place(path + 'D');
    }
  }

  place('S');
  place('D');

  // ── ヘッダ出力 ──
  const headerLine = '═'.repeat(totalWidth + 2);
  console.log(`\n${headerLine}`);
  console.log(`  ${horseName}  血統表（${maxGen}世代・テーブル）`);
  console.log(headerLine);

  let headerRow = '  ';
  for (let c = 0; c < maxGen; c++) {
    headerRow += padToWidth(TABLE_HEADERS[c], colWidths[c]) + ' ';
  }
  console.log(headerRow);
  console.log('  ' + '─'.repeat(totalWidth));

  // ── 行出力 ──
  // 父半と母半の境界（行 totalRows/2 の手前に区切り線）
  const midRow = totalRows / 2;

  for (let row = 0; row < totalRows; row++) {
    if (row === midRow) {
      console.log('  ' + '· '.repeat(Math.floor(totalWidth / 2)));
    }
    const cells = grid[row];
    // 全セル空行はスキップ
    if (cells.every(c => !c)) continue;

    let line = '  ';
    for (let c = 0; c < maxGen; c++) {
      line += padToWidth(cells[c], colWidths[c]) + ' ';
    }
    console.log(line);
  }
}

// ──────── Cross calculation ────────

function calculateCrosses(nodeMap) {
  // bango → { name, entries:[{gen,side}] }
  const byBango = new Map();

  for (const [path, node] of Object.entries(nodeMap)) {
    if (!node) continue;
    const gen  = path.length;         // 1='S'|'D', 2='SS'|'SD'|'DS'|'DD' …
    const side = path[0];             // 'S' or 'D'
    const key  = node.bango;

    if (!byBango.has(key)) byBango.set(key, { name: node.name, entries: [] });
    byBango.get(key).entries.push({ gen, side });
  }

  const crosses = [];
  for (const { name, entries } of byBango.values()) {
    if (entries.length < 2) continue;

    const sides = new Set(entries.map(e => e.side));
    const pct   = entries.reduce((sum, e) => sum + 100 / Math.pow(2, e.gen), 0);
    const gens  = entries.map(e => e.gen).sort((a, b) => a - b);
    // note: '両' = 父系・母系またがり, '父' = 父系内のみ, '母' = 母系内のみ
    const kind  = sides.size > 1 ? '両' : (sides.has('S') ? '父' : '母');
    crosses.push({ name, pct, gens, kind });
  }

  crosses.sort((a, b) => b.pct - a.pct || a.gens[0] - b.gens[0]);
  return crosses;
}

function displayWidth(str) {
  let w = 0;
  for (const ch of str) w += ch.codePointAt(0) > 0xFF ? 2 : 1;
  return w;
}

function printCrosses(crosses, maxGen) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  クロス（${maxGen}世代）`);
  console.log(line);

  if (!crosses.length) {
    console.log('  クロスなし');
    return;
  }

  const nameW = Math.max(...crosses.map(c => displayWidth(c.name)));

  for (const { name, pct, gens, kind } of crosses) {
    const pad    = ' '.repeat(nameW - displayWidth(name) + 2);
    const pctStr = pct.toFixed(2) + '%';
    const note   = kind === '父' ? ' (父系内)' : kind === '母' ? ' (母系内)' : '';
    console.log(`  ${name}${pad}${pctStr.padStart(8)}    ${gens.join(' x ')}${note}`);
  }
}

// ──────── Main ────────

async function main() {
  const args      = process.argv.slice(2);
  const horseName = args.find(a => !a.startsWith('-'));
  const maxGen    = parseInt((args.find(a => a.startsWith('--gen=')) || '--gen=7').split('=')[1]);
  const tableMode = args.includes('--table');

  if (!horseName) {
    console.error('Usage: node scripts/pedigree.js <horse_name> [--gen=7] [--table]');
    process.exit(1);
  }

  const base = await findBaseHorse(horseName);
  if (!base) {
    console.error(`馬が見つかりません: ${horseName}`);
    await pool.end();
    process.exit(1);
  }

  const sireBango = (base.ketto1_hanshoku_toroku_bango || '').trim();
  const damBango  = (base.ketto2_hanshoku_toroku_bango || '').trim();

  const nodeMap = await buildPedigree(sireBango, damBango, maxGen);

  if (tableMode) {
    printTableView(base.bamei, nodeMap, maxGen);
  } else {
    printTreeView(base.bamei, nodeMap, maxGen);
  }
  printCrosses(calculateCrosses(nodeMap), maxGen);

  await pool.end();
}

main().catch(async err => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
