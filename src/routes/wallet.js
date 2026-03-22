const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

router.get('/balance', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
    if (!result.rows[0]) return res.json({ balance: 0 });
    res.json({ balance: result.rows[0].balance });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/transactions', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
