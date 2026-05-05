#!/usr/bin/env node
/**
 * scripts/extract_gallop_comments.js
 *
 * gallopの競馬完全成績画像から短評・騎手・調教師コメントを抽出する
 * OCR不要 — 画像をGemini Flash Visionに直接送信
 *
 * Usage:
 *   GEMINI_API_KEY=xxx GALLOP_DIR=/path/to/gallop node scripts/extract_gallop_comments.js
 *   GEMINI_API_KEY=xxx GALLOP_DIR=/path/to/gallop node scripts/extract_gallop_comments.js --date=20260425
 *   GEMINI_API_KEY=xxx GALLOP_DIR=/path/to/gallop node scripts/extract_gallop_comments.js --resume
 *
 * 出力: docs/gallop_comments.json
 *   { "馬名": [ { date, venue, raceNum, rank, tanpyo, type, person, text } ] }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 設定 ─────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GALLOP_DIR     = process.env.GALLOP_DIR || '/Users/matsunagayu/Downloads/gallop';
const OUTPUT_FILE    = path.join(__dirname, '..', 'docs', 'gallop_comments.json');
const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// 無料枠: 15 req/min → 1画像ごとに5秒待機（安全マージン込み）
const RATE_DELAY_MS = 5000;

// ── 引数パース ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const filterDate = (args.find(a => a.startsWith('--date=')) || '').replace('--date=', '') || null;
const resumeMode = args.includes('--resume');
const debugMode  = args.includes('--debug') || !!process.env.GEMINI_DEBUG;

// ── Gemini Vision API呼び出し（1画像1コール）────────────────────────────────
async function callGeminiVision(imagePath, dateStr, venue, retries = 4) {
  const imgB64 = fs.readFileSync(imagePath).toString('base64');

  const prompt = `この画像は競馬専門紙「週刊Gallop」の競馬完全成績ページです。
日付: ${dateStr}  競馬場: ${venue}

短評・騎手コメント・調教師コメントを抽出してください。

ルール:
- 「短評」はレース全体の評価文（「NRの短評」「NRのひと言」の近辺テキスト）
- 「騎手コメント」は「○○騎手（馬名X着）」で始まる発言 → type: "jockey"
- 「調教師コメント」は「○○調教師（馬名X着）」または「○○師（馬名X着）」→ type: "trainer"
- 騎手名・調教師名は苗字のみでよい
- テキスト内の改行はスペースに置き換えること
- 広告・セール情報・血統欄は無視すること

以下のJSON形式だけ出力してください（説明文・コードブロック不要）:
[{"raceNum":"1R","tanpyo":"短評テキスト","comments":[{"horse":"馬名","rank":"1","type":"jockey","person":"騎手名","text":"コメント"}]}]

短評・コメントが見つからない場合は [] を返してください。`;

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: imgB64 } },
      { text: prompt },
    ]}],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = await res.json();
      const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      if (debugMode) {
        process.stderr.write(`\n[DEBUG] ${path.basename(imagePath)}: ${text.length}chars\n${text.substring(0, 200)}\n`);
      }
      return text;
    }

    const errText = await res.text();

    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      let waitMs = 60000;
      try {
        const errJson = JSON.parse(errText);
        const retryInfo = errJson.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
        if (retryInfo?.retryDelay) {
          waitMs = (parseInt(retryInfo.retryDelay) + 5) * 1000;
        }
      } catch (_) {}
      process.stderr.write(`\n  ${res.status} → ${waitMs / 1000}秒待機 (attempt ${attempt + 1}/${retries})...\n`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    throw new Error(`Gemini API error ${res.status}: ${errText.substring(0, 200)}`);
  }

  throw new Error('Gemini API: リトライ上限に達しました');
}

// ── JSONパース（不完全でも部分取り出し）────────────────────────────────────
function parseRacesJson(raw) {
  const cleaned = raw.replace(/^```json\s*/m, '').replace(/^```\s*$/m, '').trim();
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];

  // まず通常パース
  try { return JSON.parse(arrMatch[0]); } catch (_) {}

  // 失敗時: 完結オブジェクトを1つずつ抽出
  const races = [];
  const src = arrMatch[0];
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('{', i);
    if (start === -1) break;
    let depth = 0, j = start;
    while (j < src.length) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
      j++;
    }
    if (depth === 0) {
      try {
        const obj = JSON.parse(src.slice(start, j + 1));
        if (obj.raceNum !== undefined) races.push(obj);
      } catch (_) {}
    }
    i = start + 1;
  }
  if (races.length > 0) process.stderr.write(`\n  JSON修復: ${races.length}レース取り出し\n`);
  return races;
}

// ── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  if (!GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY 環境変数を設定してください');
    process.exit(1);
  }

  // 既存出力読み込み（resumeモード）
  let output = {};
  let processedFiles = new Set();
  if (resumeMode && fs.existsSync(OUTPUT_FILE)) {
    output = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    // 処理済みファイル名を推定（date+venue+pageで記録）
    for (const comments of Object.values(output)) {
      for (const c of comments) {
        if (c._srcFile) processedFiles.add(c._srcFile);
      }
    }
    console.log(`Resume: ${processedFiles.size}ファイル処理済み`);
  }

  // 画像ファイル一覧
  const allFiles = fs.readdirSync(GALLOP_DIR)
    .filter(f => f.endsWith('.png') && /^\d{8}/.test(f))
    .sort();

  const targets = allFiles.filter(f => {
    const m = f.match(/^(\d{8})/);
    return m && (!filterDate || m[1] === filterDate);
  });

  console.log(`処理対象: ${targets.length}ファイル`);
  if (resumeMode) console.log(`スキップ予定: ${processedFiles.size}ファイル`);

  let processed = 0;
  let skipped = 0;
  let apiCalls = 0;

  for (const file of targets) {
    if (resumeMode && processedFiles.has(file)) {
      skipped++;
      continue;
    }

    const m = file.match(/^(\d{8})(.+?)(\d+)\.png$/);
    if (!m) continue;
    const [, date, venue] = m;
    const dateStr = `${date.substring(0,4)}/${date.substring(4,6)}/${date.substring(6,8)}`;
    const imagePath = path.join(GALLOP_DIR, file);

    process.stdout.write(`[${file}] Gemini解析中...`);

    let races = [];
    try {
      const raw = await callGeminiVision(imagePath, dateStr, venue);
      races = parseRacesJson(raw);
      apiCalls++;
    } catch (e) {
      process.stderr.write(`\nエラー [${file}]: ${e.message}\n`);
    }

    let added = 0;
    for (const race of races) {
      const raceNum = String(race.raceNum || '');
      const tanpyo  = race.tanpyo || '';
      for (const c of (race.comments || [])) {
        if (!c.horse) continue;
        if (!output[c.horse]) output[c.horse] = [];
        const exists = output[c.horse].some(
          x => x.date === date && x.venue === venue && x.raceNum === raceNum && x.type === c.type
        );
        if (!exists) {
          output[c.horse].push({
            date, venue, raceNum,
            rank:   String(c.rank || ''),
            tanpyo,
            type:   c.type || '',
            person: c.person || '',
            text:   c.text || '',
            _srcFile: file,  // resumeモード用（保存時に除外可）
          });
          added++;
        }
      }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(` ${races.length}レース ${added}件追加`);
    processed++;

    // レートリミット待機
    if (processed < targets.length - skipped) {
      await new Promise(r => setTimeout(r, RATE_DELAY_MS));
    }
  }

  // _srcFile フィールドを除去してクリーンアップ
  for (const horse of Object.keys(output)) {
    output[horse] = output[horse].map(c => {
      const { _srcFile, ...rest } = c;
      return rest;
    });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  const totalHorses   = Object.keys(output).length;
  const totalComments = Object.values(output).reduce((s, a) => s + a.length, 0);

  console.log(`\n完了: ${processed}ファイル処理 (APIコール: ${apiCalls}) / ${skipped}スキップ`);
  console.log(`出力: ${OUTPUT_FILE}`);
  console.log(`  馬数: ${totalHorses} / コメント件数: ${totalComments}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
