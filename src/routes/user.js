const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

// GET /api/user/referrals — user's affiliate info
router.get('/referrals', auth, async (req, res) => {
  try {
    const u = await pool.query('SELECT referral_code FROM users WHERE id=$1', [req.user.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const referral_code = u.rows[0].referral_code;

    const referred = await pool.query(
      'SELECT COUNT(*) as total FROM users WHERE referred_by=$1',
      [referral_code]
    );
    const earned = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM referral_commissions WHERE referrer_id=$1',
      [req.user.id]
    );

    res.json({
      referral_code,
      total_referred: parseInt(referred.rows[0].total),
      total_earned: parseFloat(earned.rows[0].total),
    });
  } catch (err) {
    console.error('GET /user/referrals error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/user/stats — bet statistics
router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT
        COUNT(*) as total_bets,
        COUNT(*) FILTER (WHERE status='won') as won_bets,
        COALESCE(SUM(amount), 0) as total_amount
       FROM bets WHERE user_id=$1`,
      [req.user.id]
    );
    const r = stats.rows[0];
    const total = parseInt(r.total_bets);
    const won = parseInt(r.won_bets);
    res.json({
      total_bets: total,
      won_bets: won,
      total_amount: parseFloat(r.total_amount),
      win_rate: total > 0 ? parseFloat(((won / total) * 100).toFixed(2)) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
