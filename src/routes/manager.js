const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const logger = require('../config/logger');

async function managerOnly(req, res, next) {
  try {
    const u = await pool.query("SELECT role FROM users WHERE id=$1", [req.user.id]);
    if (!u.rows[0] || (u.rows[0].role !== 'manager' && u.rows[0].role !== 'admin')) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  } catch(err) { res.status(500).json({ error: 'Erro interno' }); }
}

// GET /api/manager/me — dados do gerente + afiliados da rede + stats
router.get('/me', auth, managerOnly, async (req, res) => {
  try {
    const manager = await pool.query(
      'SELECT id, name, email, referral_code, role, status, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!manager.rows[0]) return res.status(404).json({ error: 'Gerente não encontrado' });
    const m = manager.rows[0];

    // Configurações do gerente (taxa que recebe da casa)
    const mySettings = await pool.query(
      'SELECT cpa, rev_share, baseline, commission_type FROM affiliate_settings WHERE user_id=$1',
      [req.user.id]
    );
    const myCommission = {
      cpa:             Number(mySettings.rows[0]?.cpa || 0),
      rev_share:       Number(mySettings.rows[0]?.rev_share || 0),
      baseline:        Number(mySettings.rows[0]?.baseline || 0),
      commission_type: mySettings.rows[0]?.commission_type || 'rev_deposit',
    };

    // Afiliados vinculados via manager_id
    const affiliates = await pool.query(
      `SELECT u.id, u.name, u.email, u.status, u.referral_code, u.created_at,
              COALESCE(a.rev_share, 0)         AS affiliate_rev_share,
              COALESCE(a.manager_rev_share, 0) AS manager_rev_share,
              COALESCE(a.cpa, 0)               AS cpa,
              COALESCE(a.baseline, 0)          AS baseline,
              COALESCE(a.commission_type, 'rev_deposit') AS commission_type,
              COALESCE(w.balance_affiliate, 0) AS balance_affiliate,
              (SELECT COUNT(*) FROM users u2 WHERE u2.referred_by = u.referral_code) AS total_indicados,
              (SELECT COALESCE(SUM(rc.amount),0) FROM referral_commissions rc WHERE rc.referrer_id = u.id) AS total_comissoes
       FROM affiliate_settings a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE a.manager_id = $1
       ORDER BY total_comissoes DESC`,
      [req.user.id]
    );

    // Comissões do gerente (transações tipo 'commission')
    const managerEarnings = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM transactions WHERE user_id=$1 AND type='commission' AND status='completed'`,
      [req.user.id]
    );

    const totalEarnings    = Number(managerEarnings.rows[0]?.total || 0);
    const totalAffiliates  = affiliates.rows.length;
    const totalReferred    = affiliates.rows.reduce((s, a) => s + Number(a.total_indicados || 0), 0);
    const totalCommissoes  = affiliates.rows.reduce((s, a) => s + Number(a.total_comissoes || 0), 0);

    res.json({
      ...m,
      my_commission: myCommission,
      affiliates: affiliates.rows,
      stats: {
        total_affiliates:  totalAffiliates,
        total_referred:    totalReferred,
        total_commissions: totalCommissoes,
        manager_earnings:  totalEarnings,
        my_rev_share:      myCommission.rev_share,
      }
    });
  } catch (err) {
    logger.error('Erro em /manager/me', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT /api/manager/affiliates/:affiliate_id — gerente define comissão do seu afiliado
router.put('/affiliates/:affiliate_id', auth, managerOnly, async (req, res) => {
  const { rev_share } = req.body;
  if (rev_share === undefined) return res.status(400).json({ error: 'rev_share obrigatório' });
  try {
    // Verifica vínculo via manager_id
    const affRow = await pool.query(
      'SELECT manager_id, manager_rev_share FROM affiliate_settings WHERE user_id=$1',
      [req.params.affiliate_id]
    );
    if (!affRow.rows[0] || String(affRow.rows[0].manager_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Afiliado não pertence à sua rede' });
    }

    const managerRevShare = Number(affRow.rows[0].manager_rev_share || 0);
    const newRevShare = Number(rev_share);
    if (newRevShare > managerRevShare) {
      return res.status(400).json({ error: `Limite máximo: ${managerRevShare}% (sua taxa da casa)` });
    }

    await pool.query(
      'UPDATE affiliate_settings SET rev_share=$1 WHERE user_id=$2',
      [newRevShare, req.params.affiliate_id]
    );

    logger.info('Gerente atualizou comissão de afiliado', { managerId: req.user.id, affiliateId: req.params.affiliate_id, newRevShare });
    res.json({ success: true, rev_share: newRevShare });
  } catch (err) {
    logger.error('Erro ao setar comissão', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
