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
  const PUBLIC_KEYS = ['min_deposit', 'saque_minimo', 'saque_maximo'];
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

const authRoutes = require("./src/routes/auth");
const marketRoutes = require("./src/routes/markets");
const betRoutes = require("./src/routes/bets");
const walletRoutes = require("./src/routes/wallet");
const adminRoutes = require("./src/routes/admin");

// GET /api/user/referrals — dados de afiliado do usuário logado
app.get('/api/user/referrals', require('./src/middleware/auth'), async (req, res) => {
  const pool = require('./src/config/database');
  try {
    const u = await pool.query(
      'SELECT referral_code, referred_by FROM users WHERE id=$1', [req.user.id]
    );
    const user = u.rows[0];
    const stats = await pool.query(
      `SELECT COUNT(DISTINCT r.id) AS total_referred, COALESCE(SUM(rc.amount),0) AS total_earned
       FROM users r
       LEFT JOIN referral_commissions rc ON rc.referrer_id=$1
       WHERE r.referred_by=$2`, [req.user.id, user?.referral_code]
    );
    res.json({
      referral_code: user?.referral_code || null,
      referred_by: user?.referred_by || null,
      total_referred: Number(stats.rows[0]?.total_referred || 0),
      total_earned: Number(stats.rows[0]?.total_earned || 0),
    });
  } catch(e) { res.status(500).json({ error: 'Erro interno' }); }
});

app.use("/api/auth", authRoutes);
app.use("/api/markets", marketRoutes);
app.use("/api/bets", betRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Servidor rodando na porta ${PORT}`);
});

module.exports = app;
