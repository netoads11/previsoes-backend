const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const logger = require('../config/logger');

async function affiliateOnly(req, res, next) {
  try {
    const u = await pool.query("SELECT role, is_affiliate FROM users WHERE id=$1", [req.user.id]);
    if (!u.rows[0]) return res.status(403).json({ error: 'Acesso negado' });
    const r = u.rows[0];
    if (r.role !== 'affiliate' && !r.is_affiliate) return res.status(403).json({ error: 'Acesso negado' });
    next();
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
}

// GET /api/affiliate/me — dados do afiliado logado
router.get('/me', auth, affiliateOnly, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT id, name, email, referral_code, role, status, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!user.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });
    const u = user.rows[0];

    if (!u.referral_code) {
      return res.json({
        ...u,
        my_commission: { cpa: 0, rev_share: 0, baseline: 0 },
        referred: [],
        stats: { total_referred: 0, total_deposits_generated: 0, total_deposits_approved: 0, total_commissions: 0 }
      });
    }

    // Configurações de comissão do afiliado (definidas pelo gerente)
    const mySettings = await pool.query(
      'SELECT cpa, rev_share, baseline FROM affiliate_settings WHERE user_id=$1',
      [req.user.id]
    );
    const myCommission = {
      cpa: Number(mySettings.rows[0]?.cpa || 0),
      rev_share: Number(mySettings.rows[0]?.rev_share || 0),
      baseline: Number(mySettings.rows[0]?.baseline || 0),
    };

    // Indicados (usuários que usaram o link do afiliado)
    const referred = await pool.query(
      `SELECT u.id, u.name, u.email, u.status, u.created_at,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit'), 0) AS total_deposited,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed'), 0) AS total_approved,
              COUNT(t.id) FILTER (WHERE t.type='deposit') AS deposit_count
       FROM users u
       LEFT JOIN transactions t ON t.user_id = u.id
       WHERE u.referred_by = $1
       GROUP BY u.id, u.name, u.email, u.status, u.created_at
       ORDER BY total_approved DESC`,
      [u.referral_code]
    );

    // Total de comissões ganhas
    const commissions = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM referral_commissions WHERE referrer_id=$1',
      [req.user.id]
    );

    const totalDepositsGenerated = referred.rows.reduce((s, r) => s + Number(r.total_deposited || 0), 0);
    const totalDepositsApproved = referred.rows.reduce((s, r) => s + Number(r.total_approved || 0), 0);
    const totalCommissions = Number(commissions.rows[0]?.total || 0);

    res.json({
      ...u,
      my_commission: myCommission,
      referred: referred.rows,
      stats: {
        total_referred: referred.rows.length,
        total_deposits_generated: totalDepositsGenerated,
        total_deposits_approved: totalDepositsApproved,
        total_commissions: totalCommissions,
      }
    });
  } catch (err) {
    logger.error('Erro em /affiliate/me', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
