/**
 * DBのkaisai_scheduleからkaisai_calendar.jsonを生成する
 * scrape_calendar.js の代替（スクレイピング不要）
 *
 * 使い方:
 *   node scripts/build_calendar_from_db.js              # 全期間更新
 *   node scripts/build_calendar_from_db.js 2026         # 指定年のみ更新
 *   node scripts/build_calendar_from_db.js 2024 2026    # 年範囲指定
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const OUTPUT_FILE = path.join(__dirname, "..", "kaisai_calendar.json");

const DB_CONFIG = {
  host:     process.env.PGHOST     || "192.168.0.55",
  user:     process.env.PGUSER     || "postgres",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || "mykeibadb",
  port:     parseInt(process.env.PGPORT || "5432"),
};

// JRA競馬場コード → 場名（01-10のみ）
const VENUE_NAME = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
  "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
};

async function main() {
  const args = process.argv.slice(2);
  let startYear = null;
  let endYear = null;
  if (args[0]) {
    startYear = parseInt(args[0]);
    endYear = args[1] ? parseInt(args[1]) : startYear;
  }

  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // 対象年範囲のWHERE句
    let whereClause = "WHERE keibajo_code BETWEEN '01' AND '10'";
    if (startYear && endYear) {
      whereClause += ` AND kaisai_nen BETWEEN '${startYear}' AND '${endYear}'`;
    }

    const res = await client.query(`
      SELECT kaisai_nen, kaisai_gappi, keibajo_code, kaisai_kaiji, kaisai_nichiji
      FROM kaisai_schedule
      ${whereClause}
      ORDER BY kaisai_nen, kaisai_gappi, keibajo_code
    `);

    // date → venues[] にグループ化
    const dateMap = {};
    for (const row of res.rows) {
      const date = row.kaisai_nen + row.kaisai_gappi.padStart(4, "0");
      const venueName = VENUE_NAME[row.keibajo_code];
      if (!venueName) continue;

      if (!dateMap[date]) dateMap[date] = [];
      dateMap[date].push({
        venue: venueName,
        kaisai: parseInt(row.kaisai_kaiji),
        day: parseInt(row.kaisai_nichiji),
      });
    }

    // kaisai_calendar.json の形式に変換
    const newEntries = Object.entries(dateMap)
      .map(([date, venues]) => ({ date, venues }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 既存データとマージ（対象年範囲のみ差し替え）
    let existing = [];
    if (fs.existsSync(OUTPUT_FILE)) {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
    }

    let merged;
    if (startYear && endYear) {
      const keep = existing.filter(d => {
        const y = parseInt(d.date.substring(0, 4));
        return y < startYear || y > endYear;
      });
      merged = [...keep, ...newEntries].sort((a, b) => a.date.localeCompare(b.date));
    } else {
      merged = newEntries;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2), "utf-8");
    console.log(`Saved: ${OUTPUT_FILE} (${merged.length} dates, ${newEntries.length} updated)`);

    // サンプル表示
    const sample = newEntries.slice(-3);
    for (const e of sample) {
      const desc = e.venues.map(v => `${v.venue}${v.kaisai}回${v.day}日目`).join(", ");
      console.log(`  ${e.date}: ${desc}`);
    }
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
