// レースクラスの年齢×等級分類。calc_index / build_base_times / build_baba_diff_v2 など
// 指数パイプラインの各段が同じ区分を使う必要があるため、ここに一本化している。
// （かつては8スクリプトに同じ関数が複製されており、netkeibaが2026/9/5にクラスを
//   全角表記へ変えた際、どこを直せば全部に効くのかが分かりにくかった）
//
// 返す区分は base_times.json のキーおよび calc_index.js の CLASS_ANCHOR_* と対応する16種:
//   {2歳|3歳|3歳以上|4歳以上} × {新馬|未勝利|1勝|2勝|3勝|OP}
// 障害競走は平地と別体系で基準タイムを持たないため null（＝指数対象外）を返す。

// 全角英数を半角へ寄せる。netkeibaは2026/9/5開催分から「３歳以上 ５００万下」のように
// 全角で返すようになった。scraper.js 側でも書き込み時に正規化しているが、
// 取り込み済みCSVや将来の再発に備えてこちらでも受けられるようにしておく。
function toHalfWidth(s) {
  return String(s == null ? "" : s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function classifyRace(className) {
  if (!className) return null;
  className = toHalfWidth(className);
  if (className.includes("障害")) return null;

  // 年齢プレフィックスを判定
  let age;
  if (className.includes("2歳")) age = "2歳";
  else if (className.includes("4歳以上")) age = "4歳以上";
  else if (className.includes("3歳以上")) age = "3歳以上";
  else if (className.includes("3歳")) age = "3歳";
  else age = "3歳以上"; // デフォルト（リステッド等）

  // 等級を判定
  if (className.includes("新馬")) return `${age}新馬`;
  if (className.includes("未勝利")) return `${age}未勝利`;
  if (className.includes("1勝") || className.includes("500万下")) return `${age}1勝`;
  if (className.includes("2勝") || className.includes("1000万下")) return `${age}2勝`;
  if (className.includes("3勝") || className.includes("1600万下")) return `${age}3勝`;
  if (className.includes("オープン") || className.includes("OP")) return `${age}OP`;
  if (/G[1-3I]|GI|GII|GIII|リステッド|L$/.test(className)) return `${age}OP`;
  return null;
}

module.exports = { classifyRace, toHalfWidth };
