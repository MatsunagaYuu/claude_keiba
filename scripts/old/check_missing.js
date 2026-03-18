const fs = require("fs");
const path = require("path");
const resultDir = path.join(__dirname, "..", "race_result");
const indexDir = path.join(__dirname, "..", "race_index");
const baseTimesFile = path.join(__dirname, "..", "base_times.json");

const results = fs.readdirSync(resultDir).filter(f => f.endsWith(".csv"));
const indices = new Set(fs.readdirSync(indexDir).filter(f => f.endsWith(".csv")));
const baseTimes = JSON.parse(fs.readFileSync(baseTimesFile, "utf-8"));
const baseMap = {};
for (const bt of baseTimes) {
  baseMap[`${bt.競馬場}_${bt.距離}_${bt.クラス}`] = bt;
}

function classifyRace(className) {
  if (!className) return null;
  if (className.includes("障害")) return null;
  if (className.includes("新馬")) return "未勝利";
  if (className.includes("未勝利")) return "未勝利";
  if (className.includes("1勝")) return "1勝クラス";
  if (className.includes("2勝")) return "2勝クラス";
  if (className.includes("3勝")) return "3勝クラス";
  if (className.includes("オープン") || className.includes("OP")) return "OP";
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return "OP";
  return null;
}

let missing = 0;
const reasons = {};

for (const f of results) {
  const indexFile = f.replace("result_", "index_");
  if (indices.has(indexFile)) continue;

  const content = fs.readFileSync(path.join(resultDir, f), "utf-8");
  const line2 = content.split("\n")[1];
  if (!line2) { reasons["empty"] = (reasons["empty"] || 0) + 1; continue; }

  const cols = line2.split(",");
  const venue = cols[0], surface = cols[4], dist = cols[5], cls = cols[3];
  let reason;

  if (surface !== "芝") {
    reason = "ダート";
  } else if (cls.includes("障害")) {
    reason = "障害";
  } else {
    const category = classifyRace(cls);
    if (!category) {
      reason = "クラス不明: " + cls;
    } else {
      const btKey = `${venue}_${dist}_${category}`;
      if (!baseMap[btKey]) {
        reason = "基準タイムなし: " + btKey;
      } else {
        reason = "原因不明: " + venue + " " + dist + "m " + cls;
      }
    }
  }
  reasons[reason] = (reasons[reason] || 0) + 1;
  missing++;
}

console.log("race_resultにあってrace_indexにないファイル:", missing);
console.log("");
const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log("  " + k + ": " + v);
