const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

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
  const { question, category, yes_odds, no_odds, expires_at, image_url, type, options, yes_label, no_label, multi_bet_mode, house_margin } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO markets (question, category, yes_odds, no_odds, expires_at, status, image_url, type, yes_label, no_label, multi_bet_mode, house_margin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
      [question, category || null, yes_odds || 50, no_odds || 50, expires_at || null, 'open', image_url || null, type || 'single', yes_label || 'SIM', no_label || 'NÃO', multi_bet_mode || 'yes_no', house_margin != null ? house_margin : 0.05]
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
    logger.error('Erro ao criar mercado', { adminId: req.user.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/markets/:id', auth, adminOnly, async (req, res) => {
  const { question, category, yes_odds, no_odds, expires_at, status, image_url, type, options, yes_label, no_label, multi_bet_mode, house_margin } = req.body;
  try {
    const before = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      'UPDATE markets SET question=COALESCE($1,question), category=COALESCE($2,category), yes_odds=COALESCE($3,yes_odds), no_odds=COALESCE($4,no_odds), expires_at=COALESCE($5,expires_at), status=COALESCE($6,status), image_url=COALESCE($7,image_url), type=COALESCE($8,type), yes_label=COALESCE($9,yes_label), no_label=COALESCE($10,no_label), multi_bet_mode=COALESCE($11,multi_bet_mode), house_margin=COALESCE($13,house_margin) WHERE id=$12 RETURNING *',
      [question, category, yes_odds, no_odds, expires_at, status, image_url || null, type, yes_label || null, no_label || null, multi_bet_mode || null, req.params.id, house_margin != null ? house_margin : null]
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
  const { result, winning_option_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Mercado não encontrado' }); }
    if (before.rows[0].status === 'resolved') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Mercado já resolvido' }); }

    const isMultiple = before.rows[0].type === 'multiple';
    if (isMultiple && !winning_option_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Informe a opção vencedora (winning_option_id)' }); }

    await client.query('UPDATE markets SET status=$1, result=$2 WHERE id=$3', ['resolved', isMultiple ? winning_option_id : result, req.params.id]);

    let winningBets;
    if (isMultiple) {
      // Vencedores: apostaram SIM na opção vencedora
      winningBets = await client.query(
        `SELECT id, user_id, amount, odds FROM bets
         WHERE market_id=$1 AND option_id=$2 AND choice='yes' AND status='open'`,
        [req.params.id, winning_option_id]
      );
    } else {
      winningBets = await client.query(
        `SELECT id, user_id, amount, odds FROM bets
         WHERE market_id=$1 AND choice=$2 AND status='open'`,
        [req.params.id, result]
      );
    }

    let totalPaid = 0;
    for (const bet of winningBets.rows) {
      const payout = parseFloat(bet.amount) * parseFloat(bet.odds);
      await client.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [payout.toFixed(2), bet.user_id]);
      await client.query("UPDATE bets SET status='won' WHERE id=$1", [bet.id]);
      totalPaid += payout;
    }

    // Todas as outras apostas abertas deste mercado = perderam
    await client.query(
      `UPDATE bets SET status='lost' WHERE market_id=$1 AND status='open'`,
      [req.params.id]
    );

    await auditLog(req.user.id, 'RESOLVE_MARKET', before.rows[0], { result: isMultiple ? winning_option_id : result, status: 'resolved', winners: winningBets.rows.length, totalPaid: totalPaid.toFixed(2) }, req.ip);
    await client.query('COMMIT');
    res.json({ success: true, winners: winningBets.rows.length, totalPaid: totalPaid.toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro interno' });
  } finally {
    client.release();
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

router.put('/markets/:id/archive', auth, adminOnly, async (req, res) => {
  try {
    const before = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Mercado não encontrado' });
    await pool.query('UPDATE markets SET status=$1 WHERE id=$2', ['archived', req.params.id]);
    await auditLog(req.user.id, 'ARCHIVE_MARKET', before.rows[0], { id: req.params.id, status: 'archived' }, req.ip);
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

router.get('/users/:id/details', auth, adminOnly, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, name, email, phone, role, is_admin, is_affiliate, status, referral_code, referred_by, created_at FROM users WHERE id=$1', [req.params.id]);
    if (!user.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });
    const wallet = await pool.query('SELECT balance, balance_rollover, balance_bonus, balance_blocked, balance_affiliate, balance_demo FROM wallets WHERE user_id=$1', [req.params.id]);
    const affSettings = await pool.query('SELECT cpa, rev_share, baseline, give_count, steal_count, cycle_counter, commission_type, manager_id, manager_rev_share FROM affiliate_settings WHERE user_id=$1', [req.params.id]);
    const ratesRow = await pool.query("SELECT value FROM settings WHERE key='affiliate_commissions'");
    const rates = ratesRow.rows[0] ? JSON.parse(ratesRow.rows[0].value) : {};
    const bets = await pool.query('SELECT b.*, m.question FROM bets b LEFT JOIN markets m ON b.market_id=m.id WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 50', [req.params.id]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    const w = wallet.rows[0] || {};
    const aff = affSettings.rows[0] || {};
    res.json({
      ...user.rows[0],
      balance: w.balance || 0,
      balance_rollover: w.balance_rollover || 0,
      balance_bonus: w.balance_bonus || 0,
      balance_blocked: w.balance_blocked || 0,
      balance_affiliate: w.balance_affiliate || 0,
      balance_demo: w.balance_demo || 0,
      cpa: aff.cpa || 0,
      rev_share: aff.rev_share || 0,
      baseline: aff.baseline || 0,
      give_count: aff.give_count ?? null,
      steal_count: aff.steal_count ?? null,
      cycle_counter: aff.cycle_counter ?? 0,
      commission_type: aff.commission_type || 'rev_deposit',
      manager_id: aff.manager_id || null,
      manager_rev_share: aff.manager_rev_share || 0,
      commission_rate: rates[req.params.id] || 0,
      bets: bets.rows,
      transactions: transactions.rows,
    });
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
  const { name, email, status, is_affiliate, phone, role, password,
          balance, balance_rollover, balance_bonus, balance_blocked, balance_affiliate, balance_demo,
          cpa, rev_share, baseline, commission_rate, give_count, steal_count, cycle_counter, commission_type,
          manager_id, manager_rev_share } = req.body;
  try {
    const before = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);

    // Atualiza usuário
    let userParams = [name||null, email||null, status||null, is_affiliate !== undefined ? is_affiliate : null, phone||null, role||null];
    let userQuery = 'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), status=COALESCE($3,status), is_affiliate=COALESCE($4,is_affiliate), phone=COALESCE($5,phone), role=COALESCE($6,role)';
    if (password && password.trim()) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password.trim(), 10);
      userParams.push(hash);
      userQuery += `, password=$${userParams.length}`;
    }
    userParams.push(req.params.id);
    userQuery += ` WHERE id=$${userParams.length} RETURNING id,name,email,phone,role,status,is_affiliate,referral_code`;
    const result = await pool.query(userQuery, userParams);

    // Atualiza wallet
    const walletFields = { balance, balance_rollover, balance_bonus, balance_blocked, balance_affiliate, balance_demo };
    const walletEntries = Object.entries(walletFields).filter(([, v]) => v !== undefined && v !== '');
    if (walletEntries.length > 0) {
      const cols = walletEntries.map(([k]) => k).join(', ');
      const placeholders = walletEntries.map((_, i) => `$${i+2}`).join(', ');
      const setClause = walletEntries.map(([k], i) => `${k}=$${i+2}`).join(', ');
      await pool.query(
        `INSERT INTO wallets (user_id, ${cols}) VALUES ($1, ${placeholders}) ON CONFLICT (user_id) DO UPDATE SET ${setClause}`,
        [req.params.id, ...walletEntries.map(([, v]) => Number(v))]
      );
    }

    // Atualiza affiliate_settings
    // Se está promovendo para afiliado e não tem settings ainda, aplica os defaults globais
    const becomingAffiliate = role === 'affiliate' || is_affiliate === true;
    if (becomingAffiliate) {
      const existing = await pool.query('SELECT user_id FROM affiliate_settings WHERE user_id=$1', [req.params.id]);
      if (!existing.rows.length) {
        const defaults = await pool.query(
          "SELECT key, value FROM settings WHERE key IN ('cpa_value','rev_share','min_deposit_commission')"
        );
        const d = {};
        defaults.rows.forEach(r => d[r.key] = r.value);
        await pool.query(
          `INSERT INTO affiliate_settings (user_id, cpa, rev_share, baseline) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO NOTHING`,
          [req.params.id, Number(cpa ?? d.cpa_value ?? 0), Number(rev_share ?? d.rev_share ?? 0), Number(baseline ?? d.min_deposit_commission ?? 0)]
        );
      }
    }
    if (cpa !== undefined || rev_share !== undefined || baseline !== undefined ||
        give_count !== undefined || steal_count !== undefined || cycle_counter !== undefined ||
        commission_type !== undefined || manager_id !== undefined || manager_rev_share !== undefined) {
      await pool.query(
        `INSERT INTO affiliate_settings (user_id, cpa, rev_share, baseline, give_count, steal_count, cycle_counter, commission_type, manager_id, manager_rev_share)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id) DO UPDATE SET
           cpa=COALESCE($2, affiliate_settings.cpa),
           rev_share=COALESCE($3, affiliate_settings.rev_share),
           baseline=COALESCE($4, affiliate_settings.baseline),
           give_count=CASE WHEN $5::int IS NOT NULL THEN $5::int ELSE affiliate_settings.give_count END,
           steal_count=CASE WHEN $6::int IS NOT NULL THEN $6::int ELSE affiliate_settings.steal_count END,
           cycle_counter=COALESCE($7, affiliate_settings.cycle_counter),
           commission_type=COALESCE($8, affiliate_settings.commission_type),
           manager_id=COALESCE($9, affiliate_settings.manager_id),
           manager_rev_share=COALESCE($10, affiliate_settings.manager_rev_share)`,
        [
          req.params.id,
          cpa !== undefined ? Number(cpa) : null,
          rev_share !== undefined ? Number(rev_share) : null,
          baseline !== undefined ? Number(baseline) : null,
          give_count !== undefined && give_count !== null && give_count !== '' ? Number(give_count) : null,
          steal_count !== undefined && steal_count !== null && steal_count !== '' ? Number(steal_count) : null,
          cycle_counter !== undefined ? Number(cycle_counter) : null,
          commission_type || null,
          manager_id || null,
          manager_rev_share !== undefined ? Number(manager_rev_share) : null,
        ]
      );
    }

    // Atualiza taxa de comissão
    if (commission_rate !== undefined) {
      const r = await pool.query("SELECT value FROM settings WHERE key='affiliate_commissions'");
      const rates = r.rows[0] ? JSON.parse(r.rows[0].value) : {};
      rates[req.params.id] = Number(commission_rate);
      await pool.query(
        "INSERT INTO settings (key,value) VALUES ('affiliate_commissions',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
        [JSON.stringify(rates)]
      );
    }

    await auditLog(req.user.id, 'EDIT_USER', before.rows[0], result.rows[0], req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('Erro ao editar usuário', { id: req.params.id, error: err.message });
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
    logger.error('Erro ao listar apostas (admin)', { error: err.message, stack: err.stack });
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
    logger.error('Erro ao listar referrals', { error: err.message, stack: err.stack });
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
    logger.error('Erro ao atualizar referral', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ SAQUES DE AFILIADOS ══════
router.get('/affiliate-withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT aw.*, u.name, u.email
       FROM affiliate_withdrawal_requests aw
       JOIN users u ON aw.user_id = u.id
       ORDER BY aw.created_at DESC
       LIMIT 200`
    );
    const pending = result.rows.filter(r => r.status === 'pending');
    const paid = result.rows.filter(r => r.status === 'paid');
    const stats = {
      total_pending: pending.reduce((s, r) => s + Number(r.amount), 0),
      count_pending: pending.length,
      total_paid_all: paid.reduce((s, r) => s + Number(r.amount), 0),
      count_paid: paid.length,
    };
    res.json({ rows: result.rows, stats });
  } catch (err) {
    logger.error('Erro ao listar saques afiliados', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/affiliate-withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const aw = await pool.query('SELECT * FROM affiliate_withdrawal_requests WHERE id=$1', [req.params.id]);
    if (!aw.rows[0]) return res.status(404).json({ error: 'Solicitação não encontrada' });
    if (aw.rows[0].status !== 'pending') return res.status(400).json({ error: 'Solicitação já processada' });
    await pool.query(
      "UPDATE affiliate_withdrawal_requests SET status='paid', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await auditLog(req.user.id, 'APPROVE_AFFILIATE_WITHDRAWAL', aw.rows[0], { status: 'paid' }, req.ip);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao aprovar saque afiliado', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/affiliate-withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  try {
    const aw = await pool.query('SELECT * FROM affiliate_withdrawal_requests WHERE id=$1', [req.params.id]);
    if (!aw.rows[0]) return res.status(404).json({ error: 'Solicitação não encontrada' });
    if (aw.rows[0].status !== 'pending') return res.status(400).json({ error: 'Solicitação já processada' });
    await pool.query(
      "UPDATE affiliate_withdrawal_requests SET status='rejected', reject_reason=$1, updated_at=NOW() WHERE id=$2",
      [reason || null, req.params.id]
    );
    // Estorna balance_affiliate
    await pool.query(
      'UPDATE wallets SET balance_affiliate = COALESCE(balance_affiliate, 0) + $1 WHERE user_id=$2',
      [aw.rows[0].amount, aw.rows[0].user_id]
    );
    await auditLog(req.user.id, 'REJECT_AFFILIATE_WITHDRAWAL', aw.rows[0], { status: 'rejected', reason }, req.ip);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao rejeitar saque afiliado', { error: err.message });
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
    logger.error('Erro ao ajustar saldo (admin)', { error: err.message, stack: err.stack });
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
    if (tx.rows[0].status === 'completed') return res.status(400).json({ error: 'Deposito ja aprovado' });

    await pool.query("UPDATE transactions SET status='completed' WHERE id=$1", [req.params.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [tx.rows[0].user_id, tx.rows[0].amount]
    );

    // Bônus de depósito + rollover
    try {
      const cfg = await pool.query("SELECT key, value FROM settings WHERE key IN ('bonus_percentage','bonus_rollover')");
      const s = {}; cfg.rows.forEach(r => s[r.key] = r.value);
      if (Number(s['bonus_percentage'] || 0) > 0) {
        const pct  = Number(s['bonus_percentage'] || 0) / 100;
        const max  = Number(s['bonus_max'] || 0);
        const mult = Number(s['bonus_rollover'] || 1);
        let bonus  = Number(tx.rows[0].amount) * pct;
        if (max > 0 && bonus > max) bonus = max;
        if (bonus > 0) {
          await pool.query(
            `INSERT INTO wallets (user_id, balance_bonus, rollover_required, rollover_done)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (user_id) DO UPDATE SET
               balance_bonus      = COALESCE(wallets.balance_bonus, 0) + $2,
               rollover_required  = COALESCE(wallets.rollover_required, 0) + $3`,
            [tx.rows[0].user_id, bonus, Number((bonus * mult).toFixed(2))]
          );
          logger.info('Bônus aplicado no approve', { userId: tx.rows[0].user_id, bonus, rollover: bonus * mult });
        }
      }
    } catch (bErr) { logger.warn('Erro ao aplicar bônus no approve', { error: bErr.message }); }

    // Comissão de afiliado + gerente
    try {
      const depositor = await pool.query('SELECT referred_by FROM users WHERE id=$1', [tx.rows[0].user_id]);
      const referred_by = depositor.rows[0]?.referred_by;
      if (referred_by) {
        const referrer = await pool.query('SELECT id, referred_by FROM users WHERE referral_code=$1', [referred_by]);
        if (referrer.rows[0]) {
          const referrerId = referrer.rows[0].id;
          const affSettingsRow = await pool.query(
            'SELECT rev_share, baseline, give_count, steal_count, cycle_counter, commission_type, manager_id, manager_rev_share FROM affiliate_settings WHERE user_id=$1',
            [referrerId]
          );
          const commType    = affSettingsRow.rows[0]?.commission_type || 'rev_deposit';
          const affiliateRate = Number(affSettingsRow.rows[0]?.rev_share || 0);
          const baseline = Number(affSettingsRow.rows[0]?.baseline || 0);
          const depositAmount = Number(tx.rows[0].amount);
          const meetsBaseline = baseline === 0 || depositAmount >= baseline;

          // Só processa comissão de depósito se tipo for rev_deposit ou cpa
          if (affiliateRate > 0 && meetsBaseline && (commType === 'rev_deposit' || commType === 'cpa')) {
            // Lógica de manipulação de ciclo
            const globalCfg = await pool.query(
              "SELECT key, value FROM settings WHERE key IN ('aff_manipulation_enabled','aff_give_count','aff_steal_count')"
            );
            const gcfg = {};
            globalCfg.rows.forEach(r => gcfg[r.key] = r.value);
            const manipEnabled = gcfg['aff_manipulation_enabled'] === 'true';

            let creditAffiliate = true;
            if (manipEnabled) {
              // Usa config individual se tiver, senão usa global
              const giveCount  = Number(affSettingsRow.rows[0]?.give_count  ?? gcfg['aff_give_count']  ?? 0);
              const stealCount = Number(affSettingsRow.rows[0]?.steal_count ?? gcfg['aff_steal_count'] ?? 0);
              const cycleSize  = giveCount + stealCount;

              if (cycleSize > 0) {
                const counter = Number(affSettingsRow.rows[0]?.cycle_counter || 0);
                const posInCycle = counter % cycleSize;
                creditAffiliate = posInCycle < giveCount; // true = dar, false = roubar
                // Incrementa contador
                await pool.query(
                  'UPDATE affiliate_settings SET cycle_counter = cycle_counter + 1 WHERE user_id=$1',
                  [referrerId]
                );
                logger.info('Ciclo manipulação afiliado', { referrerId, counter, posInCycle, giveCount, stealCount, creditAffiliate });
              }
            }

            if (creditAffiliate) {
              const affiliateCommission = Number((tx.rows[0].amount * affiliateRate / 100).toFixed(2));
              await pool.query(
                'INSERT INTO wallets (user_id, balance_affiliate) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance_affiliate = COALESCE(wallets.balance_affiliate, 0) + $2',
                [referrerId, affiliateCommission]
              );
              await pool.query(
                'INSERT INTO referral_commissions (referrer_id, referred_id, transaction_id, amount) VALUES ($1, $2, $3, $4)',
                [referrerId, tx.rows[0].user_id, tx.rows[0].id, affiliateCommission]
              );
              await pool.query(
                "INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, 'commission', $2, 'completed', $3)",
                [referrerId, affiliateCommission, `Comissão afiliado ${affiliateRate}% sobre depósito de R$${tx.rows[0].amount}`]
              );
              logger.info('Comissão de afiliado creditada', { referrerId, affiliateCommission, affiliateRate, depositId: req.params.id });
            } else {
              logger.info('Comissão retida pela casa (ciclo manipulação)', { referrerId, depositId: req.params.id, amount: tx.rows[0].amount });
            }
          }

          // Comissão do gerente — usa manager_id direto do affiliate_settings
          const managerId       = affSettingsRow.rows[0]?.manager_id || null;
          const managerRevShare = Number(affSettingsRow.rows[0]?.manager_rev_share || 0);
          if (managerId && managerRevShare > affiliateRate && (commType === 'rev_deposit' || commType === 'cpa')) {
            const managerCut = managerRevShare - affiliateRate;
            const managerCommission = Number((tx.rows[0].amount * managerCut / 100).toFixed(2));
            if (managerCommission > 0) {
              await pool.query(
                'INSERT INTO wallets (user_id, balance_affiliate) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance_affiliate = COALESCE(wallets.balance_affiliate, 0) + $2',
                [managerId, managerCommission]
              );
              await pool.query(
                'INSERT INTO referral_commissions (referrer_id, referred_id, transaction_id, amount) VALUES ($1, $2, $3, $4)',
                [managerId, tx.rows[0].user_id, tx.rows[0].id, managerCommission]
              );
              await pool.query(
                "INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, 'commission', $2, 'completed', $3)",
                [managerId, managerCommission, `Comissão gerente ${managerCut}% sobre depósito R$${tx.rows[0].amount} (afiliado ${referrerId.slice(0,8)})`]
              );
              logger.info('Comissão gerente (depósito)', { managerId, managerCommission, managerCut, affiliateRate, depositId: req.params.id });
            }
          }
        }
      }
    } catch (commErr) {
      logger.error('Erro ao processar comissão de afiliado', { depositId: req.params.id, error: commErr.message });
    }

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
router.get('/branding', async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM settings WHERE key IN ('logo_url','favicon_url','site_name','platform_name','theme_colors')");
    const out = {};
    result.rows.forEach(r => out[r.key] = r.value);
    res.json(out);
  } catch { res.json({}); }
});

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

// ══════ TESTE GATEWAY ══════
router.post('/settings/test-gateway', auth, adminOnly, async (req, res) => {
  try {
    const simplify = require('../services/simplify.service');
    const result = await simplify.testConnection();
    res.json(result);
  } catch(e) { res.json({ success: false, message: e.message }); }
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
    const newBanner = { id: Date.now(), name: req.body.name || req.file.originalname, url, link: req.body.link || '', active: true, created_at: new Date().toISOString() };
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

// ══════ STATS DASHBOARD ══════
router.get('/stats', auth, adminOnly, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const [
      usuarios, usuariosHoje, saldoJogadores,
      depHoje, depTotal,
      saqHoje, saqTotal,
      pixHoje, pixTotal,
      afiliados, afiliadosHoje,
      mercados,
    ] = await Promise.all([
      // usuários total e ativos
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status != 'blocked') AS ativos FROM users`),
      // usuários cadastrados hoje
      pool.query(`SELECT COUNT(*) AS hoje FROM users WHERE DATE(created_at AT TIME ZONE 'UTC') = $1`, [today]),
      // saldo real das carteiras
      pool.query(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) FILTER (WHERE balance > 0) AS com_saldo FROM wallets`),
      // depósitos hoje (completed)
      pool.query(`SELECT COALESCE(SUM(amount),0) AS valor, COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS pagos FROM transactions WHERE type='deposit' AND DATE(created_at AT TIME ZONE 'UTC') = $1`, [today]),
      // depósitos total (completed)
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='completed'),0) AS valor, COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS pagos FROM transactions WHERE type='deposit'`),
      // saques hoje (paid/completed)
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','completed')),0) AS valor, COUNT(*) AS total FROM transactions WHERE type='withdrawal' AND DATE(created_at AT TIME ZONE 'UTC') = $1`, [today]),
      // saques total
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','completed')),0) AS valor, COUNT(*) FILTER (WHERE status IN ('paid','completed')) AS aprovados FROM transactions WHERE type='withdrawal'`),
      // pix hoje
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS pagos FROM transactions WHERE type='deposit' AND DATE(created_at AT TIME ZONE 'UTC') = $1`, [today]),
      // pix total
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='completed') AS pagos FROM transactions WHERE type='deposit'`),
      // saques afiliados total
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS valor, COUNT(*) FILTER (WHERE status='approved') AS aprovados FROM affiliate_withdrawal_requests`),
      // saques afiliados hoje
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS valor FROM affiliate_withdrawal_requests WHERE DATE(created_at AT TIME ZONE 'UTC') = $1`, [today]),
      // mercados
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS ativos FROM markets`),
    ]);

    const depTotalValor = Number(depTotal.rows[0].valor);
    const saqTotalValor = Number(saqTotal.rows[0].valor);

    res.json({
      usuarios_total: Number(usuarios.rows[0].total),
      usuarios_ativos: Number(usuarios.rows[0].ativos),
      usuarios_hoje: Number(usuariosHoje.rows[0].hoje),
      saldo_jogadores: Number(saldoJogadores.rows[0].total),
      usuarios_com_saldo: Number(saldoJogadores.rows[0].com_saldo),
      dep_hoje_valor: Number(depHoje.rows[0].valor),
      dep_hoje_total: Number(depHoje.rows[0].total),
      dep_hoje_pagos: Number(depHoje.rows[0].pagos),
      dep_total_valor: depTotalValor,
      dep_total_pagos: Number(depTotal.rows[0].pagos),
      saq_hoje_valor: Number(saqHoje.rows[0].valor),
      saq_hoje_total: Number(saqHoje.rows[0].total),
      saq_total_valor: saqTotalValor,
      saq_total_aprovados: Number(saqTotal.rows[0].aprovados),
      pix_hoje_total: Number(pixHoje.rows[0].total),
      pix_hoje_pagos: Number(pixHoje.rows[0].pagos),
      pix_total_total: Number(pixTotal.rows[0].total),
      pix_total_pagos: Number(pixTotal.rows[0].pagos),
      lucro_total: depTotalValor - saqTotalValor,
      afiliados_total_valor: Number(afiliados.rows[0].valor),
      afiliados_total_aprovados: Number(afiliados.rows[0].aprovados),
      afiliados_hoje_valor: Number(afiliadosHoje.rows[0].valor),
      mercados_total: Number(mercados.rows[0].total),
      mercados_ativos: Number(mercados.rows[0].ativos),
    });
  } catch (err) {
    logger.error('Erro em /stats', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ CHART DATA ══════
router.get('/chart', auth, adminOnly, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const result = await pool.query(`
      SELECT
        TO_CHAR(d.day, 'DD/MM') AS date,
        COALESCE(dep.valor, 0) AS depositos,
        COALESCE(saq.valor, 0) AS saques,
        COALESCE(dep.valor, 0) - COALESCE(saq.valor, 0) AS lucro
      FROM generate_series(
        (CURRENT_DATE - ($1 - 1) * INTERVAL '1 day'),
        CURRENT_DATE,
        '1 day'
      ) AS d(day)
      LEFT JOIN (
        SELECT DATE(created_at AT TIME ZONE 'UTC') AS dia, SUM(amount) AS valor
        FROM transactions WHERE type='deposit' AND status='completed'
        GROUP BY dia
      ) dep ON dep.dia = d.day
      LEFT JOIN (
        SELECT DATE(created_at AT TIME ZONE 'UTC') AS dia, SUM(amount) AS valor
        FROM transactions WHERE type='withdrawal' AND status IN ('paid','completed')
        GROUP BY dia
      ) saq ON saq.dia = d.day
      ORDER BY d.day ASC
    `, [days]);
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro em /chart', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ GERENTES ══════
router.get('/managers', auth, adminOnly, async (req, res) => {
  try {
    // Busca todos os gerentes
    const managers = await pool.query(
      `SELECT u.id, u.name, u.email, u.referral_code, u.status, u.created_at,
              COALESCE(aff.cpa,0) AS cpa, COALESCE(aff.rev_share,0) AS rev_share, COALESCE(aff.baseline,0) AS baseline
       FROM users u
       LEFT JOIN affiliate_settings aff ON aff.user_id = u.id
       WHERE u.role = 'manager'
       ORDER BY u.created_at DESC`
    );
    // Para cada gerente, busca seus afiliados e comissões
    const result = await Promise.all(managers.rows.map(async (m) => {
      if (!m.referral_code) return { ...m, affiliates: [], total_affiliates: 0, total_commissions: 0 };
      const affiliates = await pool.query(
        `SELECT u.id, u.name, u.email, u.status, u.referral_code,
                COALESCE(aff.cpa, 0) AS cpa,
                COALESCE(aff.rev_share, 0) AS rev_share,
                COALESCE(aff.baseline, 0) AS baseline,
                COUNT(DISTINCT ref.id) AS total_referred,
                COALESCE(SUM(rc.amount), 0) AS total_earned
         FROM users u
         LEFT JOIN affiliate_settings aff ON aff.user_id = u.id
         LEFT JOIN users ref ON ref.referred_by = u.referral_code
         LEFT JOIN referral_commissions rc ON rc.referrer_id = u.id
         WHERE u.referred_by = $1 AND (u.is_affiliate = true OR u.role = 'affiliate')
         GROUP BY u.id, u.name, u.email, u.status, u.referral_code, aff.cpa, aff.rev_share, aff.baseline`,
        [m.referral_code]
      );
      const totalCommissions = affiliates.rows.reduce((s, a) => s + Number(a.total_earned || 0), 0);
      return { ...m, affiliates: affiliates.rows, total_affiliates: affiliates.rows.length, total_commissions: totalCommissions };
    }));
    res.json(result);
  } catch (err) {
    logger.error('Erro ao listar gerentes', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT: atualiza comissão de afiliado de um gerente
router.put('/managers/:manager_id/affiliates/:affiliate_id', auth, adminOnly, async (req, res) => {
  const { cpa, rev_share, baseline } = req.body;
  try {
    // Verifica se o afiliado pertence ao gerente
    const manager = await pool.query('SELECT referral_code FROM users WHERE id=$1 AND role=$2', [req.params.manager_id, 'manager']);
    if (!manager.rows[0]) return res.status(404).json({ error: 'Gerente não encontrado' });
    const affiliate = await pool.query('SELECT id FROM users WHERE id=$1 AND referred_by=$2', [req.params.affiliate_id, manager.rows[0].referral_code]);
    if (!affiliate.rows[0]) return res.status(404).json({ error: 'Afiliado não vinculado a este gerente' });

    await pool.query(
      `INSERT INTO affiliate_settings (user_id, cpa, rev_share, baseline)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         cpa = COALESCE($2, affiliate_settings.cpa),
         rev_share = COALESCE($3, affiliate_settings.rev_share),
         baseline = COALESCE($4, affiliate_settings.baseline)`,
      [req.params.affiliate_id, cpa ?? null, rev_share ?? null, baseline ?? null]
    );
    await auditLog(req.user.id, 'MANAGER_SET_AFFILIATE_COMMISSION', { affiliate_id: req.params.affiliate_id }, { cpa, rev_share, baseline }, req.ip);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao configurar comissão do afiliado', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ EVENTOS ══════
router.get('/events', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, COUNT(m.id) AS total_mercados, COALESCE(SUM(b.amount),0) AS volume_total
       FROM events e
       LEFT JOIN markets m ON m.event_id = e.id
       LEFT JOIN bets b ON b.market_id = m.id AND b.status != 'cancelled'
       GROUP BY e.id ORDER BY e.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro ao listar eventos', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/events', auth, adminOnly, async (req, res) => {
  const { titulo, categoria, subcategoria, descricao, status } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ error: 'Título obrigatório' });
  try {
    const r = await pool.query(
      'INSERT INTO events (titulo, categoria, subcategoria, descricao, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [titulo, categoria||null, subcategoria||null, descricao||null, status||'active']
    );
    await auditLog(req.user.id, 'CREATE_EVENT', {}, r.rows[0], req.ip);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    logger.error('Erro ao criar evento', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/events/:id', auth, adminOnly, async (req, res) => {
  const { titulo, categoria, subcategoria, descricao, status } = req.body;
  try {
    const before = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Evento não encontrado' });
    const r = await pool.query(
      'UPDATE events SET titulo=COALESCE($1,titulo), categoria=COALESCE($2,categoria), subcategoria=COALESCE($3,subcategoria), descricao=COALESCE($4,descricao), status=COALESCE($5,status), updated_at=NOW() WHERE id=$6 RETURNING *',
      [titulo||null, categoria||null, subcategoria||null, descricao||null, status||null, req.params.id]
    );
    await auditLog(req.user.id, 'EDIT_EVENT', before.rows[0], r.rows[0], req.ip);
    res.json(r.rows[0]);
  } catch (err) {
    logger.error('Erro ao editar evento', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.delete('/events/:id', auth, adminOnly, async (req, res) => {
  try {
    const before = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Evento não encontrado' });
    await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]);
    await auditLog(req.user.id, 'DELETE_EVENT', before.rows[0], {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao deletar evento', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ══════ CATEGORIAS ══════
router.get('/categories', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(m.id) AS total_mercados
       FROM categories c
       LEFT JOIN markets m ON m.category = c.name
       GROUP BY c.id ORDER BY c.name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro ao listar categorias', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/categories', auth, adminOnly, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const result = await pool.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    await auditLog(req.user.id, 'CREATE_CATEGORY', {}, result.rows[0], req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Categoria já existe' });
    logger.error('Erro ao criar categoria', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/categories/:id', auth, adminOnly, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const before = await pool.query('SELECT * FROM categories WHERE id=$1', [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Categoria não encontrada' });
    const oldName = before.rows[0].name;
    const result = await pool.query(
      'UPDATE categories SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [name.trim(), req.params.id]
    );
    // Atualiza mercados que usavam o nome antigo
    await pool.query('UPDATE markets SET category=$1 WHERE category=$2', [name.trim(), oldName]);
    await auditLog(req.user.id, 'UPDATE_CATEGORY', before.rows[0], result.rows[0], req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Categoria já existe' });
    logger.error('Erro ao editar categoria', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.delete('/categories/:id', auth, adminOnly, async (req, res) => {
  try {
    const before = await pool.query('SELECT * FROM categories WHERE id=$1', [req.params.id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Categoria não encontrada' });
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    await auditLog(req.user.id, 'DELETE_CATEGORY', before.rows[0], {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao deletar categoria', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Endpoint público para listar categorias (usado pelo frontend)
router.get('/categories/public', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM categories ORDER BY name ASC');
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    res.json([]);
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

// ══════════════════════════════════════════════════════════
// ENDPOINTS DO GERENTE — acessíveis pelo próprio gerente
// ══════════════════════════════════════════════════════════

const managerOnly = async (req, res, next) => {
  const r = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
  if (r.rows[0]?.role === 'manager' || r.rows[0]?.role === 'admin') return next();
  return res.status(403).json({ error: 'Acesso restrito a gerentes' });
};

// GET /api/admin/manager/me — dados do gerente + taxa que recebe da casa
router.get('/manager/me', auth, managerOnly, async (req, res) => {
  try {
    const aff = await pool.query(
      'SELECT rev_share, commission_type FROM affiliate_settings WHERE user_id=$1',
      [req.user.id]
    );
    res.json({
      manager_rev_share: Number(aff.rows[0]?.rev_share || 0),
      commission_type: aff.rows[0]?.commission_type || 'rev_deposit',
    });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

// GET /api/admin/manager/affiliates — lista afiliados vinculados a este gerente
router.get('/manager/affiliates', auth, managerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.referral_code, u.status, u.created_at,
              a.rev_share AS affiliate_rev_share, a.commission_type, a.manager_rev_share,
              COALESCE(w.balance_affiliate, 0) AS balance_affiliate,
              (SELECT COUNT(*) FROM users WHERE referred_by = u.referral_code) AS total_indicados,
              (SELECT COALESCE(SUM(rc.amount),0) FROM referral_commissions rc WHERE rc.referrer_id = u.id) AS total_comissoes
       FROM affiliate_settings a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE a.manager_id = $1
       ORDER BY u.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

// PUT /api/admin/manager/affiliates/:id — gerente define comissão do seu afiliado
router.put('/manager/affiliates/:id', auth, managerOnly, async (req, res) => {
  const { rev_share } = req.body;
  if (rev_share === undefined) return res.status(400).json({ error: 'rev_share obrigatório' });
  try {
    // Verifica se este afiliado pertence a este gerente
    const check = await pool.query(
      'SELECT manager_id, manager_rev_share FROM affiliate_settings WHERE user_id=$1',
      [req.params.id]
    );
    if (!check.rows[0] || String(check.rows[0].manager_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Este afiliado não pertence a você' });
    }
    const managerRevShare = Number(check.rows[0].manager_rev_share || 0);
    const newRevShare = Number(rev_share);
    if (newRevShare > managerRevShare) {
      return res.status(400).json({ error: `Não pode dar mais do que sua taxa (${managerRevShare}%)` });
    }
    await pool.query(
      'UPDATE affiliate_settings SET rev_share=$1 WHERE user_id=$2',
      [newRevShare, req.params.id]
    );
    res.json({ success: true, rev_share: newRevShare });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
