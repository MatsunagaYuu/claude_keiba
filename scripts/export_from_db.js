/**
 * PostgreSQL(Windows) → race_result/*.csv エクスポートスクリプト
 * Usage:
 *   node scripts/export_from_db.js              # 全期間
 *   node scripts/export_from_db.js 2024         # 年指定
 *   node scripts/export_from_db.js 2024 2025    # 年範囲指定
 *   node scripts/export_from_db.js --force 2025 # 既存ファイルも上書き
 *
 * 環境変数:
 *   PGHOST   (default: 192.168.0.101)
 *   PGUSER   (default: postgres)
 *   PGPASSWORD
 *   PGDATABASE (default: mykeibadb)
 */

const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "race_result");

// --- 接続設定 ---
const DB_CONFIG = {
  host: process.env.PGHOST || "192.168.0.101",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || "mykeibadb",
  port: parseInt(process.env.PGPORT || "5432"),
};

// --- 引数パース ---
const args = process.argv.slice(2);
const forceFlag = args.includes("--force");
const yearArgs = args.filter((a) => /^\d{4}$/.test(a));
const yearStart = yearArgs[0] || null;
const yearEnd = yearArgs[1] || yearStart;

// --- クラス名生成 ---
function buildClassName(r) {
  const j2 = r.joken_2sai.trim();
  const j3 = r.joken_3sai.trim();
  const j4 = r.joken_4sai.trim();
  const j5 = r.joken_5sai.trim();
  const jMin = r.joken_min.trim();

  const levelName = (code) => {
    switch (code) {
      case "701": return "新馬";
      case "702":
      case "703": return "未勝利";
      case "005": return "1勝";
      case "010": return "2勝";
      case "016": return "3勝";
      default: return "OP";
    }
  };

  if (j2 !== "000" && j3 === "000") return "2歳" + levelName(jMin);
  if (j3 !== "000" && j4 === "000" && j5 === "000") return "3歳" + levelName(jMin);
  if (j3 !== "000" && j4 !== "000") return "3歳以上" + levelName(jMin);
  if (j4 !== "000") return "4歳以上" + levelName(jMin);
  return "OP";
}

// --- グレード変換 ---
function buildGrade(code) {
  switch (code.trim()) {
    case "A": return "G1";
    case "B": return "G2";
    case "C": return "G3";
    case "L": return "L";
    case "E":
    case "D": return "OP";
    default: return "";
  }
}

// --- 芝/ダート判定 ---
function buildSurface(trackCode) {
  const c = parseInt(trackCode.trim());
  if (c >= 10 && c <= 22) return "芝";
  return "ダート";
}

// --- 馬場状態 ---
function buildBabaJotai(trackCode, shibaCode, dirtCode) {
  const c = parseInt(trackCode.trim());
  const code = (c >= 10 && c <= 22) ? shibaCode.trim() : dirtCode.trim();
  switch (code) {
    case "1": return "良";
    case "2": return "稍重";
    case "3": return "重";
    case "4": return "不良";
    default: return "";
  }
}

// --- 天候 ---
function buildTenkou(code) {
  switch (code.trim()) {
    case "1": return "晴";
    case "2": return "曇";
    case "3": return "雨";
    case "4": return "小雨";
    case "5": return "雪";
    case "6": return "小雪";
    default: return "";
  }
}

// --- タイム変換: "2024" → "2:02.4" ---
function buildTime(raw) {
  const s = raw.trim();
  if (!s || s === "0000") return "";
  // 形式: M SS F (例: "2024" = 2:02.4)
  return s[0] + ":" + s.slice(1, 3) + "." + s[3];
}

// --- 着差変換 ---
function buildChakusa(code) {
  switch (code.trim()) {
    case "A": return "アタマ";
    case "K": return "クビ";
    case "H": return "ハナ";
    default: return code.trim();
  }
}

// --- 通過順: 0以外のコーナーのみ連結 ---
function buildPassage(c1, c2, c3, c4) {
  const corners = [c1, c2, c3, c4]
    .map((c) => c.trim())
    .filter((c) => c !== "00" && c !== "0" && c !== "")
    .map((c) => parseInt(c).toString());
  return corners.join("-");
}

