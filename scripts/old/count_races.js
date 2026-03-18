const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "race_result");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".csv"));
const counts = {};
for (const f of files) {
  const id = f.replace("result_", "").replace(".csv", "");
  const year = id.substring(0, 4);
  const content = fs.readFileSync(path.join(dir, f), "utf-8");
  const line2 = content.split("\n")[1];
  if (!line2) continue;
  const cols = line2.split(",");
  const venue = cols[0];
  const surface = cols[4];
  const key = venue + "_" + year;
  if (!counts[key]) counts[key] = { venue, year, total: 0, turf: 0, dirt: 0 };
  counts[key].total++;
  if (surface === "芝") counts[key].turf++;
  else counts[key].dirt++;
}
const rows = Object.values(counts).sort((a, b) => a.venue.localeCompare(b.venue) || a.year.localeCompare(b.year));
let curVenue = "";
for (const r of rows) {
  if (r.venue !== curVenue) {
    if (curVenue) console.log("");
    console.log("【" + r.venue + "】");
    console.log("  年     全体   芝   ダート");
    curVenue = r.venue;
  }
  console.log("  " + r.year + "  " + String(r.total).padStart(5) + "  " + String(r.turf).padStart(4) + "  " + String(r.dirt).padStart(4));
}
