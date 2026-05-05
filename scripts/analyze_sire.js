#!/usr/bin/env node
// scripts/analyze_sire.js
// 種牡馬別インブリード配合分析
//
// Usage:
//   node scripts/analyze_sire.js
//   node scripts/analyze_sire.js --sire=サトノダイヤモンド --sex=牡 --gen=9 --top=100

'use strict';

const { Pool } = require('pg');

// ─── DB接続 ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  host:     process.env.PGHOST     || '192.168.0.55',
  database: process.env.PGDATABASE || 'mykeibadb',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  port:     parseInt(process.env.PGPORT || '5432'),
});

async function dbQuery(sql, params = []) {
  const c = await pool.connect();
  try { return (await c.query(sql, params)).rows; }
  finally { c.release(); }
}

// ─── 引数解析 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(key, def) {
  const a = args.find(a => a.startsWith(`--${key}=`));
  return a ? a.split('=')[1] : def;
}

const SIRE_NAME    = getArg('sire',   'サトノダイヤモンド');
const SEX_FILTER   = getArg('sex',    '牡');     // 牡 | 牝 | 両
const MAX_GEN      = parseInt(getArg('gen',    '9'));
const TOP_FEATURES = parseInt(getArg('top',    '100'));
const LAMBDA       = parseFloat(getArg('lambda', '0.1'));
// 出現率フィルタ:
// --min-freq: 最低この割合以上出現したもののみ採用（デフォルト: 5%）
// --max-freq: この割合以上は除外 (デフォルト: 1.0 = 除外なし)
//   ※ 特徴量が血量%(連続値)のため、全馬共通の祖先でも
//      血量の多寡で差別化できるため上限フィルタは不要
const MIN_FREQ_RATIO = parseFloat(getArg('min-freq', '0.05'));
const MAX_FREQ_RATIO = parseFloat(getArg('max-freq', '1.0'));
const TRAIN_RATIO  = parseFloat(getArg('train',  '0.8'));
const SEED         = parseInt(getArg('seed',   '42'));
// 未出走産駒評価:
// --birth-year: 対象生年 (デフォルト: 今年-2 = 現在の2歳世代)
// --eval-sex:   評価対象の性別 (デフォルト: --sex と同じ)
const BIRTH_YEAR   = getArg('birth-year', String(new Date().getFullYear() - 2));
const EVAL_SEX     = getArg('eval-sex',   SEX_FILTER);

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function sigmoid(z) {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

// シード付き乱数 (LCG)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── 産駒取得 ─────────────────────────────────────────────────────────────────

async function getOffspring(sireName, sexFilter) {
  const sexCond = sexFilter === '牡' ? "AND TRIM(k.seibetsu_code) = '1'"
               : sexFilter === '牝' ? "AND TRIM(k.seibetsu_code) = '2'"
               : '';
  return await dbQuery(`
    SELECT
      TRIM(k.bamei)                         AS name,
      TRIM(k.ketto_toroku_bango)            AS ketto_bango,
      TRIM(k.ketto1_hanshoku_toroku_bango)  AS sire_bango,
      TRIM(k.ketto2_hanshoku_toroku_bango)  AS dam_bango,
      COALESCE(TRIM(k.ketto2_bamei), '')    AS dam_name,
      TRIM(k.seisansha_code)               AS seisansha_code,
      COUNT(*)                              AS starts,
      SUM(CASE WHEN TRIM(u.kakutei_chakujun)::int = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(TRIM(u.kakutoku_honshokin)::bigint) / 10000.0 AS prize_man
    FROM kyosoba_master2 k
    JOIN hanshokuba_master2 chichi
      ON TRIM(k.ketto1_hanshoku_toroku_bango) = TRIM(chichi.hanshoku_toroku_bango)
    JOIN umagoto_race_joho u
      ON TRIM(k.ketto_toroku_bango) = TRIM(u.ketto_toroku_bango)
    JOIN race_shosai r ON u.race_code = r.race_code
    WHERE TRIM(chichi.bamei) = $1
      ${sexCond}
      AND TRIM(r.keibajo_code) BETWEEN '01' AND '10'
      AND TRIM(r.track_code)::int BETWEEN 10 AND 29
      AND TRIM(u.kakutei_chakujun) ~ '^[0-9]+$'
      AND TRIM(u.kakutei_chakujun)::int BETWEEN 1 AND 28
    GROUP BY
      TRIM(k.bamei), TRIM(k.ketto_toroku_bango),
      TRIM(k.ketto1_hanshoku_toroku_bango), TRIM(k.ketto2_hanshoku_toroku_bango),
      COALESCE(TRIM(k.ketto2_bamei), ''), TRIM(k.seisansha_code)
  `, [sireName]);
}

// ─── 未出走産駒取得 ───────────────────────────────────────────────────────────

async function getUnracedOffspring(sireName, sexFilter, birthYear) {
  const sexCond = sexFilter === '牡' ? "AND TRIM(s.seibetsu_code) = '1'"
               : sexFilter === '牝' ? "AND TRIM(s.seibetsu_code) = '2'"
               : '';
  const yearCond = birthYear ? `AND LEFT(TRIM(s.seinengappi), 4) = '${birthYear}'` : '';
  // sanku_master2 を基にする（名前未登録馬も含む）
  // kyosoba_master2 に登録済みなら正式馬名を使用、未登録なら母名+'のYY'で識別
  const rows = await dbQuery(`
    SELECT
      TRIM(s.ketto_toroku_bango)              AS ketto_bango,
      TRIM(s.ketto1_hanshoku_toroku_bango)    AS sire_bango,
      TRIM(s.ketto2_hanshoku_toroku_bango)    AS dam_bango,
      COALESCE(TRIM(haha.bamei), '')          AS dam_name,
      TRIM(s.seinengappi)                     AS birth_date,
      CASE TRIM(s.seibetsu_code)
        WHEN '1' THEN '牡' WHEN '2' THEN '牝' WHEN '3' THEN 'セ' ELSE '' END AS sex,
      COALESCE(TRIM(k.bamei), '')             AS registered_name,
      TRIM(s.seisansha_code)                               AS seisansha_code,
      COALESCE(TRIM(sm.seisanshamei_hojinkaku_nashi), '-') AS breeder,
      COALESCE(TRIM(k.chokyoshimei_ryakusho), '-')         AS trainer,
      COALESCE(TRIM(k.banushimei_hojinkaku_nashi), '-')    AS owner
    FROM sanku_master2 s
    JOIN hanshokuba_master2 chichi
      ON TRIM(s.ketto1_hanshoku_toroku_bango) = TRIM(chichi.hanshoku_toroku_bango)
    LEFT JOIN hanshokuba_master2 haha
      ON TRIM(s.ketto2_hanshoku_toroku_bango) = TRIM(haha.hanshoku_toroku_bango)
    LEFT JOIN kyosoba_master2 k
      ON TRIM(k.ketto_toroku_bango) = TRIM(s.ketto_toroku_bango)
    LEFT JOIN seisansha_master2 sm
      ON TRIM(s.seisansha_code) = TRIM(sm.seisansha_code)
    WHERE TRIM(chichi.bamei) = $1
      ${sexCond}
      ${yearCond}
      AND NOT EXISTS (
        SELECT 1 FROM umagoto_race_joho u
        WHERE TRIM(u.ketto_toroku_bango) = TRIM(s.ketto_toroku_bango)
      )
    ORDER BY s.seinengappi, haha.bamei
  `, [sireName]);

  // 馬名: 登録済みなら正式名、未登録なら「母名のYY」
  const yearShort = birthYear ? birthYear.slice(2) : '??';
  for (const r of rows) {
    r.name = r.registered_name || `${r.dam_name || r.ketto_bango}の${yearShort}`;
  }
  return rows;
}

// ─── 生産者別JRA通算勝率（全種牡馬横断） ─────────────────────────────────────
// 繁殖牝馬の質の代理変数として使用。全種牡馬の産駒を使うことで
// 特定の種牡馬内の偏りではなく、牧場全体の繁殖能力を測る

async function getBreeederWinRates() {
  const rows = await dbQuery(`
    SELECT
      TRIM(k.seisansha_code) AS code,
      COUNT(*)               AS starts,
      SUM(CASE WHEN TRIM(u.kakutei_chakujun)::int = 1 THEN 1 ELSE 0 END) AS wins
    FROM kyosoba_master2 k
    JOIN umagoto_race_joho u ON TRIM(k.ketto_toroku_bango) = TRIM(u.ketto_toroku_bango)
    JOIN race_shosai r       ON u.race_code = r.race_code
    WHERE TRIM(r.keibajo_code) BETWEEN '01' AND '10'
      AND TRIM(r.track_code)::int BETWEEN 10 AND 29
      AND TRIM(u.kakutei_chakujun) ~ '^[0-9]+$'
      AND TRIM(u.kakutei_chakujun)::int BETWEEN 1 AND 28
    GROUP BY TRIM(k.seisansha_code)
    HAVING COUNT(*) >= 20
  `);

  let totalWins = 0, totalStarts = 0;
  const map = {};
  for (const r of rows) {
    const s = parseInt(r.starts), w = parseInt(r.wins);
    map[r.code] = w / s;
    totalWins += w; totalStarts += s;
  }
  const globalRate = totalStarts > 0 ? totalWins / totalStarts : 0.5;
  return { map, globalRate };
}

// ─── 全きょうだい除去: 同じ母の産駒は最優秀1頭のみ ──────────────────────────

function deduplicateFullSiblings(horses) {
  const byDam = {};
  for (const h of horses) {
    const key = h.dam_name || `__unknown_${h.ketto_bango}`;
    if (!byDam[key]) byDam[key] = [];
    byDam[key].push(h);
  }

  const result = [];
  const excluded = [];
  for (const siblings of Object.values(byDam)) {
    if (siblings.length === 1) {
      result.push(siblings[0]);
    } else {
      siblings.sort((a, b) =>
        parseInt(b.wins) - parseInt(a.wins) || parseFloat(b.prize_man) - parseFloat(a.prize_man)
      );
      result.push(siblings[0]);
      excluded.push(...siblings.slice(1).map(s => `${s.name}(母:${siblings[0].dam_name || '不明'})`));
    }
  }
  if (excluded.length) {
    process.stderr.write(`  全きょうだい除外 ${excluded.length}頭: ${excluded.join(', ')}\n`);
  }
  return result;
}

// ─── 血統バッチフェッチ (チャンク処理) ───────────────────────────────────────

async function batchFetch(bangos) {
  const uniq = [...new Set(bangos.filter(Boolean))];
  if (!uniq.length) return {};

  const CHUNK = 500;
  const map = {};
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const ph    = chunk.map((_, idx) => `$${idx + 1}`).join(',');
    const rows  = await dbQuery(
      `SELECT hanshoku_toroku_bango, bamei,
              chichi_hanshoku_toroku_bango, haha_hanshoku_toroku_bango
       FROM hanshokuba_master2
       WHERE hanshoku_toroku_bango IN (${ph})`,
      chunk
    );
    for (const r of rows) {
      const bango = r.hanshoku_toroku_bango.trim();
      map[bango] = {
        name:      (r.bamei || '').trim(),
        sireBango: (r.chichi_hanshoku_toroku_bango || '').trim(),
        damBango:  (r.haha_hanshoku_toroku_bango  || '').trim(),
      };
    }
  }
  return map;
}

