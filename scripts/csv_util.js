// CSV読み込みの共通実装。
// スクレイパーはレース名などにカンマが含まれる場合 "..." で囲んで書き出すが、
// 読み込み側が素朴な split(",") だと列がずれる（例: 浦和「ハロー,ウラワールド!特別(C1)」）。
// 列ズレは距離などが数値として読めなくなり、そのレースが黙って処理対象から落ちるため、
// 引用符を解釈するパーサーをここに一本化する。
//
// 対応: 引用フィールド、フィールド内カンマ、"" によるエスケープ。
// 非対応: フィールド内の改行（レース結果CSVには出現しないため行単位で分割している）。

function parseCSVLine(line) {
  const vals = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }  // "" はエスケープされた "
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      vals.push(cur);
      cur = "";
    } else cur += c;
  }
  vals.push(cur);
  return vals;
}

function parseCSV(content) {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => (row[h] = vals[idx] || ""));
    rows.push(row);
  }
  return rows;
}

// 書き出し側。カンマ・引用符・改行を含む値を引用符で囲む。
// 読み込み側と対にしておかないと、レース名にカンマを含むレース（浦和など）で
// 列がずれて黙って処理対象から落ちる。
function toCSVLine(values) {
  return values
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

module.exports = { parseCSV, parseCSVLine, toCSVLine };
