#!/usr/bin/env node
// scripts/analyze_sex_diff.js
// 種牡馬別 牡牝勝ち上がり率比較
//
// Usage:
//   node scripts/analyze_sex_diff.js
//   node scripts/analyze_sex_diff.js --from=2020 --to=2024 --min=30 --diff=5

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || '192.168.0.55',
  database: process.env.PGDATABASE || 'mykeibadb',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  port:     parseInt(process.env.PGPORT || '5432'),
});

const args = process.argv.slice(2);
function getArg(key, def) {
  const a = args.find(a => a.startsWith(`--${key}=`));
  return a ? a.split('=')[1] : def;
}

const FROM_YEAR = getArg('from', '2019');  // 生年開始
const TO_YEAR   = getArg('to',   '2023');  // 生年終了
const MIN_HEAD  = parseInt(getArg('min',  '30'));   // 牡牝それぞれの最低出走頭数
const MIN_DIFF  = parseFloat(getArg('diff', '5.0')); // 表示する最低勝ち上がり率差(%)
const SORT_BY   = getArg('sort', 'diff');  // diff | male | female | sire

async function main() {
  process.stderr.write(`\n生年 ${FROM_YEAR}〜${TO_YEAR}  最低頭数 ${MIN_HEAD}頭/性  最低差 ${MIN_DIFF}%\n`);
  process.stderr.write('データ集計中...\n');

  const rows = await (async () => {
    const c = await pool.connect();
    try {
      return (await c.query(`
        WITH race_summary AS (
          -- 馬ごとのJRA平地出走数・勝利数
          SELECT
            TRIM(u.ketto_toroku_bango) AS id,
            COUNT(*)                   AS starts,
            SUM(CASE WHEN TRIM(u.kakutei_chakujun)::int = 1 THEN 1 ELSE 0 END) AS wins
          FROM umagoto_race_joho u
          JOIN race_shosai r ON u.race_code = r.race_code
          WHERE TRIM(r.keibajo_code) BETWEEN '01' AND '10'
            AND TRIM(r.track_code)::int BETWEEN 10 AND 29
            AND TRIM(u.kakutei_chakujun) ~ '^[0-9]+$'
            AND TRIM(u.kakutei_chakujun)::int BETWEEN 1 AND 28
          GROUP BY TRIM(u.ketto_toroku_bango)
        )
        SELECT
          TRIM(chichi.bamei)           AS sire,
          TRIM(k.seibetsu_code)        AS sex_code,
          COUNT(*)                     AS starters,
          SUM(CASE WHEN rs.wins > 0 THEN 1 ELSE 0 END) AS winners
        FROM kyosoba_master2 k
        JOIN hanshokuba_master2 chichi
          ON TRIM(k.ketto1_hanshoku_toroku_bango) = TRIM(chichi.hanshoku_toroku_bango)
        JOIN race_summary rs
          ON TRIM(k.ketto_toroku_bango) = rs.id
        WHERE LEFT(TRIM(k.seinengappi), 4) BETWEEN $1 AND $2
          AND TRIM(k.seibetsu_code) IN ('1', '2')
        GROUP BY TRIM(chichi.bamei), TRIM(k.seibetsu_code)
        ORDER BY TRIM(chichi.bamei), TRIM(k.seibetsu_code)
      `, [FROM_YEAR, TO_YEAR])).rows;
    } finally { c.release(); }
  })();

  process.stderr.write(`  取得: ${rows.length} 行\n`);

  // 種牡馬ごとに牡・牝をまとめる
  const sireMap = {};
  for (const r of rows) {
    if (!sireMap[r.sire]) sireMap[r.sire] = {};
    const sex = r.sex_code === '1' ? 'male' : 'female';
    sireMap[r.sire][sex] = {
      starters: parseInt(r.starters),
      winners:  parseInt(r.winners),
    };
  }

  // 集計・フィルタ
  const results = [];
  for (const [sire, data] of Object.entries(sireMap)) {
    const m = data.male;
    const f = data.female;
    if (!m || !f) continue;
    if (m.starters < MIN_HEAD || f.starters < MIN_HEAD) continue;

    const mRate = m.winners / m.starters * 100;
    const fRate = f.winners / f.starters * 100;
    const diff  = mRate - fRate; // 正=牡優勢, 負=牝優勢

    if (Math.abs(diff) < MIN_DIFF) continue;

    results.push({ sire, m, f, mRate, fRate, diff });
  }

  // ソート
  if (SORT_BY === 'male')   results.sort((a, b) => b.mRate  - a.mRate);
  else if (SORT_BY === 'female') results.sort((a, b) => b.fRate - a.fRate);
  else if (SORT_BY === 'sire')   results.sort((a, b) => a.sire.localeCompare(b.sire));
  else results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)); // default: diff

  // ── 出力 ──────────────────────────────────────────────────────────────────
  const W = 100;
  console.log('\n' + '═'.repeat(W));
  console.log(`  種牡馬別 牡牝勝ち上がり率比較   生年 ${FROM_YEAR}〜${TO_YEAR}   JRA平地   最低${MIN_HEAD}頭/性`);
  console.log('═'.repeat(W));
  console.log(`  ※ 勝ち上がり率 = JRA平地で1勝以上した馬の割合   差=牡率-牝率 (正=牡優勢 / 負=牝優勢)`);
  console.log('─'.repeat(W));
  console.log(
    `  ${'種牡馬'.padEnd(22)} ` +
    `${'牡頭数'.padStart(6)} ${'牡勝上%'.padStart(7)} ${'牡勝頭'.padStart(6)}  ` +
    `${'牝頭数'.padStart(6)} ${'牝勝上%'.padStart(7)} ${'牝勝頭'.padStart(6)}  ` +
    `${'差(牡-牝)'.padStart(9)}  ${'傾向'}`
  );
  console.log('  ' + '─'.repeat(W - 2));

  for (const r of results) {
    const arrow = r.diff > 0
      ? (r.diff >= 15 ? '牡▲▲▲' : r.diff >= 10 ? '牡▲▲ ' : '牡▲  ')
      : (r.diff <= -15 ? '牝▲▲▲' : r.diff <= -10 ? '牝▲▲ ' : '牝▲  ');
    const diffStr = (r.diff >= 0 ? '+' : '') + r.diff.toFixed(1) + '%';
    console.log(
      `  ${r.sire.padEnd(22)} ` +
      `${String(r.m.starters).padStart(6)} ${r.mRate.toFixed(1).padStart(6)}% ${String(r.m.winners).padStart(6)}頭  ` +
      `${String(r.f.starters).padStart(6)} ${r.fRate.toFixed(1).padStart(6)}% ${String(r.f.winners).padStart(6)}頭  ` +
      `${diffStr.padStart(9)}  ${arrow}`
    );
  }

  console.log('─'.repeat(W));
  console.log(`  合計: ${results.length}種牡馬 (差>${MIN_DIFF}% かつ両性${MIN_HEAD}頭以上)`);

  // ── 統計サマリ ──
  const maleAdv  = results.filter(r => r.diff > 0);
  const femAdv   = results.filter(r => r.diff < 0);
  const avgDiff  = results.reduce((a, c) => a + Math.abs(c.diff), 0) / results.length;
  console.log(`\n  牡優勢: ${maleAdv.length}種牡馬 / 牝優勢: ${femAdv.length}種牡馬 / 平均絶対差: ${avgDiff.toFixed(1)}%`);

  // 牝優勢TOP10
  console.log('\n─── 牝優勢 上位10種牡馬 (牝馬の方が勝ち上がりやすい) ────────────────────');
  for (const r of [...results].sort((a, b) => a.diff - b.diff).slice(0, 10)) {
    console.log(`  ${r.sire.padEnd(22)}  牡${r.mRate.toFixed(1)}% vs 牝${r.fRate.toFixed(1)}%  差${(r.diff).toFixed(1)}%`);
  }

  // 牡優勢TOP10
  console.log('\n─── 牡優勢 上位10種牡馬 (牡馬の方が勝ち上がりやすい) ────────────────────');
  for (const r of [...results].sort((a, b) => b.diff - a.diff).slice(0, 10)) {
    console.log(`  ${r.sire.padEnd(22)}  牡${r.mRate.toFixed(1)}% vs 牝${r.fRate.toFixed(1)}%  差+${r.diff.toFixed(1)}%`);
  }

  console.log();
}

main()
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); })
  .finally(() => pool.end());
