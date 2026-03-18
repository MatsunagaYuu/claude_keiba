const fs = require("fs");
const path = require("path");
const CALENDAR_FILE = path.join(__dirname, "..", "kaisai_calendar.json");

function main() {
  const calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
  const lastMode = process.argv.includes("--last");

  // 今日の日付 (YYYYMMDD)
  const today = new Date();
  const todayStr =
    today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0");

  if (lastMode) {
    // 直近の過去開催日群を返す
    // 今日より前の開催日を降順で取得
    const pastDates = calendar
      .filter((d) => d.date < todayStr)
      .sort((a, b) => b.date.localeCompare(a.date));

    if (pastDates.length === 0) {
      process.exit(1);
    }

    // 最新の過去開催日から同じ週末グループを取得
    const latest = pastDates[0].date;
    const group = getWeekendGroup(latest, calendar);
    for (const d of group.sort()) {
      console.log(d);
    }
  } else {
    // 今日以降の最も近い開催日群を返す
    const futureDates = calendar
      .filter((d) => d.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (futureDates.length === 0) {
      process.exit(1);
    }

    const nearest = futureDates[0].date;
    const group = getWeekendGroup(nearest, calendar);
    for (const d of group.sort()) {
      console.log(d);
    }
  }
}

// 指定日付と同じ週末（±1日以内）の開催日をグループにして返す
function getWeekendGroup(dateStr, calendar) {
  const calDates = calendar.map((d) => d.date);
  const group = [dateStr];

  // 前日・翌日をチェック（土日ペア）
  const dt = parseDate(dateStr);
  const prev = addDays(dt, -1);
  const next = addDays(dt, 1);

  const prevStr = formatDate(prev);
  const nextStr = formatDate(next);

  if (calDates.includes(prevStr)) group.push(prevStr);
  if (calDates.includes(nextStr)) group.push(nextStr);

  // 重複除去
  return [...new Set(group)];
}

function parseDate(str) {
  return new Date(
    parseInt(str.substring(0, 4)),
    parseInt(str.substring(4, 6)) - 1,
    parseInt(str.substring(6, 8))
  );
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(d) {
  return (
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

main();
