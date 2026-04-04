/**
 * generate_market_images.js
 * Gera imagens IA via Pollinations.ai para mercados sem imagem
 * e atualiza o banco de dados.
 *
 * Uso: node scripts/generate_market_images.js [--all]
 *   --all  : reprocessa até mercados que já têm imagem
 */

require('dotenv').config();
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const pool  = require('../src/config/database');

const UPLOADS_DIR = path.join(__dirname, '../uploads/markets');
const FORCE_ALL   = process.argv.includes('--all');

// Mapa de categoria → palavras-chave visuais para o prompt
const CATEGORY_STYLE = {
  'Esportes':      'sports arena crowd stadium dynamic action',
  'Criptomoedas':  'cryptocurrency bitcoin blockchain neon digital futuristic',
  'Financeiro':    'finance stock market charts trading business',
  'Política':      'politics government election parliament debate',
  'Clima':         'weather forecast sky clouds nature environment',
  'Celebridades':  'celebrity entertainment red carpet glamour spotlight',
  'Entretenimento':'entertainment cinema music festival vibrant',
};

function buildPrompt(question, category) {
  const style = CATEGORY_STYLE[category] || 'abstract modern digital';
  // Remove pontuação excessiva e encurta
  const q = question
    .replace(/[?!]/g, '')
    .replace(/[^\w\sÀ-ú]/g, ' ')
    .trim()
    .slice(0, 80);
  return `${q}, ${style}, cinematic wide banner, high quality, no text, no watermark`;
}

function downloadImage(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const proto = url.startsWith('https') ? https : http;
    const file   = fs.createWriteStream(destPath);
    const req    = proto.get(url, { timeout: 90000 }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close(); if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return downloadImage(res.headers.location, destPath, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', e => { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadWithRetry(url, destPath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await downloadImage(url, destPath);
      return;
    } catch (e) {
      if (i < retries - 1) {
        const wait = (i + 1) * 12000;
        process.stdout.write(` [retry ${i+1} em ${wait/1000}s]`);
        await new Promise(r => setTimeout(r, wait));
      } else throw e;
    }
  }
}

async function run() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  // Pula mercados de teste/QA — só processa os reais
  const skipPattern = `AND question NOT ILIKE '%teste%'
       AND question NOT ILIKE '%test%'
       AND question NOT ILIKE '%QA%'
       AND question NOT ILIKE '%bug%'
       AND question NOT ILIKE '%edge case%'
       AND question NOT ILIKE '%regressao%'`;

  const query = FORCE_ALL
    ? `SELECT id, question, category FROM markets WHERE TRUE ${skipPattern} ORDER BY created_at DESC`
    : `SELECT id, question, category FROM markets
       WHERE (image_url IS NULL OR image_url = '' OR image_url NOT LIKE '/uploads/%')
       ${skipPattern}
       ORDER BY created_at DESC`;

  const { rows: markets } = await pool.query(query);
  console.log(`\n🖼  Gerando imagens para ${markets.length} mercado(s)...\n`);

  let ok = 0, fail = 0;

  for (const m of markets) {
    const prompt  = buildPrompt(m.question, m.category);
    const encoded = encodeURIComponent(prompt);
    const seed    = Math.floor(Math.random() * 99999);
    const imgUrl  = `https://image.pollinations.ai/prompt/${encoded}?width=1200&height=630&nologo=true&seed=${seed}`;
    const fname   = `${m.id}_ai_${Date.now()}.jpg`;
    const fpath   = path.join(UPLOADS_DIR, fname);
    const dbPath  = `/uploads/markets/${fname}`;

    process.stdout.write(`  [${ok + fail + 1}/${markets.length}] ${m.question.slice(0, 55)}... `);

    try {
      await downloadWithRetry(imgUrl, fpath);
      await pool.query('UPDATE markets SET image_url = $1 WHERE id = $2', [dbPath, m.id]);
      console.log(`✓ ${fname}`);
      ok++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      fail++;
    }

    // Pausa entre requests para não sobrecarregar Pollinations (rate limit)
    await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n✅ Concluído: ${ok} ok · ${fail} falhou\n`);
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
