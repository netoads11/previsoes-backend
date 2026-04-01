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
    const market = await pool.query(
      `SELECT * FROM markets WHERE id = $1 AND status = 'open'
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [market_id]
    );
    if (!market.rows[0]) {
      logger.warn('Aposta rejeitada: mercado não encontrado ou fechado', { userId: user_id, marketId: market_id });
      return res.status(404).json({ error: 'Mercado nao encontrado ou fechado' });
    }
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, user_id]);

    // Atualiza pools e calcula odds parimutuel antes de registrar a aposta
    const poolField = choice === 'yes' ? 'yes_pool' : 'no_pool';
    const updatedMarket = await pool.query(
      `UPDATE markets SET ${poolField} = ${poolField} + $1 WHERE id = $2
       RETURNING yes_pool, no_pool, house_margin`,
      [amount, market_id]
    );
    const { yes_pool, no_pool, house_margin } = updatedMarket.rows[0];
    const totalPool = parseFloat(yes_pool) + parseFloat(no_pool);
    const margin = parseFloat(house_margin);

    // Multiplicador: quanto o jogador recebe por cada R$1 apostado (ex: 1.85x)
    // yes_multiplier = total * (1 - margin) / yes_pool
    let multiplier;
    if (choice === 'yes') {
      multiplier = totalPool > 0 && parseFloat(yes_pool) > 0
        ? (totalPool * (1 - margin)) / parseFloat(yes_pool)
        : 1;
    } else {
      multiplier = totalPool > 0 && parseFloat(no_pool) > 0
        ? (totalPool * (1 - margin)) / parseFloat(no_pool)
        : 1;
    }
    // Garante mínimo de 1x (não perde mais do que apostou)
    multiplier = Math.max(multiplier, 1);
    const potential_payout = parseFloat(amount) * multiplier;

    // Recalcula odds percentuais exibidas no mercado
    const yes_odds_new = totalPool > 0 ? (parseFloat(yes_pool) / totalPool) * 100 : 50;
    const no_odds_new  = totalPool > 0 ? (parseFloat(no_pool)  / totalPool) * 100 : 50;
    await pool.query(
      'UPDATE markets SET yes_odds = $1, no_odds = $2 WHERE id = $3',
      [yes_odds_new.toFixed(2), no_odds_new.toFixed(2), market_id]
    );

    const bet = await pool.query(
      'INSERT INTO bets (user_id, market_id, choice, amount, odds, potential_payout) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [user_id, market_id, choice, amount, multiplier.toFixed(4), potential_payout.toFixed(2)]
    );
    logger.info('Aposta registrada', { betId: bet.rows[0].id, userId: user_id, marketId: market_id, choice, amount, multiplier: multiplier.toFixed(4) });
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
