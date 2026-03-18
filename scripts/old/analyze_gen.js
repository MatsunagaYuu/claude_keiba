const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "race_index");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".csv"));

const buckets = {};

for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter(l => l.trim());
  if (lines.length < 2) continue;
  const h = lines[0].split(",");
  const ci = h.indexOf("クラス"), ai = h.indexOf("能力指数"), ri = h.indexOf("着順");
  const row1 = lines[1].split(",");
  const cls = row1[ci];

  // 世代判定
  let gen;
  if (cls.includes("2歳")) gen = "2歳";
  else if (cls.includes("3歳") && !cls.includes("以上")) gen = "3歳";
  else gen = "古馬";

  // クラス判定
  let level;
  if (cls.includes("新馬")) level = "新馬";
  else if (cls.includes("未勝利")) level = "未勝利";
  else if (cls.includes("1勝") || cls.includes("500万下")) level = "1勝";
  else if (cls.includes("2勝") || cls.includes("1000万下")) level = "2勝";
  else if (cls.includes("3勝") || cls.includes("1600万下")) level = "3勝";
  else if (cls.includes("オープン") || cls.includes("OP")) level = "OP";
  else continue;

  // 全完走馬の平均能力指数
  let sum = 0, cnt = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const idx = parseInt(cols[ai]);
    if (!isNaN(idx) && /^\d+$/.test(cols[ri])) { sum += idx; cnt++; }
  }
  if (cnt === 0) continue;

  const key = level + "_" + gen;
  if (!buckets[key]) buckets[key] = { level, gen, values: [] };
  buckets[key].values.push(sum / cnt);
}

// 表示
const levels = ["新馬", "未勝利", "1勝", "2勝", "3勝", "OP"];
const gens = ["2歳", "3歳", "古馬"];

console.log("クラス".padEnd(8) + gens.map(g => g.padStart(10)).join("") + "  3歳-古馬  2歳-古馬");
for (const level of levels) {
  let line = level.padEnd(8);
  const vals = {};
  for (const gen of gens) {
    const key = level + "_" + gen;
    const b = buckets[key];
    if (b && b.values.length > 0) {
      const avg = b.values.reduce((a, b) => a + b, 0) / b.values.length;
      vals[gen] = avg;
      line += (avg.toFixed(1) + "(" + b.values.length + ")").padStart(10);
    } else {
      line += "-".padStart(10);
    }
  }
  // 差分
  if (vals["3歳"] && vals["古馬"]) {
    line += (vals["3歳"] - vals["古馬"]).toFixed(1).padStart(8);
  } else {
    line += "-".padStart(8);
  }
  if (vals["2歳"] && vals["古馬"]) {
    line += (vals["2歳"] - vals["古馬"]).toFixed(1).padStart(8);
  } else {
    line += "-".padStart(8);
  }
  console.log(line);
}