// ─── 全産駒の N代血統を一括BFS構築 ──────────────────────────────────────────
// 戻り値: { [horseName]: { [bango]: { name, paths: [path, ...] } } }
//   path: 'S' = 父, 'D' = 母, 'SS' = 父父, 'SD' = 父母, ...

async function buildAllPedigrees(horses, maxGen) {
  const result = {};
  for (const h of horses) result[h.name] = {};

  let frontier = [];
  for (const h of horses) {
    if (h.sire_bango) frontier.push({ horse: h.name, bango: h.sire_bango, path: 'S' });
    if (h.dam_bango)  frontier.push({ horse: h.name, bango: h.dam_bango,  path: 'D' });
  }

  for (let gen = 1; gen <= maxGen && frontier.length; gen++) {
    const uniqueBangos = [...new Set(frontier.map(f => f.bango))];
    process.stderr.write(`  gen${gen}: ${uniqueBangos.length}祖先 (ノード${frontier.length})\n`);

    const fetched = await batchFetch(uniqueBangos);
    const next    = [];

    for (const { horse, bango, path } of frontier) {
      const data = fetched[bango];
      if (!data) continue;

      const rec = result[horse];
      if (!rec[bango]) rec[bango] = { name: data.name, paths: [] };
      rec[bango].paths.push(path);

      if (gen < maxGen) {
        if (data.sireBango) next.push({ horse, bango: data.sireBango, path: path + 'S' });
        if (data.damBango)  next.push({ horse, bango: data.damBango,  path: path + 'D' });
      }
    }
    frontier = next;
  }
  return result;
}

