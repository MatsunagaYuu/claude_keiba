const fs = require("fs");
const path = require("path");

const EXT_DIR = path.join(__dirname, "..", "race_index");
const NAI_DIR = path.join(__dirname, "..", "race_index_naisei");

function parseCSV(content) {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const row = {};
    headers.forEach((h, idx) => (row[h] = vals[idx] || ""));
    rows.push(row);
  }
  return rows;
}

function main() {
  const extFiles = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith(".csv"));

  const diffs = { 総合指数: [], 上がり指数: [], 能力指数: [] };
  let compared = 0;
  let skipped = 0;
  let refChanged = { extOnly: 0, naiOnly: 0 }; // 参考フラグの変化

  for (const file of extFiles) {
    const naiFile = path.join(NAI_DIR, file);
    if (!fs.existsSync(naiFile)) { skipped++; continue; }

    const extRows = parseCSV(fs.readFileSync(path.join(EXT_DIR, file), "utf-8"));
    const naiRows = parseCSV(fs.readFileSync(naiFile, "utf-8"));

    for (let i = 0; i < Math.min(extRows.length, naiRows.length); i++) {
      const ext = extRows[i];
      const nai = naiRows[i];

      // 参考フラグの変化を追跡
      if (ext.参考 === "1" && nai.参考 !== "1") refChanged.extOnly++;
      if (ext.参考 !== "1" && nai.参考 === "1") refChanged.naiOnly++;

      for (const field of ["総合指数", "上がり指数", "能力指数"]) {
        const ev = parseInt(ext[field]);
        const nv = parseInt(nai[field]);
        if (isNaN(ev) || isNaN(nv)) continue;
        diffs[field].push(nv - ev);
      }
      compared++;
    }
  }

  console.log(`比較馬数: ${compared}, スキップファイル: ${skipped}`);
  console.log(`参考フラグ変化: 外部のみ参考→内製で解消=${refChanged.extOnly}, 内製のみ参考=${refChanged.naiOnly}`);

  for (const [field, arr] of Object.entries(diffs)) {
    if (arr.length === 0) continue;
    const abs = arr.map((d) => Math.abs(d));
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const absMean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const max = abs.reduce((a, b) => a > b ? a : b, 0);
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    console.log(`\n=== ${field} (内製 - 外部) ===`);
    console.log(`  サンプル数: ${arr.length}`);
    console.log(`  平均差: ${mean.toFixed(2)}`);
    console.log(`  中央値: ${median}`);
    console.log(`  平均絶対差: ${absMean.toFixed(2)}`);
    console.log(`  最大絶対差: ${max}`);

    // 差の分布
    const buckets = [0, 1, 2, 3, 5, 10, Infinity];
    const labels = ["  0", "  1", "  2", "  3", "4-5", "6-10", " >10"];
    console.log(`  分布:`);
    let cum = 0;
    for (let i = 0; i < buckets.length; i++) {
      const count = abs.filter((d) => d === buckets[i] || (i > 0 && d > buckets[i - 1] && d <= buckets[i])).length;
      // 最初のバケットは d === 0
      const c = i === 0
        ? abs.filter((d) => d === 0).length
        : abs.filter((d) => d > buckets[i - 1] && d <= buckets[i]).length;
      cum += c;
      const pct = ((cum / arr.length) * 100).toFixed(1);
      console.log(`    差${labels[i]}: ${String(c).padStart(7)} (累計 ${pct.padStart(5)}%)`);
    }
  }
}

main();
