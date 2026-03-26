const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─ Storage factories ─
function makeStorage(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}${ext}`);
    }
  });
}
const uploadMarket = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => { fs.mkdirSync('/app/uploads/markets', { recursive: true }); cb(null, '/app/uploads/markets'); },
  filename: (req, file, cb) => { const ext = path.extname(file.originalname).toLowerCase() || '.jpg'; cb(null, `${req.params.id}_${Date.now()}${ext}`); }
}), limits: { fileSize: 5 * 1024 * 1024 } });

const uploadBranding = multer({ storage: makeStorage('/app/uploads/branding'), limits: { fileSize: 5 * 1024 * 1024 } });
const uploadBanner = multer({ storage: makeStorage('/app/uploads/banners'), limits: { fileSize: 5 * 1024 * 1024 } });

function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Acesso negado' });
  next();
}

async function auditLog(admin_id, action, before, after, ip) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (admin_id, action, before_data, after_data, ip, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [admin_id, action, JSON.stringify(before), JSON.stringify(after), ip]
    );
  } catch(e) {}
}

// ══════ MERCADOS ══════
router.get('/markets', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/markets', auth, adminOnly, async (req, res) => {
  const { question, category, yes_odds, no_odds, expires_at, image_url, type, options } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO markets (question, category, yes_odds, no_odds, expires_at, status, image_url, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [question, category || null, yes_odds || 50, no_odds || 50, expires_at || null, 'open', image_url || null, type || 'single']
    );
    const market = result.rows[0];
    if (type === 'multiple' && Array.isArray(options)) {
      for (const opt of options) {
        if (opt.title) {
          await pool.query(
            'INSERT INTO market_options (market_id, title, yes_odds, no_odds) VALUES ($1, $2, $3, $4)',
            [market.id, opt.title, opt.yes_odds || 50, opt.no_odds || 50]
          );
        }
      }
    }
    await auditLog(req.user.id, 'CREATE_MARKET', {}, market, req.ip);
    res.status(201).json(market);
  } catch (err) {
    console.error('CREATE MARKET ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/markets/:id', auth, adminOnly, async (req, res) => {
  const { question, category, yes_odds, no_odds, expires_at, status, image_url, type, options } = req.body;
  try {
    const before = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      'UPDATE markets SET question=COALESCE($1,question), category=COALESCE($2,category), yes_odds=COALESCE($3,yes_odds), no_odds=COALESCE($4,no_odds), expires_at=COALESCE($5,expires_at), status=COALESCE($6,status), image_url=COALESCE($7,image_url), type=COALESCE($8,type) WHERE id=$9 RETURNING *',
      [question, category, yes_odds, no_odds, expires_at, status, image_url || null, type, req.params.id]
    );
    if (type === 'multiple' && Array.isArray(options)) {
      await pool.query('DELETE FROM market_options WHERE market_id=$1', [req.params.id]);
      for (const opt of options) {
        if (opt.title) {
          await pool.query(
            'INSERT INTO market_options (market_id, title, yes_odds, no_odds) VALUES ($1, $2, $3, $4)',
            [req.params.id, opt.title, opt.yes_odds || 50, opt.no_odds || 50]
          );
        }
      }
    }
    await auditLog(req.user.id, 'EDIT_MARKET', before.rows[0], result.rows[0], req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/markets/:id/image', auth, adminOnly, uploadMarket.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const imageUrl = `/uploads/markets/${req.file.filename}`;
    await pool.query('UPDATE markets SET image_url=$1 WHERE id=$2', [imageUrl, req.params.id]);
    await auditLog(req.user.id, 'UPLOAD_IMAGE', {}, { id: req.params.id, image_url: imageUrl }, req.ip);
    res.json({ success: true, image_url: imageUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/markets/:id/resolve', auth, adminOnly, async (req, res) => {
  const { result } = req.body;
  try {
    const before = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE markets SET status=$1, result=$2 WHERE id=$3', ['resolved', result, req.params.id]);
    await auditLog(req.user.id, 'RESOLVE_MARKET', before.rows[0], { result, status: 'resolved' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/markets/:id/cancel', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE markets SET status=$1 WHERE id=$2', ['cancelled', req.params.id]);
    await auditLog(req.user.id, 'CANCEL_MARKET', {}, { id: req.params.id, status: 'cancelled' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ USUÁRIOS ══════
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT u.id, u.name, u.email, u.is_admin, u.is_affiliate, u.status, u.referral_code, u.created_at, COALESCE(w.balance, 0) AS balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id ORDER BY u.created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, name, email, is_admin, is_affiliate, status, referral_code, created_at FROM users WHERE id=$1', [req.params.id]);
    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.params.id]);
    const bets = await pool.query('SELECT * FROM bets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    res.json({ ...user.rows[0], balance: wallet.rows[0]?.balance || 0, bets: bets.rows, transactions: transactions.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/users/:id/balance', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT COALESCE(balance, 0) AS balance FROM wallets WHERE user_id=$1', [req.params.id]);
    res.json({ balance: result.rows[0]?.balance || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/users/:id', auth, adminOnly, async (req, res) => {
  const { name, email, status, is_affiliate } = req.body;
  try {
    const before = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const result = await pool.query(
      'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), status=COALESCE($3,status), is_affiliate=COALESCE($4,is_affiliate) WHERE id=$5 RETURNING id,name,email,status,is_affiliate',
      [name, email, status, is_affiliate !== undefined ? is_affiliate : null, req.params.id]
    );
    await auditLog(req.user.id, 'EDIT_USER', before.rows[0], result.rows[0], req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/users/:id/balance', auth, adminOnly, async (req, res) => {
  const { amount, note } = req.body;
  try {
    const before = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.params.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [req.params.id, amount]
    );
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, amount > 0 ? 'credit' : 'debit', Math.abs(amount), 'completed', note || 'Ajuste manual admin']
    );
    const after = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.params.id]);
    await auditLog(req.user.id, 'ADJUST_BALANCE', before.rows[0], { amount, note, new_balance: after.rows[0]?.balance }, req.ip);
    res.json({ success: true, new_balance: after.rows[0]?.balance });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ APOSTAS ══════
router.get('/bets', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.amount, b.choice, b.status, b.created_at,
              u.name AS user_name, u.email AS user_email,
              m.question AS market_question, m.status AS market_status,
              mo.title AS option_title,
              CASE
                WHEN b.option_id IS NOT NULL THEN
                  CASE WHEN b.choice='yes' THEN mo.yes_odds ELSE mo.no_odds END
                ELSE
                  CASE WHEN b.choice='yes' THEN m.yes_odds ELSE m.no_odds END
              END AS odds
       FROM bets b
       JOIN users u ON b.user_id = u.id
       JOIN markets m ON b.market_id = m.id
       LEFT JOIN market_options mo ON b.option_id = mo.id
       ORDER BY b.created_at DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('BETS ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ AFILIADOS ══════
router.get('/referrals', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.referral_code, u.status,
              COUNT(DISTINCT referred.id) AS total_referred,
              COALESCE(SUM(rc.amount), 0) AS total_earned
       FROM users u
       LEFT JOIN users referred ON referred.referred_by = u.referral_code
       LEFT JOIN referral_commissions rc ON rc.referrer_id = u.id
       WHERE u.referral_code IS NOT NULL
       GROUP BY u.id, u.name, u.email, u.referral_code, u.status
       ORDER BY total_referred DESC
       LIMIT 100`
    );
    // Enriquecer com taxas de comissão personalizadas
    const ratesRow = await pool.query("SELECT value FROM settings WHERE key='affiliate_commissions'");
    const rates = ratesRow.rows[0] ? JSON.parse(ratesRow.rows[0].value) : {};
    const rows = result.rows.map(r => ({ ...r, commission_rate: rates[r.id] || 0 }));
    res.json(rows);
  } catch (err) {
    console.error('REFERRALS ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH afiliado: status + taxa de comissão personalizada
router.patch('/referrals/:user_id', auth, adminOnly, async (req, res) => {
  const { status, commission_rate } = req.body;
  try {
    const before = await pool.query('SELECT id, name, email, status FROM users WHERE id=$1', [req.params.user_id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Atualiza status do usuário
    if (status !== undefined) {
      await pool.query('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.user_id]);
    }

    // Armazena taxa personalizada em settings (JSON map)
    if (commission_rate !== undefined) {
      const r = await pool.query("SELECT value FROM settings WHERE key='affiliate_commissions'");
      const rates = r.rows[0] ? JSON.parse(r.rows[0].value) : {};
      rates[req.params.user_id] = Number(commission_rate);
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ('affiliate_commissions',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
        [JSON.stringify(rates)]
      );
    }

    await auditLog(req.user.id, 'EDIT_AFFILIATE', before.rows[0], { status, commission_rate }, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH REFERRAL ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT /users/:id/balance — define saldo absoluto (admin set)
router.put('/users/:id/balance', auth, adminOnly, async (req, res) => {
  const { balance } = req.body;
  if (balance === undefined || isNaN(Number(balance))) {
    return res.status(400).json({ error: 'Saldo inválido' });
  }
  try {
    const before = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.params.id]);
    const oldBalance = Number(before.rows[0]?.balance || 0);
    const newBalance = Number(balance);
    // Upsert: define saldo diretamente
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = $2',
      [req.params.id, newBalance]
    );
    await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, 'admin_set', $2, 'completed', $3)",
      [req.params.id, Math.abs(newBalance - oldBalance), `Saldo definido manualmente: R$ ${oldBalance.toFixed(2)} → R$ ${newBalance.toFixed(2)}`]
    );
    await auditLog(req.user.id, 'SET_BALANCE', { balance: oldBalance }, { balance: newBalance }, req.ip);
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    console.error('SET BALANCE ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ TRANSAÇÕES ══════
router.get('/transactions', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ DEPÓSITOS ══════
router.get('/deposits', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type='deposit' ORDER BY t.created_at DESC LIMIT 100"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/deposits/manual', auth, adminOnly, async (req, res) => {
  const { user_id, amount, note } = req.body;
  try {
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [user_id, amount]
    );
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, 'deposit', $2, 'completed', $3) RETURNING *",
      [user_id, amount, note || 'Deposito manual admin']
    );
    await auditLog(req.user.id, 'MANUAL_DEPOSIT', {}, { user_id, amount, note }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/deposits/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const tx = await pool.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!tx.rows[0]) return res.status(404).json({ error: 'Transacao nao encontrada' });
    await pool.query("UPDATE transactions SET status='completed' WHERE id=$1", [req.params.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [tx.rows[0].user_id, tx.rows[0].amount]
    );
    await auditLog(req.user.id, 'APPROVE_DEPOSIT', tx.rows[0], { status: 'completed' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/deposits/:id/refund', auth, adminOnly, async (req, res) => {
  try {
    const tx = await pool.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!tx.rows[0]) return res.status(404).json({ error: 'Transacao nao encontrada' });
    await pool.query("UPDATE transactions SET status='refunded' WHERE id=$1", [req.params.id]);
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id=$2', [tx.rows[0].amount, tx.rows[0].user_id]);
    await auditLog(req.user.id, 'REFUND_DEPOSIT', tx.rows[0], { status: 'refunded' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ SAQUES ══════
router.get('/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type='withdrawal' ORDER BY t.created_at DESC LIMIT 100"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/withdrawals/manual', auth, adminOnly, async (req, res) => {
  const { user_id, amount, note } = req.body;
  try {
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id=$2', [amount, user_id]);
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, 'withdrawal', $2, 'completed', $3) RETURNING *",
      [user_id, amount, note || 'Saque manual admin']
    );
    await auditLog(req.user.id, 'MANUAL_WITHDRAWAL', {}, { user_id, amount, note }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const tx = await pool.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!tx.rows[0]) return res.status(404).json({ error: 'Transacao nao encontrada' });
    await pool.query("UPDATE transactions SET status='completed' WHERE id=$1", [req.params.id]);
    await auditLog(req.user.id, 'APPROVE_WITHDRAWAL', tx.rows[0], { status: 'completed' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  try {
    const tx = await pool.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!tx.rows[0]) return res.status(404).json({ error: 'Transacao nao encontrada' });
    await pool.query("UPDATE transactions SET status='rejected' WHERE id=$1", [req.params.id]);
    await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id=$2', [tx.rows[0].amount, tx.rows[0].user_id]);
    await auditLog(req.user.id, 'REJECT_WITHDRAWAL', tx.rows[0], { status: 'rejected', reason }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/withdrawals/:id/paid', auth, adminOnly, async (req, res) => {
  try {
    await pool.query("UPDATE transactions SET status='paid' WHERE id=$1", [req.params.id]);
    await auditLog(req.user.id, 'MARK_PAID_WITHDRAWAL', {}, { id: req.params.id, status: 'paid' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ CONFIGURAÇÕES ══════
router.get('/settings', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.json({ taxa_vitoria:'0.36', taxa_deposito:'2', taxa_saque:'2', saque_minimo:'10', saque_maximo:'10000', saque_diario:'50000', rollover:'1' });
  }
});

router.put('/settings', auth, adminOnly, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, value]
      );
    }
    await auditLog(req.user.id, 'EDIT_SETTINGS', {}, settings, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.patch('/settings', auth, adminOnly, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, String(value)]
      );
    }
    await auditLog(req.user.id, 'EDIT_SETTINGS', {}, settings, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Upload logo
router.post('/settings/logo', auth, adminOnly, uploadBranding.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const url = `/uploads/branding/${req.file.filename}`;
    await pool.query("INSERT INTO settings (key,value) VALUES ('logo_url',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [url]);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Upload favicon
router.post('/settings/favicon', auth, adminOnly, uploadBranding.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const url = `/uploads/branding/${req.file.filename}`;
    await pool.query("INSERT INTO settings (key,value) VALUES ('favicon_url',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [url]);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ BANNERS ══════
router.get('/banners', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='banners_list'");
    const banners = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
    res.json(banners);
  } catch (err) {
    res.json([]);
  }
});

router.post('/banners', auth, adminOnly, uploadBanner.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const url = `/uploads/banners/${req.file.filename}`;
    const r = await pool.query("SELECT value FROM settings WHERE key='banners_list'");
    const banners = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
    const newBanner = { id: Date.now(), name: req.body.name || req.file.originalname, url, active: true, created_at: new Date().toISOString() };
    banners.push(newBanner);
    await pool.query("INSERT INTO settings (key,value) VALUES ('banners_list',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(banners)]);
    res.json({ success: true, banner: newBanner });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.patch('/banners/:id', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='banners_list'");
    let banners = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
    banners = banners.map(b => String(b.id) === String(req.params.id) ? { ...b, ...req.body } : b);
    await pool.query("INSERT INTO settings (key,value) VALUES ('banners_list',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(banners)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.delete('/banners/:id', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='banners_list'");
    let banners = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
    const target = banners.find(b => String(b.id) === String(req.params.id));
    if (target) {
      const filePath = `/app${target.url}`;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    banners = banners.filter(b => String(b.id) !== String(req.params.id));
    await pool.query("INSERT INTO settings (key,value) VALUES ('banners_list',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(banners)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ AUDITORIA ══════
router.get('/audit', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT a.*, u.name, u.email FROM audit_logs a JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