// ─── インブリード検出: 同一祖先が2パス以上 ───────────────────────────────────

function detectInbreeds(ancestorMap) {
  const result = {};
  for (const [bango, data] of Object.entries(ancestorMap)) {
    if (data.paths.length < 2) continue;
    // 血量: Σ (100 / 2^depth)
    const pct = data.paths.reduce((s, p) => s + 100 / Math.pow(2, p.length), 0);
    const depths = data.paths.map(p => p.length).sort((a, b) => a - b);
    result[bango] = { name: data.name, pct, depths, cross: depths.join('x') };
  }
  return result;
}

// ─── ロジスティック回帰 (L2正則化, 勾配降下法) ───────────────────────────────

function logisticRegression(X, y, lambda = 0.1, lr = 0.05, epochs = 3000) {
  const n = X.length, d = X[0].length;
  const w = new Float64Array(d);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      const z   = X[i].reduce((s, x, j) => s + x * w[j], 0);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (grad[j] / n + lambda * w[j]);
    }
    if ((epoch + 1) % 1000 === 0) lr *= 0.5;
  }
  return Array.from(w);
}

// ─── メイン ──────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`\n=== 種牡馬インブリード配合分析: ${SIRE_NAME} (${SEX_FILTER}) ${MAX_GEN}代 ===\n`);

  // ── Step 1: 産駒取得 + 生産者勝率テーブル取得 ──
  process.stderr.write('\n[1] 産駒取得...\n');
  const [rawHorses, { map: breeederWinMap, globalRate: breeederGlobalRate }] =
    await Promise.all([getOffspring(SIRE_NAME, SEX_FILTER), getBreeederWinRates()]);
  process.stderr.write(`  生産者勝率テーブル: ${Object.keys(breeederWinMap).length}牧場 (全体平均 ${(breeederGlobalRate * 100).toFixed(2)}%)\n`);
  process.stderr.write(`  取得: ${rawHorses.length}頭\n`);

  const horses = deduplicateFullSiblings(rawHorses);
  const winnerCount = horses.filter(h => parseInt(h.wins) >= 1).length;
  process.stderr.write(`  除外後: ${horses.length}頭 / 勝ち馬 ${winnerCount}頭 (${(winnerCount/horses.length*100).toFixed(1)}%) 未勝利 ${horses.length - winnerCount}頭\n`);

  // ── Step 2: N代血統構築 ──
  process.stderr.write(`\n[2] ${MAX_GEN}代血統一括構築...\n`);
  const allPedigrees = await buildAllPedigrees(horses, MAX_GEN);

  // ── Step 3: インブリード検出 + 頻度集計 ──
  process.stderr.write('\n[3] インブリード検出...\n');
  const horseInbreeds = {};
  const inbreedFreq   = {};

  for (const h of horses) {
    const ibs = detectInbreeds(allPedigrees[h.name] || {});
    horseInbreeds[h.name] = ibs;
    for (const [bango, info] of Object.entries(ibs)) {
      if (!inbreedFreq[bango]) inbreedFreq[bango] = { name: info.name, freq: 0 };
      inbreedFreq[bango].freq++;
    }
  }

  const minFreq = Math.ceil(horses.length * MIN_FREQ_RATIO);
  const maxFreq = Math.floor(horses.length * MAX_FREQ_RATIO);

  // ロジスティック回帰用特徴量: 頻度フィルタ後 上位 TOP_FEATURES
  const topFeatures = Object.entries(inbreedFreq)
    .filter(([, d]) => d.freq >= minFreq && d.freq <= maxFreq)
    .sort((a, b) => b[1].freq - a[1].freq)
    .slice(0, TOP_FEATURES);

  const excludedHigh = Object.values(inbreedFreq).filter(d => d.freq > maxFreq).length;
  const excludedLow  = Object.values(inbreedFreq).filter(d => d.freq < minFreq).length;
  process.stderr.write(`  インブリード種: ${Object.keys(inbreedFreq).length}\n`);
  if (excludedHigh) process.stderr.write(`  除外(>=${(MAX_FREQ_RATIO*100).toFixed(0)}%固定): ${excludedHigh}種\n`);
  process.stderr.write(`  除外(<${(MIN_FREQ_RATIO*100).toFixed(0)}%): ${excludedLow}種\n`);
  process.stderr.write(`  採用: ${topFeatures.length}種\n`);

  // ── Step 4: グループ比較分析 ──
  // 勝ち馬 vs 未勝利 でインブリード保有率を比較
  // 特徴量は血量%(連続値)を使用。全馬共通の祖先でも
  // 母方に追加クロスがあれば血量が多くなり差別化できる
  process.stderr.write('\n[4] グループ比較分析...\n');
  const winGroup  = horses.filter(h => parseInt(h.wins) >= 1);
  const loseGroup = horses.filter(h => parseInt(h.wins) === 0);
  const wN = winGroup.length, lN = loseGroup.length;

  // min-freq以上の全祖先について比較（上限フィルタなし）
  const groupCompare = Object.entries(inbreedFreq)
    .filter(([, d]) => d.freq >= minFreq)
    .map(([bango, d]) => {
      const totalRate = d.freq / horses.length;
      const winCount  = winGroup.filter(h  => horseInbreeds[h.name][bango]).length;
      const loseCount = loseGroup.filter(h => horseInbreeds[h.name][bango]).length;
      const winRate   = wN  > 0 ? winCount  / wN  : 0;
      const loseRate  = lN  > 0 ? loseCount / lN  : 0;
      const deviation = winRate - totalRate;

      // 平均血量（保有馬のみ）
      const allPcts    = horses.map(h => horseInbreeds[h.name][bango]?.pct || 0);
      const winPcts    = winGroup.map(h  => horseInbreeds[h.name][bango]?.pct || 0);
      const losePcts   = loseGroup.map(h => horseInbreeds[h.name][bango]?.pct || 0);
      const avgPct     = allPcts.reduce((a, c) => a + c, 0) / horses.length;
      const avgWinPct  = winPcts.reduce((a, c) => a + c, 0) / wN;
      const avgLosePct = losePcts.reduce((a, c) => a + c, 0) / lN;

      return {
        bango, name: d.name, freq: d.freq, totalRate, winRate, loseRate, deviation,
        avgPct, avgWinPct, avgLosePct, pctDeviation: avgWinPct - avgPct,
      };
    })
    .sort((a, b) => b.deviation - a.deviation);

  // ── Step 5: 特徴量行列 & 目的変数 (血量%を特徴量に使用) ──
  process.stderr.write('\n[5] 特徴量行列構築（血量% + 生産者勝率補正）...\n');
  const featureBangos = topFeatures.map(([b]) => b);

  // 血量%を正規化（特徴量ごとに標準化）してから回帰
  const featureStats = featureBangos.map(b => {
    const vals = horses.map(h => horseInbreeds[h.name][b]?.pct || 0);
    const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
    const std  = Math.sqrt(vals.reduce((a, c) => a + (c - mean) ** 2, 0) / vals.length);
    return { mean, std };
  });

  // 生産者勝率を共変量として追加（繁殖牝馬の質による交絡を除去）
  // 各馬の生産者の全種牡馬横断JRA勝率を使用。不明牧場はグローバル平均で補完
  const breeederRates = horses.map(h => breeederWinMap[h.seisansha_code] ?? breeederGlobalRate);
  const breeederMean  = breeederRates.reduce((a, c) => a + c, 0) / breeederRates.length;
  const breeederStd   = Math.sqrt(breeederRates.reduce((a, c) => a + (c - breeederMean) ** 2, 0) / breeederRates.length);
  // インブリード特徴量 + 生産者勝率（末尾1列）を結合
  const X = horses.map((h, i) => {
    const ibFeatures = featureBangos.map((b, j) => {
      const val = horseInbreeds[h.name][b]?.pct || 0;
      const { mean, std } = featureStats[j];
      return std > 0 ? (val - mean) / std : 0;
    });
    const breeederFeat = breeederStd > 0 ? (breeederRates[i] - breeederMean) / breeederStd : 0;
    return [...ibFeatures, breeederFeat];
  });
  const y = horses.map(h => parseInt(h.wins) >= 1 ? 1 : 0);
  process.stderr.write(`  生産者勝率: 平均 ${(breeederMean*100).toFixed(2)}% σ=${(breeederStd*100).toFixed(2)}%\n`);

  // ── Step 6: Train/Test 分割 ──
  process.stderr.write('\n[6] Train/Test 分割...\n');
  const rng     = makeRng(SEED);
  const indices = shuffle(horses.map((_, i) => i), rng);
  const trainN  = Math.floor(horses.length * TRAIN_RATIO);
  const trainIdx = new Set(indices.slice(0, trainN));
  const testIdx  = new Set(indices.slice(trainN));

  const X_train = [...trainIdx].map(i => X[i]);
  const y_train = [...trainIdx].map(i => y[i]);
  const X_test  = [...testIdx].map(i => X[i]);
  const y_test  = [...testIdx].map(i => y[i]);
  process.stderr.write(`  Train: ${X_train.length}頭 / Test: ${X_test.length}頭\n`);

  // ── Step 7: ロジスティック回帰 ──
  process.stderr.write(`\n[7] ロジスティック回帰 (λ=${LAMBDA})...\n`);
  const weights = logisticRegression(X_train, y_train, LAMBDA);

  let correct = 0;
  for (let i = 0; i < X_test.length; i++) {
    const z = X_test[i].reduce((s, x, j) => s + x * weights[j], 0);
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === y_test[i]) correct++;
  }
  const acc = X_test.length ? correct / X_test.length : 0;
  process.stderr.write(`  テスト精度: ${(acc * 100).toFixed(1)}%\n`);

  // ── Step 8: スコア算出 & 標準化 ──
  process.stderr.write('\n[8] 評価スコア算出...\n');
  const rawScores = horses.map((_, i) => X[i].reduce((s, x, j) => s + x * weights[j], 0));
  const mean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
  const std  = Math.sqrt(rawScores.reduce((s, v) => s + (v - mean) ** 2, 0) / rawScores.length);
  const scores = rawScores.map(v => std > 0 ? (v - mean) / std : 0);

  function classify(s) {
    if (s >  1) return 'A';
    if (s >= 0) return 'B';
    if (s >= -1) return 'C';
    return 'D';
  }

  // ─────────────────────────── 出力 ───────────────────────────────────────────
  const W = 110;
  console.log('\n' + '═'.repeat(W));
  console.log(`  種牡馬インブリード配合分析   ${SIRE_NAME} (${SEX_FILTER})  ${MAX_GEN}代  分析頭数: ${horses.length}頭`);
  console.log('═'.repeat(W));
  console.log(`  目的変数: 中央競馬平地 1勝以上   勝ち馬: ${winnerCount}頭 (${(winnerCount/horses.length*100).toFixed(1)}%) / 未勝利: ${horses.length - winnerCount}頭`);

  // ══ グループ比較分析 ══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(W));
  console.log(`  【グループ比較】  勝ち馬(${wN}頭) vs 未勝利(${lN}頭) インブリード保有率比較`);
  console.log(`  ※ 保有率差(勝ち馬率 - 全体率)で降順。血量差は勝ち馬平均血量 - 全体平均血量`);
  console.log('─'.repeat(W));
  console.log(
    `  ${'祖先名'.padEnd(24)} ${'全体%'.padStart(6)} ${'勝ち馬%'.padStart(7)} ${'未勝利%'.padStart(7)}` +
    `  ${'率差'.padStart(7)}  ${'全体血量'.padStart(8)} ${'勝ち馬血量'.padStart(10)} ${'血量差'.padStart(7)}` +
    `  ${'保有頭数'}`
  );
  console.log('  ' + '─'.repeat(W - 2));

  for (const gc of groupCompare.slice(0, 40)) {
    const dev    = gc.deviation;
    const pctDev = gc.pctDeviation;
    const devStr = (dev >= 0 ? '+' : '') + (dev * 100).toFixed(1) + '%';
    const pctStr = (pctDev >= 0 ? '+' : '') + pctDev.toFixed(2) + '%';
    // 方向マーカー: ++ 強正 / + 正 / - 負 / -- 強負
    const marker = dev > 0.10 ? '▲▲' : dev > 0.03 ? '▲ ' : dev < -0.10 ? '▼▼' : dev < -0.03 ? '▼ ' : '  ';
    console.log(
      `${marker} ${gc.name.padEnd(24)} ` +
      `${(gc.totalRate*100).toFixed(1).padStart(6)}% ` +
      `${(gc.winRate*100).toFixed(1).padStart(6)}% ` +
      `${(gc.loseRate*100).toFixed(1).padStart(6)}% ` +
      `  ${devStr.padStart(7)}  ` +
      `${gc.avgPct.toFixed(2).padStart(8)}% ` +
      `${gc.avgWinPct.toFixed(2).padStart(9)}% ` +
      `${pctStr.padStart(7)}  ` +
      `${gc.freq}頭`
    );
  }

  // ══ ロジスティック回帰: 係数ランキング ════════════════════════════════════════
  // weights の末尾1要素が生産者勝率の係数
  const breeederWeight    = weights[featureBangos.length];
  const weightedFeatures = featureBangos.map((b, j) => ({
    name:   inbreedFreq[b].name,
    freq:   inbreedFreq[b].freq,
    weight: weights[j],
  })).sort((a, b) => b.weight - a.weight);

  console.log('\n' + '─'.repeat(W));
  console.log(`  【回帰係数ランキング】  特徴量: 血量% (標準化後)  採用${topFeatures.length}種  L2 λ=${LAMBDA}  テスト精度: ${(acc*100).toFixed(1)}%`);
  console.log(`  ※ max-freq=${(MAX_FREQ_RATIO*100).toFixed(0)}% (${MAX_FREQ_RATIO >= 1.0 ? '上限除外なし' : '上限あり'})  min-freq=${(MIN_FREQ_RATIO*100).toFixed(0)}%`);
  const breeederBar = breeederWeight >= 0 ? '█'.repeat(Math.round(breeederWeight * 20)) : '▓'.repeat(Math.round(-breeederWeight * 20));
  console.log(`  ★ 繁殖牝馬品質補正 (生産者JRA通算勝率)  係数: ${breeederWeight.toFixed(4).padStart(8)}  ${breeederBar}`);
  console.log(`    → 係数が正 = 良質牧場産が勝ちやすい傾向を捕捉済み。インブリード係数はこの影響を除いた純粋効果`);
  console.log('─'.repeat(W));

  console.log('\n  プラス寄与 上位15:');
  console.log(`  ${'祖先名'.padEnd(22)} ${'頻度'.padStart(4)}頭  ${'係数'.padStart(8)}`);
  for (const f of weightedFeatures.slice(0, 15)) {
    const bar = '█'.repeat(Math.max(0, Math.round(f.weight * 20)));
    console.log(`  ${f.name.padEnd(22)} ${String(f.freq).padStart(4)}頭  ${f.weight.toFixed(4).padStart(8)}  ${bar}`);
  }

  console.log('\n  マイナス寄与 下位15:');
  console.log(`  ${'祖先名'.padEnd(22)} ${'頻度'.padStart(4)}頭  ${'係数'.padStart(8)}`);
  for (const f of [...weightedFeatures].reverse().slice(0, 15)) {
    const bar = '▓'.repeat(Math.max(0, Math.round(-f.weight * 20)));
    console.log(`  ${f.name.padEnd(22)} ${String(f.freq).padStart(4)}頭  ${f.weight.toFixed(4).padStart(8)}  ${bar}`);
  }

  // ══ 馬別評価スコア一覧 ════════════════════════════════════════════════════════
  const horseResults = horses.map((h, i) => ({
    name:   h.name,
    starts: parseInt(h.starts),
    wins:   parseInt(h.wins),
    prize:  Math.round(parseFloat(h.prize_man)),
    score:  scores[i],
    cls:    classify(scores[i]),
    isTest: testIdx.has(i),
    topIbs: Object.values(horseInbreeds[h.name])
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 4)
      .map(x => `${x.name}(${x.cross},${x.pct.toFixed(1)}%)`)
      .join(' '),
  })).sort((a, b) => b.score - a.score);

  console.log('\n' + '─'.repeat(W));
  console.log('  【馬別スコア】  (* = テストセット  ○ = 勝ち馬)  主なインブリード: 祖先名(クロス代,血量%)');
  console.log('─'.repeat(W));
  console.log(`  ${''.padEnd(1)} ${'順'.padStart(3)} ${'馬名'.padEnd(18)} ${'出走'.padStart(4)} ${'勝'.padStart(2)} ${'賞金(万)'.padStart(8)} ${'スコア'.padStart(7)}  ${'区分'}  ${'主なインブリード'}`);
  console.log('  ' + '─'.repeat(W - 2));

  for (let rank = 0; rank < horseResults.length; rank++) {
    const r = horseResults[rank];
    const t = r.isTest ? '*' : ' ';
    const w = r.wins >= 1 ? '○' : '  ';
    console.log(
      `  ${t} ${String(rank + 1).padStart(3)} ${r.name.padEnd(18)} ` +
      `${String(r.starts).padStart(4)} ${String(r.wins).padStart(2)} ` +
      `${String(r.prize).padStart(8)} ${r.score.toFixed(3).padStart(7)}  [${r.cls}]  ` +
      `${w} ${r.topIbs}`
    );
  }

  // ══ 区分別サマリ ══════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(W));
  console.log('  【区分別サマリ】');
  console.log('─'.repeat(W));
  const CLSLabels = { A: '>+1σ  ', B: '0〜+1σ', C: '-1〜0σ', D: '<-1σ  ' };
  for (const cls of ['A', 'B', 'C', 'D']) {
    const g     = horseResults.filter(r => r.cls === cls);
    if (!g.length) continue;
    const gWin  = g.filter(r => r.wins >= 1).length;
    const gRate = (gWin / g.length * 100).toFixed(1);
    const avgPrize  = (g.reduce((s, r) => s + r.prize, 0) / g.length).toFixed(0);
    const avgStarts = (g.reduce((s, r) => s + r.starts, 0) / g.length).toFixed(1);
    console.log(
      `  [${cls}] ${CLSLabels[cls]}  ${String(g.length).padStart(3)}頭  ` +
      `勝ち馬 ${String(gWin).padStart(2)}頭 (${gRate.padStart(5)}%)  ` +
      `平均賞金 ${String(avgPrize).padStart(5)}万  平均出走 ${avgStarts}走`
    );
  }

  console.log('\n  ※ カットオフ: A>+1σ / B:0〜+1σ / C:-1σ〜0 / D:<-1σ');
  console.log('  ※ 特徴量は血量%(連続値)を標準化して使用。全馬共通の祖先でも母方追加クロスで差別化可能。');
  console.log('  ※ 過去実績ベース分析。未来予測には限界あり。');

  // ══ 未出走産駒評価 ══════════════════════════════════════════════════════════════
  process.stderr.write(`\n[9] 未出走${BIRTH_YEAR}年生まれ産駒評価 (${EVAL_SEX})...\n`);
  const unracedHorses = await getUnracedOffspring(SIRE_NAME, EVAL_SEX, BIRTH_YEAR);
  process.stderr.write(`  未出走対象: ${unracedHorses.length}頭\n`);

  if (unracedHorses.length === 0) {
    console.log(`\n  【未出走${BIRTH_YEAR}年生まれ産駒】 該当馬なし\n`);
    return;
  }

  process.stderr.write(`\n[10] 未出走馬の${MAX_GEN}代血統構築...\n`);
  const unracedPedigrees = await buildAllPedigrees(unracedHorses, MAX_GEN);

  // インブリード検出
  const unracedInbreeds = {};
  for (const h of unracedHorses) {
    unracedInbreeds[h.name] = detectInbreeds(unracedPedigrees[h.name] || {});
  }

  // 特徴量ベクトル構築 → 同じ featureStats + 生産者補正 で正規化
  const unracedResults = unracedHorses.map(h => {
    const ibFeats = featureBangos.map((b, j) => {
      const val = unracedInbreeds[h.name][b]?.pct || 0;
      const { mean: fm, std: fs } = featureStats[j];
      return fs > 0 ? (val - fm) / fs : 0;
    });
    // 生産者補正: 同じ正規化パラメータ (breeederMean/Std) を使用
    const uRate = breeederWinMap[h.seisansha_code] ?? breeederGlobalRate;
    const breeederFeat = breeederStd > 0 ? (uRate - breeederMean) / breeederStd : 0;
    const Xh = [...ibFeats, breeederFeat];
    const rawScore = Xh.reduce((s, x, j) => s + x * weights[j], 0);
    // 既出走馬の分布 (mean/std) で正規化 → 同スケールのA/B/C/D判定
    const score = std > 0 ? (rawScore - mean) / std : 0;

    // グループ比較との照合: 保有インブリードのうち▲▲の祖先を強調
    const positiveIbs = Object.entries(unracedInbreeds[h.name])
      .map(([bango, ib]) => {
        const gc = groupCompare.find(g => g.bango === bango);
        return { ...ib, bango, deviation: gc ? gc.deviation : 0 };
      })
      .sort((a, b) => b.pct - a.pct);

    const topIbs = positiveIbs.slice(0, 5)
      .map(x => {
        const arrow = x.deviation > 0.10 ? '▲▲' : x.deviation > 0.03 ? '▲ ' : x.deviation < -0.10 ? '▼▼' : x.deviation < -0.03 ? '▼ ' : '  ';
        return `${arrow}${x.name}(${x.cross},${x.pct.toFixed(1)}%)`;
      }).join(' ');

    return {
      name: h.name,
      sex: h.sex,
      birthDate: h.birth_date,
      dam: h.dam_name,
      breeder: h.breeder,
      trainer: h.trainer,
      owner: h.owner,
      score,
      cls: classify(score),
      topIbs,
      ibCount: positiveIbs.length,
    };
  }).sort((a, b) => b.score - a.score);

  console.log('\n' + '═'.repeat(W));
  console.log(`  【未出走${BIRTH_YEAR}年生まれ産駒評価】  ${unracedHorses.length}頭  (${EVAL_SEX})  モデル: ${SIRE_NAME} 既出走産駒ベース`);
  console.log('═'.repeat(W));
  console.log(`  ▲▲=グループ比較で勝ち馬に+10%超多い祖先 / ▲=+3%超 / ▼▼=−10%超少ない / ▼=−3%超`);
  console.log('─'.repeat(W));
  console.log(
    `  ${'順'.padStart(3)} ${'馬名'.padEnd(16)} ${'性'.padStart(2)} ${'生年月日'.padStart(8)}` +
    `  ${'スコア'.padStart(7)}  ${'区分'}  ${'母名'.padEnd(16)}  ${'生産者'.padEnd(16)}  ${'厩舎'.padEnd(10)}  ${'馬主'.padEnd(18)}  ${'主なインブリード'}`
  );
  console.log('  ' + '─'.repeat(W + 50));

  for (let rank = 0; rank < unracedResults.length; rank++) {
    const r = unracedResults[rank];
    console.log(
      `  ${String(rank + 1).padStart(3)} ${r.name.padEnd(16)} ${r.sex.padStart(2)} ${r.birthDate.padStart(8)}` +
      `  ${r.score.toFixed(3).padStart(7)}  [${r.cls}]  ${r.dam.padEnd(16)}  ${r.breeder.padEnd(16)}  ${r.trainer.padEnd(10)}  ${r.owner.padEnd(18)}  ${r.topIbs}`
    );
  }

  // 区分別集計
  console.log('\n  区分別:');
  for (const cls of ['A', 'B', 'C', 'D']) {
    const g = unracedResults.filter(r => r.cls === cls);
    if (!g.length) continue;
    console.log(`  [${cls}] ${String(g.length).padStart(3)}頭  ${g.map(r => r.name).join(', ')}`);
  }

  console.log('\n  ※ スコアは既出走産駒の実績分布を基準に算出。配合パターンの傾向参考値。\n');
}

main()
  .catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); })
  .finally(() => pool.end());
