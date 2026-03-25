const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
  const { market_id, choice, amount, option_id } = req.body;
  const user_id = req.user.id;
  try {
    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [user_id]);
    const balance = parseFloat(wallet.rows[0]?.balance) || 0;
    const betAmount = parseFloat(amount) || 0;

    if (!wallet.rows[0] || balance < betAmount) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    if (betAmount <= 0) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    const market = await pool.query('SELECT * FROM markets WHERE id = $1 AND status = $2', [market_id, 'open']);
    if (!market.rows[0]) return res.status(404).json({ error: 'Mercado nao encontrado ou fechado' });

    // Validate option_id if provided
    if (option_id) {
      const opt = await pool.query('SELECT id FROM market_options WHERE id=$1 AND market_id=$2', [option_id, market_id]);
      if (!opt.rows[0]) return res.status(400).json({ error: 'Opção inválida' });
    }

    await pool.query('UPDATE wallets SET balance = COALESCE(balance, 0) - $1 WHERE user_id = $2', [betAmount, user_id]);
    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, choice, amount, option_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user_id, market_id, choice, betAmount, option_id || null]
    );
    res.status(201).json(bet.rows[0]);
  } catch (err) {
    console.error('POST /bets error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, m.question, mo.title as option_title
       FROM bets b
       JOIN markets m ON b.market_id = m.id
       LEFT JOIN market_options mo ON b.option_id = mo.id
       WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
