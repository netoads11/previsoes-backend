const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const logger = require('../config/logger');

router.post('/', auth, async (req, res) => {
  const { market_id, choice, amount } = req.body;
  const user_id = req.user.id;
  logger.info('Aposta recebida', { userId: user_id, marketId: market_id, choice, amount });
  try {
    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [user_id]);
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      logger.warn('Aposta rejeitada: saldo insuficiente', { userId: user_id, balance: wallet.rows[0]?.balance, amount });
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }
    const market = await pool.query('SELECT * FROM markets WHERE id = $1 AND status = $2', [market_id, 'open']);
    if (!market.rows[0]) {
      logger.warn('Aposta rejeitada: mercado não encontrado ou fechado', { userId: user_id, marketId: market_id });
      return res.status(404).json({ error: 'Mercado nao encontrado ou fechado' });
    }
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, user_id]);
    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, choice, amount) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, market_id, choice, amount]
    );
    logger.info('Aposta registrada', { betId: bet.rows[0].id, userId: user_id, marketId: market_id, choice, amount });
    res.status(201).json(bet.rows[0]);
  } catch (err) {
    logger.error('Erro ao registrar aposta', { userId: user_id, marketId: market_id, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT b.*, m.question FROM bets b JOIN markets m ON b.market_id = m.id WHERE b.user_id = $1 ORDER BY b.created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro ao buscar apostas do usuário', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
