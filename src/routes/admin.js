const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

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

// MERCADOS
router.post('/markets', auth, adminOnly, async (req, res) => {
  const { question, category, yes_odds, no_odds, expires_at } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO markets (question, category, yes_odds, no_odds, expires_at, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [question, category || null, yes_odds || 50, no_odds || 50, expires_at || null, 'open']
    );
    await auditLog(req.user.id, 'CREATE_MARKET', {}, result.rows[0], req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('CREATE MARKET ERROR:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/markets', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/markets/:id', auth, adminOnly, async (req, res) => {
  const { question, category, yes_odds, no_odds, expires_at, status } = req.body;
  try {
    const before = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      'UPDATE markets SET question=COALESCE($1,question), category=COALESCE($2,category), yes_odds=COALESCE($3,yes_odds), no_odds=COALESCE($4,no_odds), expires_at=COALESCE($5,expires_at), status=COALESCE($6,status) WHERE id=$7 RETURNING *',
      [question, category, yes_odds, no_odds, expires_at, status, req.params.id]
    );
    await auditLog(req.user.id, 'EDIT_MARKET', before.rows[0], result.rows[0], req.ip);
    res.json(result.rows[0]);
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

// USUARIOS
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, is_admin, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, name, email, is_admin, status, created_at FROM users WHERE id=$1', [req.params.id]);
    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.params.id]);
    const bets = await pool.query('SELECT * FROM bets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    res.json({ ...user.rows[0], balance: wallet.rows[0]?.balance || 0, bets: bets.rows, transactions: transactions.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/users/:id', auth, adminOnly, async (req, res) => {
  const { name, email, status } = req.body;
  try {
    const before = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const result = await pool.query(
      'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), status=COALESCE($3,status) WHERE id=$4 RETURNING id,name,email,status',
      [name, email, status, req.params.id]
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
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = COALESCE(wallets.balance, 0) + $2',
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

// TRANSACOES
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

// CONFIGURACOES
router.get('/settings', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.json({
      taxa_vitoria: '0.36',
      taxa_deposito: '2',
      taxa_saque: '2',
      saque_minimo: '10',
      saque_maximo: '10000',
      saque_diario: '50000',
      rollover: '1'
    });
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

// AUDIT LOG
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

// DEPOSITOS
router.get('/deposits', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type=$1 ORDER BY t.created_at DESC LIMIT 100',
      ['deposit']
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
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = COALESCE(wallets.balance, 0) + $2',
      [user_id, amount]
    );
    const result = await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user_id, 'deposit', amount, 'completed', note || 'Deposito manual admin']
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['completed', req.params.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = COALESCE(wallets.balance, 0) + $2',
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['refunded', req.params.id]);
    await pool.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id=$2',
      [tx.rows[0].amount, tx.rows[0].user_id]
    );
    await auditLog(req.user.id, 'REFUND_DEPOSIT', tx.rows[0], { status: 'refunded' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// SAQUES
router.get('/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type=$1 ORDER BY t.created_at DESC LIMIT 100',
      ['withdrawal']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/withdrawals/manual', auth, adminOnly, async (req, res) => {
  const { user_id, amount, note } = req.body;
  try {
    await pool.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id=$2',
      [amount, user_id]
    );
    const result = await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user_id, 'withdrawal', amount, 'completed', note || 'Saque manual admin']
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['completed', req.params.id]);
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['rejected', req.params.id]);
    await pool.query(
      'UPDATE wallets SET balance = COALESCE(balance, 0) + $1 WHERE user_id=$2',
      [tx.rows[0].amount, tx.rows[0].user_id]
    );
    await auditLog(req.user.id, 'REJECT_WITHDRAWAL', tx.rows[0], { status: 'rejected', reason }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/withdrawals/:id/paid', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['paid', req.params.id]);
    await auditLog(req.user.id, 'MARK_PAID_WITHDRAWAL', {}, { id: req.params.id, status: 'paid' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DEPOSITOS
router.get('/deposits', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type=$1 ORDER BY t.created_at DESC LIMIT 100',
      ['deposit']
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
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = COALESCE(wallets.balance, 0) + $2',
      [user_id, amount]
    );
    const result = await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user_id, 'deposit', amount, 'completed', note || 'Deposito manual admin']
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['completed', req.params.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = COALESCE(wallets.balance, 0) + $2',
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['refunded', req.params.id]);
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id=$2', [tx.rows[0].amount, tx.rows[0].user_id]);
    await auditLog(req.user.id, 'REFUND_DEPOSIT', tx.rows[0], { status: 'refunded' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// SAQUES
router.get('/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.type=$1 ORDER BY t.created_at DESC LIMIT 100',
      ['withdrawal']
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
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user_id, 'withdrawal', amount, 'completed', note || 'Saque manual admin']
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['completed', req.params.id]);
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
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['rejected', req.params.id]);
    await pool.query('UPDATE wallets SET balance = COALESCE(balance, 0) + $1 WHERE user_id=$2', [tx.rows[0].amount, tx.rows[0].user_id]);
    await auditLog(req.user.id, 'REJECT_WITHDRAWAL', tx.rows[0], { status: 'rejected', reason }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/withdrawals/:id/paid', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE transactions SET status=$1 WHERE id=$2', ['paid', req.params.id]);
    await auditLog(req.user.id, 'MARK_PAID_WITHDRAWAL', {}, { id: req.params.id, status: 'paid' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});
