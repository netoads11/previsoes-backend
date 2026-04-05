const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const logger = require('../config/logger');

router.post('/', auth, async (req, res) => {
  const { market_id, choice, amount, option_id } = req.body;
  const user_id = req.user.id;
  if (!market_id || !choice || !amount) {
    return res.status(400).json({ error: 'market_id, choice e amount são obrigatórios' });
  }
  if (choice !== 'yes' && choice !== 'no') {
    return res.status(400).json({ error: 'choice deve ser "yes" ou "no"' });
  }
  logger.info('Aposta recebida', { userId: user_id, marketId: market_id, choice, amount });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE trava a linha da carteira — impede race condition com apostas simultâneas
    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [user_id]
    );
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      await client.query('ROLLBACK');
      logger.warn('Aposta rejeitada: saldo insuficiente', { userId: user_id, balance: wallet.rows[0]?.balance, amount });
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const market = await client.query(
      `SELECT * FROM markets WHERE id = $1 AND status = 'open'
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [market_id]
    );
    if (!market.rows[0]) {
      await client.query('ROLLBACK');
      logger.warn('Aposta rejeitada: mercado não encontrado ou fechado', { userId: user_id, marketId: market_id });
      return res.status(404).json({ error: 'Mercado nao encontrado ou fechado' });
    }

    await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, user_id]);

    // Rollover: acumula valor apostado e libera bônus se completou
    const wlt = await client.query('SELECT COALESCE(balance_bonus,0) AS bonus, COALESCE(rollover_required,0) AS rr, COALESCE(rollover_done,0) AS rd FROM wallets WHERE user_id=$1', [user_id]);
    if (wlt.rows[0] && Number(wlt.rows[0].rr) > 0) {
      const newDone = Number(wlt.rows[0].rd) + Number(amount);
      const rr = Number(wlt.rows[0].rr);
      const bonus = Number(wlt.rows[0].bonus);
      if (newDone >= rr && bonus > 0) {
        // Rollover completo — transfere bônus para saldo real
        await client.query('UPDATE wallets SET rollover_done=$1, balance=balance+$2, balance_bonus=0, rollover_required=0 WHERE user_id=$3', [newDone, bonus, user_id]);
        logger.info('Rollover completo — bônus liberado', { user_id, bonus });
      } else {
        await client.query('UPDATE wallets SET rollover_done=$1 WHERE user_id=$2', [newDone, user_id]);
      }
    }

    const margin = parseFloat(market.rows[0].house_margin) || 0.05;
    let multiplier;

    if (option_id) {
      // Mercado múltiplo: multiplicador baseado nas odds da opção específica
      const opt = await client.query('SELECT * FROM market_options WHERE id = $1', [option_id]);
      if (!opt.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Opção não encontrada' });
      }
      // Recalcula pools com base nas apostas existentes + aposta atual
      const poolRes = await client.query(
        `SELECT
          COALESCE(SUM(CASE WHEN choice='yes' THEN amount ELSE 0 END), 0) AS yes_pool,
          COALESCE(SUM(CASE WHEN choice='no'  THEN amount ELSE 0 END), 0) AS no_pool
         FROM bets WHERE option_id = $1 AND status != 'cancelled'`,
        [option_id]
      );
      const yPool = parseFloat(poolRes.rows[0].yes_pool) + (choice === 'yes' ? parseFloat(amount) : 0);
      const nPool = parseFloat(poolRes.rows[0].no_pool)  + (choice === 'no'  ? parseFloat(amount) : 0);
      const total = yPool + nPool;

      // Odds parimutuel: quanto maior o volume num lado, menor a odd
      const yOdds = total > 0 && yPool > 0 ? (total / yPool) * 100 : 50;
      const nOdds = total > 0 && nPool > 0 ? (total / nPool) * 100 : 50;
      const yPct  = total > 0 ? Math.round((yPool / total) * 100) : 50;

      // Salva odds e percentuais atualizados na opção
      await client.query(
        'UPDATE market_options SET yes_odds = $1, no_odds = $2, yes_percent = $3, no_percent = $4 WHERE id = $5',
        [yOdds.toFixed(2), nOdds.toFixed(2), yPct, 100 - yPct, option_id]
      );

      // Multiplicador baseado na odd atual do lado apostado
      const optOdds = choice === 'yes' ? yOdds : nOdds;
      multiplier = Math.max((1 - margin) * 100 / optOdds, 1);
    } else {
      // Mercado simples: odds parimutuel por pool
      const poolField = choice === 'yes' ? 'yes_pool' : 'no_pool';
      const updatedMarket = await client.query(
        `UPDATE markets SET ${poolField} = ${poolField} + $1 WHERE id = $2
         RETURNING yes_pool, no_pool`,
        [amount, market_id]
      );
      const { yes_pool, no_pool } = updatedMarket.rows[0];
      const totalPool = parseFloat(yes_pool) + parseFloat(no_pool);
      const sidePool = choice === 'yes' ? parseFloat(yes_pool) : parseFloat(no_pool);
      multiplier = Math.max(totalPool > 0 && sidePool > 0 ? (totalPool * (1 - margin)) / sidePool : 1, 1);

      const yes_odds_new = totalPool > 0 ? (parseFloat(yes_pool) / totalPool) * 100 : 50;
      const no_odds_new  = totalPool > 0 ? (parseFloat(no_pool)  / totalPool) * 100 : 50;
      await client.query(
        'UPDATE markets SET yes_odds = $1, no_odds = $2 WHERE id = $3',
        [yes_odds_new.toFixed(2), no_odds_new.toFixed(2), market_id]
      );
    }

    const potential_payout = parseFloat(amount) * multiplier;

    const bet = await client.query(
      "INSERT INTO bets (user_id, market_id, choice, amount, odds, potential_payout, option_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *",
      [user_id, market_id, choice, amount, multiplier.toFixed(4), potential_payout.toFixed(2), option_id || null]
    );

    await client.query('COMMIT');
    logger.info('Aposta registrada', { betId: bet.rows[0].id, userId: user_id, marketId: market_id, choice, amount, multiplier: multiplier.toFixed(4) });
    res.status(201).json(bet.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Erro ao registrar aposta', { userId: user_id, marketId: market_id, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erro interno' });
  } finally {
    client.release();
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, m.question, m.yes_label, m.no_label, mo.title AS option_title
       FROM bets b
       JOIN markets m ON b.market_id = m.id
       LEFT JOIN market_options mo ON b.option_id = mo.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro ao buscar apostas do usuário', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
