const fs = require("fs");
const path = require("path");

const RACE_RESULT_DIR = "./race_result";
const babaData = JSON.parse(fs.readFileSync("./baba_data.json", "utf-8"));

// 馬場データのキーマップ: "競馬場_開催_日次" → record
const babaMap = {};
for (const b of babaData) {
  const key = `${b.競馬場}_${b.開催}_${b.日次}`;
  babaMap[key] = b;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/^(\d+):(\d+\.\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
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

// 基準タイム（良馬場のみ、クラス別の平均タイム）を用意
// レースごとの走破タイム偏差 = 勝ち馬のタイム - 基準タイム
const baseTimes = JSON.parse(fs.readFileSync("./base_times.json", "utf-8"));
const baseMap = {};
for (const bt of baseTimes) {
  // 良馬場の基準だけ使う（馬場速度の影響を測るため）
  if (bt.馬場 === "良") {
    const key = `${bt.競馬場}_${bt.距離}_${bt.クラス}`;
    baseMap[key] = bt;
  }
}

const files = fs.readdirSync(RACE_RESULT_DIR).filter((f) => f.endsWith(".csv"));
const results = [];

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

for (const file of files) {
  const content = fs.readFileSync(path.join(RACE_RESULT_DIR, file), "utf-8");
  const rows = parseCSV(content);
  if (rows.length === 0) continue;

  const first = rows[0];
  const venue = first["競馬場名"];
  const surface = first["芝/ダート"];
  const dist = first["距離"];
  const condition = first["馬場"];
  const className = first["クラス"];
  const kaisai = first["開催"];
  const nichime = first["開催日"];

  // 芝のみ、1600/1800/2000
  if (surface !== "芝") continue;
  if (!["1600", "1800", "2000"].includes(dist)) continue;
  if (!["東京", "中山"].includes(venue)) continue;

  const category = classifyRace(className);
  if (!category) continue;

  // 勝ち馬のタイム（着順=1）
  const winner = rows.find((r) => r["着順"] === "1");
  if (!winner) continue;
  const winTime = timeToSeconds(winner["タイム"]);
  if (!winTime) continue;

  // 基準タイム（良馬場ベース）
  const btKey = `${venue}_${dist}_${category}`;
  const bt = baseMap[btKey];
  if (!bt) continue;

  // 馬場データとの紐付け
  const kaiNum = parseInt(kaisai.replace("回", ""));
  const dayNum = parseInt(nichime.replace("日目", ""));
  const babaKey = `${venue}_${kaiNum}_${dayNum}`;
  const baba = babaMap[babaKey];

  // タイム偏差: マイナス=基準より速い
  const timeDev = winTime - bt.基準走破秒;

  results.push({
    venue,
    dist: parseInt(dist),
    condition,
    category,
    winTime,
    baseTime: bt.基準走破秒,
    timeDev,
    // 距離で正規化した偏差（2000m換算）
    timeDevNorm: timeDev * (2000 / parseInt(dist)),
    cushion: baba ? baba.クッション値 : null,
    moistGoal: baba ? baba.芝含水率ゴール前 : null,
    moistCorner: baba ? baba.芝含水率4コーナー : null,
    date: baba ? baba.日付 : null,
    year: baba ? baba.年 : null,
  });
}

console.log(`Total race-winners matched: ${results.length}`);
console.log(`With cushion data: ${results.filter((r) => r.cushion !== null).length}`);
console.log(`With moisture data: ${results.filter((r) => r.moistGoal !== null).length}`);

// === 分析1: クッション値と走破タイム偏差の相関 ===
console.log("\n=== クッション値 vs タイム偏差（2000m換算）===");
const withCushion = results.filter((r) => r.cushion !== null);
if (withCushion.length > 0) {
  // クッション値を区間に分けて平均偏差を算出
  const bins = [
    { label: "~7.5", min: 0, max: 7.5 },
    { label: "7.5~8.5", min: 7.5, max: 8.5 },
    { label: "8.5~9.0", min: 8.5, max: 9.0 },
    { label: "9.0~9.5", min: 9.0, max: 9.5 },
    { label: "9.5~10.0", min: 9.5, max: 10.0 },
    { label: "10.0~", min: 10.0, max: 99 },
  ];
  console.log("クッション値    n    平均偏差(秒)  良馬場のみ偏差");
  for (const bin of bins) {
    const all = withCushion.filter(
      (r) => r.cushion >= bin.min && r.cushion < bin.max
    );
    const good = all.filter((r) => r.condition === "良");
    const avgAll = all.length > 0
      ? (all.reduce((s, r) => s + r.timeDevNorm, 0) / all.length).toFixed(2)
      : "-";
    const avgGood = good.length > 0
      ? (good.reduce((s, r) => s + r.timeDevNorm, 0) / good.length).toFixed(2)
      : "-";
    console.log(
      `${bin.label.padEnd(12)}  ${String(all.length).padStart(4)}  ${String(avgAll).padStart(10)}   ${String(avgGood).padStart(10)} (n=${good.length})`
    );
  }

  // 相関係数
  const n = withCushion.length;
  const meanX = withCushion.reduce((s, r) => s + r.cushion, 0) / n;
  const meanY = withCushion.reduce((s, r) => s + r.timeDevNorm, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (const r of withCushion) {
    const dx = r.cushion - meanX;
    const dy = r.timeDevNorm - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const corr = num / Math.sqrt(denX * denY);
  console.log(`相関係数(クッション値 vs 偏差): ${corr.toFixed(4)}`);
}

// === 分析2: 含水率とタイム偏差の相関 ===
console.log("\n=== 芝含水率(ゴール前) vs タイム偏差（2000m換算）===");
const withMoist = results.filter((r) => r.moistGoal !== null);
if (withMoist.length > 0) {
  const bins = [
    { label: "~10%", min: 0, max: 10 },
    { label: "10~13%", min: 10, max: 13 },
    { label: "13~16%", min: 13, max: 16 },
    { label: "16~20%", min: 16, max: 20 },
    { label: "20~25%", min: 20, max: 25 },
    { label: "25%~", min: 25, max: 99 },
  ];
  console.log("含水率(%)     n    平均偏差(秒)  良馬場のみ偏差");
  for (const bin of bins) {
    const all = withMoist.filter(
      (r) => r.moistGoal >= bin.min && r.moistGoal < bin.max
    );
    const good = all.filter((r) => r.condition === "良");
    const avgAll = all.length > 0
      ? (all.reduce((s, r) => s + r.timeDevNorm, 0) / all.length).toFixed(2)
      : "-";
    const avgGood = good.length > 0
      ? (good.reduce((s, r) => s + r.timeDevNorm, 0) / good.length).toFixed(2)
      : "-";
    console.log(
      `${bin.label.padEnd(12)}  ${String(all.length).padStart(4)}  ${String(avgAll).padStart(10)}   ${String(avgGood).padStart(10)} (n=${good.length})`
    );
  }

  const n = withMoist.length;
  const meanX = withMoist.reduce((s, r) => s + r.moistGoal, 0) / n;
  const meanY = withMoist.reduce((s, r) => s + r.timeDevNorm, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (const r of withMoist) {
    const dx = r.moistGoal - meanX;
    const dy = r.timeDevNorm - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const corr = num / Math.sqrt(denX * denY);
  console.log(`相関係数(含水率 vs 偏差): ${corr.toFixed(4)}`);
}

// === 分析3: 良馬場のみでクッション値×含水率の組合せ ===
console.log("\n=== 良馬場のみ: クッション値×含水率 → 偏差 ===");
const goodWithBoth = results.filter(
  (r) => r.condition === "良" && r.cushion !== null && r.moistGoal !== null
);
console.log(`良馬場 + 馬場データあり: ${goodWithBoth.length} races`);

if (goodWithBoth.length > 0) {
  // 重回帰: timeDev = a * cushion + b * moisture + c
  const n = goodWithBoth.length;
  let sx = 0, sy = 0, sz = 0;
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const r of goodWithBoth) {
    const x = r.cushion;
    const y = r.moistGoal;
    const z = r.timeDevNorm;
    sx += x; sy += y; sz += z;
    sxx += x * x; syy += y * y;
    sxy += x * y; sxz += x * z; syz += y * z;
  }
  // Normal equations: [sxx sxy sx] [a]   [sxz]
  //                   [sxy syy sy] [b] = [syz]
  //                   [sx  sy  n ] [c]   [sz ]
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const B = [sxz, syz, sz];
  // Solve 3x3 (Cramer's rule)
  function det3(m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
          -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
          +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  const D = det3(A);
  const Da = det3([[B[0],A[0][1],A[0][2]],[B[1],A[1][1],A[1][2]],[B[2],A[2][1],A[2][2]]]);
  const Db = det3([[A[0][0],B[0],A[0][2]],[A[1][0],B[1],A[1][2]],[A[2][0],B[2],A[2][2]]]);
  const Dc = det3([[A[0][0],A[0][1],B[0]],[A[1][0],A[1][1],B[1]],[A[2][0],A[2][1],B[2]]]);
  const a = Da/D, b = Db/D, c = Dc/D;
  console.log(`重回帰: 偏差 = ${a.toFixed(3)} × クッション値 + ${b.toFixed(3)} × 含水率 + ${(c).toFixed(3)}`);
  console.log(`解釈: クッション値1上昇 → ${a.toFixed(3)}秒, 含水率1%上昇 → ${b.toFixed(3)}秒`);

  // 予測値と馬場速度スコア
  // スコア = -(a * cushion + b * moisture + c) → 速いほどプラス
  const scores = goodWithBoth.map((r) => ({
    ...r,
    score: -(a * r.cushion + b * r.moistGoal + c),
  }));
  scores.sort((x, y) => x.score - y.score);

  // パーセンタイルで7段階に分ける
  const pcts = [5, 15, 35, 65, 85, 95];
  const labels = ["極遅", "遅", "稍遅", "標準", "稍速", "速", "極速"];
  const thresholds = pcts.map((p) => scores[Math.floor(scores.length * p / 100)].score);

  console.log("\n7段階分類（良馬場、予測タイム偏差ベース）:");
  console.log("分類    スコア閾値     該当数  平均偏差(秒)");
  for (let i = 0; i < labels.length; i++) {
    const lo = i === 0 ? -Infinity : thresholds[i - 1];
    const hi = i < thresholds.length ? thresholds[i] : Infinity;
    const inBin = scores.filter((s) => s.score >= lo && s.score < hi);
    const avgDev = inBin.length > 0
      ? (inBin.reduce((s, r) => s + r.timeDevNorm, 0) / inBin.length).toFixed(2)
      : "-";
    console.log(
      `${labels[i].padEnd(6)}  ${i === 0 ? "     " : thresholds[i - 1].toFixed(2).padStart(6)} ~ ${i < thresholds.length ? thresholds[i].toFixed(2).padStart(6) : "     "}  ${String(inBin.length).padStart(4)}    ${avgDev}`
    );
  }

  // === 分析4: 日単位の平均偏差 (馬場差) ===
  console.log("\n=== 日単位の馬場差（良馬場のみ） ===");
  // 同じ日・競馬場の全レースの偏差を平均して馬場差にする
  const dayGroups = {};
  for (const r of results) {
    if (r.condition !== "良") continue;
    if (r.cushion === null && r.moistGoal === null) continue;
    const key = `${r.venue}_${r.date}`;
    if (!dayGroups[key]) dayGroups[key] = { devs: [], cushion: r.cushion, moistGoal: r.moistGoal, venue: r.venue, date: r.date };
    dayGroups[key].devs.push(r.timeDevNorm);
  }

  const dayData = Object.values(dayGroups)
    .filter((d) => d.devs.length >= 2)
    .map((d) => ({
      ...d,
      avgDev: d.devs.reduce((a, b) => a + b, 0) / d.devs.length,
      n: d.devs.length,
    }));

  console.log(`日数: ${dayData.length} (各日2レース以上)`);

  // クッション値 vs 日平均偏差
  const dayWithCushion = dayData.filter((d) => d.cushion !== null);
  if (dayWithCushion.length > 0) {
    const dn = dayWithCushion.length;
    const dmx = dayWithCushion.reduce((s, d) => s + d.cushion, 0) / dn;
    const dmy = dayWithCushion.reduce((s, d) => s + d.avgDev, 0) / dn;
    let dnum = 0, ddenX = 0, ddenY = 0;
    for (const d of dayWithCushion) {
      const dx = d.cushion - dmx;
      const dy = d.avgDev - dmy;
      dnum += dx * dy;
      ddenX += dx * dx;
      ddenY += dy * dy;
    }
    const dcorr = dnum / Math.sqrt(ddenX * ddenY);
    console.log(`相関(クッション値 vs 日平均偏差): ${dcorr.toFixed(4)} (n=${dn})`);
  }

  // 含水率 vs 日平均偏差
  const dayWithMoist = dayData.filter((d) => d.moistGoal !== null);
  if (dayWithMoist.length > 0) {
    const dn = dayWithMoist.length;
    const dmx = dayWithMoist.reduce((s, d) => s + d.moistGoal, 0) / dn;
    const dmy = dayWithMoist.reduce((s, d) => s + d.avgDev, 0) / dn;
    let dnum = 0, ddenX = 0, ddenY = 0;
    for (const d of dayWithMoist) {
      const dx = d.moistGoal - dmx;
      const dy = d.avgDev - dmy;
      dnum += dx * dy;
      ddenX += dx * dx;
      ddenY += dy * dy;
    }
    const dcorr = dnum / Math.sqrt(ddenX * ddenY);
    console.log(`相関(含水率 vs 日平均偏差): ${dcorr.toFixed(4)} (n=${dn})`);
  }

  // 日単位重回帰
  const dayBoth = dayData.filter((d) => d.cushion !== null && d.moistGoal !== null);
  if (dayBoth.length > 0) {
    const dn = dayBoth.length;
    let dsx=0,dsy=0,dsz=0,dsxx=0,dsyy=0,dsxy=0,dsxz=0,dsyz=0;
    for (const d of dayBoth) {
      const x=d.cushion,y=d.moistGoal,z=d.avgDev;
      dsx+=x;dsy+=y;dsz+=z;dsxx+=x*x;dsyy+=y*y;dsxy+=x*y;dsxz+=x*z;dsyz+=y*z;
    }
    const dA=[[dsxx,dsxy,dsx],[dsxy,dsyy,dsy],[dsx,dsy,dn]];
    const dB=[dsxz,dsyz,dsz];
    const dD=det3(dA);
    const da=det3([[dB[0],dA[0][1],dA[0][2]],[dB[1],dA[1][1],dA[1][2]],[dB[2],dA[2][1],dA[2][2]]])/dD;
    const db=det3([[dA[0][0],dB[0],dA[0][2]],[dA[1][0],dB[1],dA[1][2]],[dA[2][0],dB[2],dA[2][2]]])/dD;
    const dc=det3([[dA[0][0],dA[0][1],dB[0]],[dA[1][0],dA[1][1],dB[1]],[dA[2][0],dA[2][1],dB[2]]])/dD;
    console.log(`重回帰(日単位): 偏差 = ${da.toFixed(3)} × クッション値 + ${db.toFixed(3)} × 含水率 + ${dc.toFixed(3)} (n=${dn})`);

    // R²計算
    const meanZ = dsz / dn;
    let ssRes = 0, ssTot = 0;
    for (const d of dayBoth) {
      const pred = da * d.cushion + db * d.moistGoal + dc;
      ssRes += (d.avgDev - pred) ** 2;
      ssTot += (d.avgDev - meanZ) ** 2;
    }
    console.log(`R² = ${(1 - ssRes / ssTot).toFixed(4)}`);

    // 7段階の馬場速度スコア
    const scored = dayBoth.map((d) => ({
      ...d,
      predicted: da * d.cushion + db * d.moistGoal + dc,
    }));
    scored.sort((a, b) => a.predicted - b.predicted);

    console.log("\n日単位 馬場速度7段階:");
    const pcts = [5, 15, 35, 65, 85, 95];
    const labels = ["極速", "速", "稍速", "標準", "稍遅", "遅", "極遅"];
    const thresholds = pcts.map((p) => scored[Math.floor(scored.length * p / 100)].predicted);

    console.log("分類    予測偏差閾値(秒)   n    実平均偏差(秒)  クッション値  含水率");
    for (let i = 0; i < labels.length; i++) {
      const lo = i === 0 ? -Infinity : thresholds[i - 1];
      const hi = i < thresholds.length ? thresholds[i] : Infinity;
      const inBin = scored.filter((s) => s.predicted >= lo && s.predicted < hi);
      const avgDev = inBin.length > 0 ? (inBin.reduce((s, d) => s + d.avgDev, 0) / inBin.length).toFixed(2) : "-";
      const avgCush = inBin.length > 0 ? (inBin.reduce((s, d) => s + d.cushion, 0) / inBin.length).toFixed(1) : "-";
      const avgMoist = inBin.length > 0 ? (inBin.reduce((s, d) => s + d.moistGoal, 0) / inBin.length).toFixed(1) : "-";
      console.log(
        `${labels[i].padEnd(6)}  ${(lo === -Infinity ? "     " : lo.toFixed(2).padStart(6))} ~ ${(hi === Infinity ? "     " : hi.toFixed(2).padStart(6))}  ${String(inBin.length).padStart(4)}     ${avgDev.padStart(6)}       ${avgCush.padStart(5)}    ${avgMoist.padStart(5)}`
      );
    }

    // 代表例: 天皇賞秋2023
    const tenno = dayBoth.find(d => d.date === "2023/10/29" && d.venue === "東京");
    if (tenno) {
      console.log(`\n天皇賞秋2023 (${tenno.date}): クッション値=${tenno.cushion}, 含水率=${tenno.moistGoal}%`);
      console.log(`  馬場差(実測)=${tenno.avgDev.toFixed(2)}秒, 予測=${tenno.predicted.toFixed(2)}秒`);
      const cat = labels[thresholds.filter(t => tenno.predicted >= t).length];
      console.log(`  → 分類: ${cat}`);
    }
  }

  // === 分析5: 馬場差そのものを分類に使う（回帰不要）===
  console.log("\n=== 馬場差ベースの7段階（実測値ベース） ===");
  const allDaysSorted = dayData.sort((a, b) => a.avgDev - b.avgDev);
  const pcts2 = [5, 15, 35, 65, 85, 95];
  const labels2 = ["極速", "速", "稍速", "標準", "稍遅", "遅", "極遅"];
  const thresholds2 = pcts2.map((p) => allDaysSorted[Math.floor(allDaysSorted.length * p / 100)].avgDev);

  console.log("分類    馬場差閾値(秒)    n    平均クッション値  平均含水率");
  for (let i = 0; i < labels2.length; i++) {
    const lo = i === 0 ? -Infinity : thresholds2[i - 1];
    const hi = i < thresholds2.length ? thresholds2[i] : Infinity;
    const inBin = allDaysSorted.filter((d) => d.avgDev >= lo && d.avgDev < hi);
    const avgCush = inBin.filter(d => d.cushion !== null);
    const avgMoist = inBin.filter(d => d.moistGoal !== null);
    const cush = avgCush.length > 0 ? (avgCush.reduce((s, d) => s + d.cushion, 0) / avgCush.length).toFixed(1) : "-";
    const moist = avgMoist.length > 0 ? (avgMoist.reduce((s, d) => s + d.moistGoal, 0) / avgMoist.length).toFixed(1) : "-";
    console.log(
      `${labels2[i].padEnd(6)}  ${(lo === -Infinity ? "      " : lo.toFixed(2).padStart(6))} ~ ${(hi === Infinity ? "      " : hi.toFixed(2).padStart(6))}   ${String(inBin.length).padStart(3)}       ${cush.padStart(5)}          ${moist.padStart(5)}`
    );
  }

  // 東京と中山で分けた場合
  for (const v of ["東京", "中山"]) {
    const vdata = goodWithBoth.filter(r => r.venue === v);
    if (vdata.length === 0) continue;
    const vn = vdata.length;
    let vsx=0,vsy=0,vsz=0,vsxx=0,vsyy=0,vsxy=0,vsxz=0,vsyz=0;
    for (const r of vdata) {
      const x=r.cushion,y=r.moistGoal,z=r.timeDevNorm;
      vsx+=x;vsy+=y;vsz+=z;vsxx+=x*x;vsyy+=y*y;vsxy+=x*y;vsxz+=x*z;vsyz+=y*z;
    }
    const vA=[[vsxx,vsxy,vsx],[vsxy,vsyy,vsy],[vsx,vsy,vn]];
    const vB=[vsxz,vsyz,vsz];
    const vD=det3(vA);
    const va=det3([[vB[0],vA[0][1],vA[0][2]],[vB[1],vA[1][1],vA[1][2]],[vB[2],vA[2][1],vA[2][2]]])/vD;
    const vb=det3([[vA[0][0],vB[0],vA[0][2]],[vA[1][0],vB[1],vA[1][2]],[vA[2][0],vB[2],vA[2][2]]])/vD;
    const vc=det3([[vA[0][0],vA[0][1],vB[0]],[vA[1][0],vA[1][1],vB[1]],[vA[2][0],vA[2][1],vB[2]]])/vD;
    console.log(`\n${v}: 偏差 = ${va.toFixed(3)} × クッション値 + ${vb.toFixed(3)} × 含水率 + ${vc.toFixed(3)} (n=${vn})`);
  }
}
