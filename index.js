const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const logger = require("./src/config/logger");

dotenv.config();

const app = express();

// ── Middleware de log HTTP ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, {
      ip: req.ip,
      user: req.user?.id || null,
    });
  });
  next();
});

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Previsoes API rodando!" });
});

['markets','branding','banners'].forEach(d => {
  fs.mkdirSync(`/app/uploads/${d}`, { recursive: true });
});

// Servir uploads com CORS explícito (imagens acessíveis cross-origin)
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static('/app/uploads'));

// Rota pública de banners (sem auth)
app.get('/api/admin/banners/public', async (req, res) => {
  const pool = require('./src/config/database');
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='banners_list'");
    const banners = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
    res.json(banners.filter((b) => b.active));
  } catch (err) {
    logger.error('GET /api/admin/banners/public falhou', { error: err.message });
    res.json([]);
  }
});

// Rota pública de settings
app.get('/api/settings/public', async (req, res) => {
  const pool = require('./src/config/database');
  const PUBLIC_KEYS = ['min_deposit', 'saque_minimo', 'saque_maximo', 'logo_url', 'platform_name', 'taxa_deposito', 'taxa_vitoria', 'taxa_saque', 'previsao_minima'];
  try {
    const result = await pool.query(
      'SELECT key, value FROM settings WHERE key = ANY($1)',
      [PUBLIC_KEYS]
    );
    const data = {};
    result.rows.forEach(r => data[r.key] = r.value);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/settings/public falhou', { error: err.message });
    res.json({ min_deposit: '10.00' });
  }
});

// Auto-criação de tabelas auxiliares
(async () => {
  const pool = require('./src/config/database');
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_commissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID NOT NULL,
        referred_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS affiliate_withdrawal_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        reject_reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch(e) {
    logger.error('Erro ao criar tabelas auxiliares', { error: e.message });
  }
})();

const authRoutes = require("./src/routes/auth");
const marketRoutes = require("./src/routes/markets");
const betRoutes = require("./src/routes/bets");
const walletRoutes = require("./src/routes/wallet");
const adminRoutes = require("./src/routes/admin");
const managerRoutes = require("./src/routes/manager");

// GET /api/user/referrals — dados de afiliado do usuário logado
app.get('/api/user/referrals', require('./src/middleware/auth'), async (req, res) => {
  const pool = require('./src/config/database');
  try {
    let u = await pool.query(
      'SELECT referral_code, referred_by FROM users WHERE id=$1', [req.user.id]
    );
    let user = u.rows[0];
    // Gerar código se o usuário ainda não tiver um (usuários antigos)
    if (user && !user.referral_code) {
      let code = null;
      for (let i = 0; i < 5; i++) {
        const candidate = Math.random().toString(36).substring(2, 10).toUpperCase();
        const exists = await pool.query('SELECT id FROM users WHERE referral_code=$1', [candidate]);
        if (!exists.rows.length) { code = candidate; break; }
      }
      if (code) {
        await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [code, req.user.id]);
        user = { ...user, referral_code: code };
      }
    }
    const [stats, wallet] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT r.id) AS total_referred, COALESCE(SUM(rc.amount),0) AS total_earned
         FROM users r
         LEFT JOIN referral_commissions rc ON rc.referrer_id=$1
         WHERE r.referred_by=$2`, [req.user.id, user?.referral_code]
      ),
      pool.query('SELECT COALESCE(balance_affiliate,0) AS balance_affiliate FROM wallets WHERE user_id=$1', [req.user.id]),
    ]);
    res.json({
      referral_code: user?.referral_code || null,
      referred_by: user?.referred_by || null,
      total_referred: Number(stats.rows[0]?.total_referred || 0),
      total_earned: Number(stats.rows[0]?.total_earned || 0),
      balance_affiliate: Number(wallet.rows[0]?.balance_affiliate || 0),
    });
  } catch(e) { res.status(500).json({ error: 'Erro interno' }); }
});

app.use("/api/auth", authRoutes);
app.use("/api/markets", marketRoutes);
app.use("/api/bets", betRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/manager", managerRoutes);

// ── Handler global de erros não capturados ──
app.use((err, req, res, next) => {
  logger.error('Erro não tratado', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    user: req.user?.id || null,
  });
  res.status(500).json({ error: 'Erro interno' });
});

// ── Job: fecha mercados expirados a cada minuto ──
const pool = require('./src/config/database');
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE markets SET status = 'closed'
       WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= NOW()
       RETURNING id, question`
    );
    if (result.rows.length > 0) {
      result.rows.forEach(m => {
        logger.info('Mercado fechado automaticamente por expiração', { marketId: m.id, question: m.question });
      });
    }
  } catch (err) {
    logger.error('Erro no job de fechamento de mercados', { error: err.message });
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Servidor rodando na porta ${PORT}`);
});

module.exports = app;
