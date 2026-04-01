const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const logger = require('../config/logger');

async function managerOnly(req, res, next) {
  try {
    const u = await pool.query("SELECT role FROM users WHERE id=$1", [req.user.id]);
    if (!u.rows[0] || u.rows[0].role !== 'manager') return res.status(403).json({ error: 'Acesso negado' });
    next();
  } catch(err) { res.status(500).json({ error: 'Erro interno' }); }
}

// GET /api/manager/me — dados do gerente logado com seus afiliados
router.get('/me', auth, managerOnly, async (req, res) => {
  try {
    const manager = await pool.query(
      'SELECT id, name, email, referral_code, role, status, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!manager.rows[0]) return res.status(404).json({ error: 'Gerente não encontrado' });
    const m = manager.rows[0];

    if (!m.referral_code) return res.json({ ...m, affiliates: [], stats: { total_affiliates: 0, total_commissions: 0, total_referred: 0 } });

    // Afiliados vinculados
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
       GROUP BY u.id, u.name, u.email, u.status, u.referral_code, aff.cpa, aff.rev_share, aff.baseline
       ORDER BY total_earned DESC`,
      [m.referral_code]
    );

    const totalCommissions = affiliates.rows.reduce((s, a) => s + Number(a.total_earned || 0), 0);
    const totalReferred = affiliates.rows.reduce((s, a) => s + Number(a.total_referred || 0), 0);

    res.json({
      ...m,
      affiliates: affiliates.rows,
      stats: {
        total_affiliates: affiliates.rows.length,
        total_commissions: totalCommissions,
        total_referred: totalReferred,
      }
    });
  } catch (err) {
    logger.error('Erro em /manager/me', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT /api/manager/affiliates/:id — gerente configura comissão do seu afiliado
router.put('/affiliates/:affiliate_id', auth, managerOnly, async (req, res) => {
  const { cpa, rev_share, baseline } = req.body;
  try {
    const manager = await pool.query('SELECT referral_code FROM users WHERE id=$1', [req.user.id]);
    if (!manager.rows[0]?.referral_code) return res.status(404).json({ error: 'Gerente sem código' });

    const affiliate = await pool.query(
      'SELECT id FROM users WHERE id=$1 AND referred_by=$2',
      [req.params.affiliate_id, manager.rows[0].referral_code]
    );
    if (!affiliate.rows[0]) return res.status(404).json({ error: 'Afiliado não vinculado a você' });

    await pool.query(
      `INSERT INTO affiliate_settings (user_id, cpa, rev_share, baseline)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         cpa = COALESCE($2, affiliate_settings.cpa),
         rev_share = COALESCE($3, affiliate_settings.rev_share),
         baseline = COALESCE($4, affiliate_settings.baseline)`,
      [req.params.affiliate_id, cpa ?? null, rev_share ?? null, baseline ?? null]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro ao setar comissão', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