// --- CSVエスケープ ---
function csvField(val) {
  const s = val == null ? "" : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// --- メイン ---
async function main() {
  if (!DB_CONFIG.password) {
    console.error("ERROR: PGPASSWORD環境変数を設定してください");
    console.error("  export PGPASSWORD=xxxx");
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const client = new Client(DB_CONFIG);
  await client.connect();
  console.log(`接続OK: ${DB_CONFIG.host}/${DB_CONFIG.database}`);

  // 年範囲条件
  let yearCond = "";
  const params = [];
  if (yearStart) {
    params.push(yearStart);
    yearCond = `AND r.kaisai_nen >= $${params.length}`;
  }
  if (yearEnd) {
    params.push(yearEnd);
    yearCond += ` AND r.kaisai_nen <= $${params.length}`;
  }

  const SQL = `
    SELECT
      r.kaisai_nen,
      r.kaisai_gappi,
      r.keibajo_code,
      r.race_bango,
      REPLACE(kj.jomei, '競馬場', '') AS keibajo_name,
      TRIM(r.kaisai_kai)::int || '回' AS kaiji,
      TRIM(r.kaisai_nichime)::int || '日目' AS nichime,
      r.kyoso_joken_code_2sai  AS joken_2sai,
      r.kyoso_joken_code_3sai  AS joken_3sai,
      r.kyoso_joken_code_4sai  AS joken_4sai,
      r.kyoso_joken_code_5sai_ijo AS joken_5sai,
      r.kyoso_joken_code_saijakunen AS joken_min,
      r.grade_code,
      r.track_code,
      r.kyori,
      r.tenko_code,
      r.shiba_babajotai_code,
      r.dirt_babajotai_code,
      TRIM(u.kakutei_chakujun)::int AS chakujun,
      TRIM(u.wakuban)::int AS wakuban,
      TRIM(u.umaban)::int AS umaban,
      TRIM(u.bamei) AS bamei,
      CASE TRIM(u.seibetsu_code) WHEN '1' THEN '牡' WHEN '2' THEN '牝' WHEN '3' THEN 'セ' ELSE '' END
        || TRIM(u.barei)::int AS seireki,
      TRIM(u.futan_juryo)::int / 10 AS juryo,
      TRIM(u.kishumei_ryakusho) AS kishu,
      u.soha_time,
      u.chakusa_code1,
      u.corner1_juni, u.corner2_juni, u.corner3_juni, u.corner4_juni,
      ROUND(TRIM(u.kohan_3f)::numeric / 10, 1) AS agari,
      TRIM(u.tansho_ninkijun)::int AS ninki,
      ROUND(TRIM(u.tansho_odds)::numeric / 10, 1) AS odds
    FROM race_shosai r
    JOIN umagoto_race_joho u ON r.race_code = u.race_code
    JOIN keibajo_code kj ON r.keibajo_code = kj.code
    WHERE r.keibajo_code BETWEEN '01' AND '10'
      AND TRIM(r.track_code)::int BETWEEN 10 AND 29
      AND TRIM(u.kakutei_chakujun) NOT IN ('', '00')
      AND TRIM(u.kakutei_chakujun)::int BETWEEN 1 AND 28
      ${yearCond}
    ORDER BY r.kaisai_nen, r.kaisai_gappi, r.keibajo_code, r.race_bango, u.kakutei_chakujun
  `;

  const res = await client.query(SQL, params);
  console.log(`取得: ${res.rows.length} 行`);

  // レース単位にグループ化
  const raceMap = new Map();
  for (const row of res.rows) {
    const date = row.kaisai_nen + row.kaisai_gappi; // YYYYMMDD
    const key = `${date}${row.keibajo_code}${row.race_bango.toString().padStart(2, "0")}`;
    if (!raceMap.has(key)) {
      raceMap.set(key, { meta: row, rows: [] });
    }
    raceMap.get(key).rows.push(row);
  }

  const HEADER = "競馬場名,開催,開催日,クラス,グレード,芝/ダート,距離,天候,馬場,着順,枠番,馬番,馬名,性齢,斤量,騎手,タイム,着差,通過,上がり,人気,単勝オッズ";

  let written = 0;
  let skipped = 0;

  for (const [key, { meta, rows }] of raceMap) {
    const filename = `result_${key}.csv`;
    const filepath = path.join(OUTPUT_DIR, filename);

    if (!forceFlag && fs.existsSync(filepath)) {
      skipped++;
      continue;
    }

    const lines = [HEADER];
    for (const row of rows) {
      const fields = [
        row.keibajo_name,
        row.kaiji,
        row.nichime,
        buildClassName(row),
        buildGrade(row.grade_code),
        buildSurface(row.track_code),
        parseInt(row.kyori.trim()),
        buildTenkou(row.tenko_code),
        buildBabaJotai(row.track_code, row.shiba_babajotai_code, row.dirt_babajotai_code),
        row.chakujun,
        row.wakuban,
        row.umaban,
        row.bamei,
        row.seireki,
        row.juryo,
        row.kishu,
        buildTime(row.soha_time),
        buildChakusa(row.chakusa_code1),
        buildPassage(row.corner1_juni, row.corner2_juni, row.corner3_juni, row.corner4_juni),
        row.agari,
        row.ninki,
        row.odds,
      ];
      lines.push(fields.map(csvField).join(","));
    }

    fs.writeFileSync(filepath, lines.join("\n") + "\n", "utf-8");
    written++;

    if (written % 500 === 0) {
      process.stdout.write(`\r${written} ファイル書き出し済み...`);
    }
  }

  await client.end();
  console.log(`\n完了: ${written} ファイル書き出し, ${skipped} スキップ`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
