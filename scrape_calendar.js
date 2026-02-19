const fs = require("fs");
const { execSync } = require("child_process");

const OUTPUT_FILE = "./kaisai_calendar.json";
const DELAY_MS = 500;

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function fetchHTML(url) {
  try {
    const raw = execSync(`curl -s --max-time 20 "${url}"`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return raw.toString("utf-8");
  } catch (e) {
    console.error(`  Fetch failed: ${url}`);
    return null;
  }
}

function scrapeCalendarDates(year, month) {
  const url = `https://race.netkeiba.com/top/calendar.html?year=${year}&month=${month}`;
  const html = fetchHTML(url);
  if (!html) return [];

  const dates = [];
  const re = /kaisai_date=(\d{8})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!dates.includes(m[1])) dates.push(m[1]);
  }
  return dates;
}

function scrapeRaceListVenues(date) {
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`;
  const html = fetchHTML(url);
  if (!html) return [];

  const venues = [];
  const re = /<small>(\d+)回<\/small>\s*(.+?)\s*<small>(\d+)日目<\/small>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    venues.push({
      venue: m[2].trim(),
      kaisai: parseInt(m[1]),
      day: parseInt(m[3]),
    });
  }
  return venues;
}

function main() {
  const currentYear = new Date().getFullYear();
  let startYear = 2018;
  let endYear = currentYear;

  if (process.argv[2]) {
    const arg = parseInt(process.argv[2]);
    startYear = arg;
    endYear = process.argv[3] ? parseInt(process.argv[3]) : arg;
  }

  // 既存データを読み込み（差分更新用）
  let existing = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  }

  // 更新対象年の既存データを除外
  const keepData = existing.filter((d) => {
    const year = parseInt(d.date.substring(0, 4));
    return year < startYear || year > endYear;
  });

  const newData = [];
  for (let year = startYear; year <= endYear; year++) {
    console.log(`\n=== ${year}年 ===`);
    const allDates = [];

    for (let month = 1; month <= 12; month++) {
      const dates = scrapeCalendarDates(year, month);
      for (const d of dates) {
        if (!allDates.includes(d)) allDates.push(d);
      }
      sleep(DELAY_MS);
    }

    console.log(`  開催日数: ${allDates.length}`);
    allDates.sort();

    for (const date of allDates) {
      const venues = scrapeRaceListVenues(date);
      if (venues.length > 0) {
        newData.push({ date, venues });
        const desc = venues
          .map((v) => `${v.venue}${v.kaisai}回${v.day}日目`)
          .join(", ");
        console.log(`  ${date}: ${desc}`);
      } else {
        console.log(`  ${date}: (no venues found)`);
      }
      sleep(DELAY_MS);
    }
  }

  // マージしてソート
  const allData = [...keepData, ...newData].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allData, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT_FILE} (${allData.length} dates)`);
}

main();
