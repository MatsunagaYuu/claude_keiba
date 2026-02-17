const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const OUTPUT_FILE = "./baba_data.json";

// 全角数字・記号を半角に変換
function zenToHan(str) {
  return str.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  ).replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[～]/g, "~");
}

const VENUES = {
  tokyo: "東京",
  nakayama: "中山",
};

// 年・競馬場・開催の組み合わせでPDFをダウンロード・パース
async function main() {
  const yearStart = parseInt(process.argv[2]) || 2019;
  const yearEnd = parseInt(process.argv[3]) || 2025;
  const allData = [];

  for (let year = yearStart; year <= yearEnd; year++) {
    for (const [venueEn, venueJa] of Object.entries(VENUES)) {
      for (let kai = 1; kai <= 6; kai++) {
        const kaiStr = String(kai).padStart(2, "0");
        const url = `https://jra.jp/keiba/baba/archive/${year}pdf/${venueEn}${kaiStr}.pdf`;
        const tmpFile = `/tmp/baba_${venueEn}_${year}_${kaiStr}.pdf`;

        // ダウンロード
        try {
          const code = execSync(
            `curl -s -o "${tmpFile}" -w "%{http_code}" "${url}"`,
            { timeout: 20000 }
          ).toString().trim();

          if (code !== "200") {
            continue;
          }
        } catch {
          continue;
        }

        // パース
        try {
          const items = await extractPdfItems(tmpFile);
          const is2025Format = items.some((i) => i.str === "開催日次");

          let records;
          if (is2025Format) {
            records = parse2025Format(items, year, venueJa, kai);
          } else {
            records = parseLegacyFormat(items, year, venueJa, kai);
          }

          allData.push(...records);
          console.log(
            `${year} ${venueJa} ${kai}回: ${records.length} days`
          );
        } catch (err) {
          console.error(`Error parsing ${year} ${venueJa} ${kai}回: ${err.message}`);
        }
      }
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allData, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${allData.length} records)`);
}

async function extractPdfItems(file) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const allItems = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str.trim()) {
        allItems.push({
          x: Math.round(item.transform[4]),
          y: Math.round(item.transform[5]),
          str: item.str.trim(),
        });
      }
    }
  }
  return allItems;
}

// === 2025年フォーマット（縦型: 1行1日） ===
function parse2025Format(items, year, venue, kai) {
  // 開催日の行を特定: 「第 N日」がある行のy座標
  // 各行のデータ: x座標でカラム判定
  // x≈65: 開催日次, x≈142: 測定月日, x≈483: クッション値
  // x≈632: 芝含水率ゴール前, x≈710: 芝含水率4コーナー

  const sorted = items.sort((a, b) => b.y - a.y || a.x - b.x);

  // 開催日次(「第 N日」)のy座標を収集
  const dayRows = items.filter((i) => /^第\s*\d+日$/.test(i.str));
  const records = [];

  for (const dayItem of dayRows) {
    const dayNum = parseInt(dayItem.str.match(/\d+/)[0]);
    const y = dayItem.y;

    // 同じy座標（±3）のアイテムを収集
    const rowItems = items.filter((i) => Math.abs(i.y - y) <= 3);

    const dateItem = rowItems.find((i) => i.x > 100 && i.x < 200 && /\d+月/.test(i.str));
    const cushionItem = rowItems.find((i) => i.x > 450 && i.x < 520 && /^\d+\.?\d*$/.test(i.str));
    const moistGoalItem = rowItems.find((i) => i.x > 600 && i.x < 660 && /^\d+\.?\d*$/.test(i.str));
    const moistCornerItem = rowItems.find((i) => i.x > 680 && i.x < 740 && /^\d+\.?\d*$/.test(i.str));

    const dateStr = dateItem ? dateItem.str : "";
    const monthMatch = dateStr.match(/(\d+)月\s*(\d+)日/);
    const fullDate = monthMatch
      ? `${year}/${monthMatch[1].padStart(2, "0")}/${monthMatch[2].padStart(2, "0")}`
      : "";

    records.push({
      年: year,
      競馬場: venue,
      開催: kai,
      日次: dayNum,
      日付: fullDate,
      クッション値: cushionItem ? parseFloat(cushionItem.str) : null,
      芝含水率ゴール前: moistGoalItem ? parseFloat(moistGoalItem.str) : null,
      芝含水率4コーナー: moistCornerItem ? parseFloat(moistCornerItem.str) : null,
    });
  }

  return records.sort((a, b) => a.日次 - b.日次);
}

// === 2019-2024年フォーマット（横型: ブロック単位） ===
function parseLegacyFormat(items, year, venue, kai) {
  // ブロック構造:
  // 「第N日・第N+1日（YYYY年M月D日～D日）」
  // 金曜日(x≈279-315) 土曜日(x≈337-373) 日曜日(x≈395-431)
  // 芝コースクッション値 → 数値行
  // 芝コース含水率 ゴール前 → 数値行
  //                ４コーナー → 数値行

  const sorted = items.sort((a, b) => b.y - a.y || a.x - b.x);
  const records = [];

  // ブロックヘッダーを見つける
  // パターン1 (2020後半〜2024): 「第１日・第２日（2024年1月26日～28日）」
  // パターン2 (2019〜2020前半): 「第１日・第２日の含水率」+ 次行「2019年1月25日から27日の含水率」
  const blockHeaders = [];

  // パターン1
  for (const i of items) {
    const s = zenToHan(i.str);
    if (/第\s*\d+\s*日/.test(s) && /[(]\d{4}年/.test(s)) {
      blockHeaders.push({ ...i, hStr: s, format: "new" });
    }
  }

  // パターン2 (パターン1がなければ)
  if (blockHeaders.length === 0) {
    const dayHeaders = items.filter((i) => {
      const s = zenToHan(i.str);
      return /第\s*\d+\s*日/.test(s) && s.includes("含水率");
    });
    for (const dh of dayHeaders) {
      // 直下の行に日付がある
      const dateLine = items.find(
        (i) => Math.abs(i.y - (dh.y - 12)) <= 3 && /\d{4}年/.test(i.str)
      );
      if (dateLine) {
        const combined = zenToHan(dh.str) + " " + zenToHan(dateLine.str);
        blockHeaders.push({ ...dh, hStr: combined, format: "old" });
      }
    }
  }

  for (const header of blockHeaders) {
    const hStr = header.hStr;
    // 開催日次を抽出
    const dayNums = [...hStr.matchAll(/第\s*(\d+)\s*日/g)].map((m) =>
      parseInt(m[1])
    );

    // 日付範囲を抽出
    let dateMatch;
    if (header.format === "new") {
      dateMatch = hStr.match(
        /[(](\d{4})年(\d+)月(\d+)日[~](?:(\d+)月)?(\d+)日[)]/
      );
    } else {
      // "2019年1月25日から27日の含水率" or "2020年1月31日から2月2日の含水率"
      dateMatch = hStr.match(
        /(\d{4})年(\d+)月(\d+)日から(?:(\d+)月)?(\d+)日/
      );
    }
    if (!dateMatch) continue;

    const baseYear = parseInt(dateMatch[1]);
    const startMonth = parseInt(dateMatch[2]);
    const startDay = parseInt(dateMatch[3]);
    const endMonth = dateMatch[4] ? parseInt(dateMatch[4]) : startMonth;
    const endDay = parseInt(dateMatch[5]);

    // 金/土/日の日付を生成
    const dates = [];
    let m = startMonth, d = startDay;
    for (let i = 0; i <= endDay - startDay + (endMonth - startMonth) * 31; i++) {
      dates.push(
        `${baseYear}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`
      );
      d++;
      if (d > 31) { d = 1; m++; }
    }

    // ブロック内のデータ行を収集 (headerのyより下、次のブロックまで)
    const blockY = header.y;
    const nextBlockY = blockHeaders
      .filter((h) => h.y < blockY)
      .sort((a, b) => b.y - a.y)[0]?.y || 0;

    const blockItems = items.filter(
      (i) => i.y < blockY && i.y > nextBlockY
    );

    // クッション値行: 「芝コースクッション値」のy座標
    const cushionLabel = blockItems.find((i) =>
      i.str.includes("クッション値")
    );
    // 芝含水率ゴール前行
    const moistGoalLabel = blockItems.find(
      (i) => i.str === "ゴール前" && blockItems.some(
        (j) => (j.str.includes("芝コース含水率") || j.str.includes("芝コース")) && Math.abs(j.y - i.y) < 15
      )
    );
    // 芝含水率4コーナー行
    const moistCornerLabel = blockItems.find(
      (i) => /^[４4]コーナー$/.test(i.str) &&
        blockItems.some(
          (j) => j.str.includes("芝コース含水率") && Math.abs(j.y - i.y) < 27
        )
    );

    // 列のx座標: 金≈279-325, 土≈337-380, 日≈388-445
    // 旧形式(2019)は少しずれる: 金≈293, 土≈351, 日≈409
    const colRanges = [
      { label: "金", xMin: 265, xMax: 330 },
      { label: "土", xMin: 330, xMax: 390 },
      { label: "日", xMin: 390, xMax: 450 },
    ];

    function getValueAt(y, xMin, xMax) {
      const item = blockItems.find(
        (i) => Math.abs(i.y - y) <= 3 && i.x >= xMin && i.x <= xMax && /^\d+\.?\d*$/.test(i.str)
      );
      return item ? parseFloat(item.str) : null;
    }

    // 土曜=第N日, 日曜=第N+1日 (金曜は前日計測)
    // dayNums[0] → 土曜, dayNums[1] → 日曜
    const dayMapping = [
      { dayNum: dayNums[0], colIdx: 1 }, // 土曜日
    ];
    if (dayNums.length > 1) {
      dayMapping.push({ dayNum: dayNums[1], colIdx: 2 }); // 日曜日
    }

    for (const { dayNum, colIdx } of dayMapping) {
      const col = colRanges[colIdx];
      const dateIdx = colIdx; // 金=0, 土=1, 日=2
      const date = dates[dateIdx] || "";

      const cushion = cushionLabel
        ? getValueAt(cushionLabel.y, col.xMin, col.xMax)
        : null;
      const moistGoal = moistGoalLabel
        ? getValueAt(moistGoalLabel.y, col.xMin, col.xMax)
        : null;
      const moistCorner = moistCornerLabel
        ? getValueAt(moistCornerLabel.y, col.xMin, col.xMax)
        : null;

      records.push({
        年: year,
        競馬場: venue,
        開催: kai,
        日次: dayNum,
        日付: date,
        クッション値: cushion,
        芝含水率ゴール前: moistGoal,
        芝含水率4コーナー: moistCorner,
      });
    }
  }

  return records.sort((a, b) => a.日次 - b.日次);
}

main().catch(console.error);
