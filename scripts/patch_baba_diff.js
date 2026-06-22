const fs = require("fs");
const path = require("path");

const OUTPUT_FILE = path.join(__dirname, "..", "external_baba_diff.json");

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node patch_baba_diff.js '<json>' or patch_baba_diff.js file.json");
    process.exit(1);
  }

  // 引数がファイルパスかJSON文字列かを判定
  let patches;
  if (fs.existsSync(arg)) {
    patches = JSON.parse(fs.readFileSync(arg, "utf-8"));
  } else {
    patches = JSON.parse(arg);
  }

  const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));

  // 日付+競馬場でインデックス化
  const indexMap = {};
  existing.forEach((r, i) => {
    indexMap[`${r.日付}_${r.競馬場}`] = i;
  });

  let updated = 0;
  let added = 0;

  for (const patch of patches) {
    const key = `${patch.日付}_${patch.競馬場}`;
    const idx = indexMap[key];

    if (idx === undefined) {
      // 新規エントリとして追加
      const year = parseInt(patch.日付.split('/')[0]);
      const newEntry = {
        年: year,
        競馬場: patch.競馬場,
        日付: patch.日付,
        回: null,
        日次: null,
        コース区分: null,
        芝馬場差: null,
        芝馬場差変動前: null,
        ダート馬場差: null,
        ダート馬場差変動前: null,
        芝G前含水率: null,
        芝4角含水率: null,
        クッション値: null,
        ダートG前含水率: null,
        ダート4角含水率: null,
      };
      const FIELDS = ["芝馬場差", "ダート馬場差", "芝距離別馬場差", "ダート距離別馬場差", "レース別馬場差"];
      for (const field of FIELDS) {
        if (patch[field] !== undefined) newEntry[field] = patch[field];
      }
      existing.push(newEntry);
      indexMap[key] = existing.length - 1;
      console.log(`Added: ${key}`);
      added++;
      continue;
    }

    const entry = existing[idx];
    const changes = [];

    const FIELDS = ["芝馬場差", "ダート馬場差", "芝距離別馬場差", "ダート距離別馬場差", "レース別馬場差"];
    for (const field of FIELDS) {
      if (patch[field] !== undefined) {
        const oldVal = JSON.stringify(entry[field]);
        entry[field] = patch[field];
        changes.push(`${field}: ${oldVal} → ${JSON.stringify(patch[field])}`);
      }
    }

    if (changes.length > 0) {
      console.log(`Updated: ${key}`);
      changes.forEach(c => console.log(`  ${c}`));
      updated++;
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2), "utf-8");
  console.log(`\nDone: ${updated} updated, ${added} added`);
}

main();
