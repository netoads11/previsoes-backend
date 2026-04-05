/**
 * webhook.js
 * Rota de webhook Simplify BR — processa eventos de depósito e saque
 *
 * Eventos esperados:
 *   deposit.paid       → credita saldo do usuário
 *   deposit.cancelled  → atualiza transação para cancelled
 *   withdrawal.paid    → confirma saque
 *   withdrawal.cancelled → estorna saldo do usuário
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const logger  = require('../config/logger');
const { verifyWebhook, getCredentials } = require('../services/simplify.service');

// Webhook precisa do body raw para verificar assinatura HMAC
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const creds = await getCredentials();
    const secret = creds.simplify_webhook_secret;

    // body pode ser Buffer (express.raw) ou objeto (express.json global)
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString());
      if (secret) {
        const signature = req.headers['x-signature'] || req.headers['x-simplify-signature'] || '';
        if (!verifyWebhook(req.body, signature, secret)) {
          logger.warn('Webhook Simplify: assinatura inválida', { signature });
          return res.status(401).json({ error: 'Assinatura inválida' });
        }
      }
    } else {
      payload = req.body;
    }

    logger.info('Webhook Simplify payload completo', { payload: JSON.stringify(payload) });

    // Simplify pode mandar: { event, data } OU campos diretos no root
    const event      = payload.event      || payload.type   || payload.status;
    const externalId = payload.external_id
                    || payload.data?.external_id
                    || payload.transaction?.external_id
                    || null;
    const txAmount   = payload.amount
                    || payload.data?.amount
                    || payload.transaction?.amount
                    || null;

    logger.info('Webhook Simplify recebido', { event, externalId });

    switch (event) {
      case 'deposit.paid': {
        const external_id = externalId;
        const amount      = txAmount;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = await client.query(
            "SELECT * FROM transactions WHERE id = $1 AND type = 'deposit' AND status = 'pending'",
            [external_id]
          );
          if (!tx.rows[0]) {
            logger.warn('Webhook deposit.paid: transação não encontrada', { external_id });
            await client.query('ROLLBACK');
            break;
          }
          const { user_id, amount: txAmount } = tx.rows[0];
          await client.query(
            "UPDATE transactions SET status = 'completed', paid_at = NOW() WHERE id = $1",
            [external_id]
          );
          await client.query(
            'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
            [txAmount, user_id]
          );

          // Bônus de depósito + rollover
          const cfgQ = await client.query("SELECT key, value FROM settings WHERE key IN ('bonus_enabled','bonus_percentage','bonus_max','bonus_rollover')");
          const s = {}; cfgQ.rows.forEach(r => s[r.key] = r.value);
          if (s['bonus_enabled'] === 'true') {
            const pct  = Number(s['bonus_percentage'] || 0) / 100;
            const max  = Number(s['bonus_max'] || 0);
            const mult = Number(s['bonus_rollover'] || 1);
            let bonus  = Number(txAmount) * pct;
            if (max > 0 && bonus > max) bonus = max;
            if (bonus > 0) {
              await client.query(
                `INSERT INTO wallets (user_id, balance_bonus, rollover_required, rollover_done)
                 VALUES ($1, $2, $3, 0)
                 ON CONFLICT (user_id) DO UPDATE SET
                   balance_bonus     = COALESCE(wallets.balance_bonus, 0) + $2,
                   rollover_required = COALESCE(wallets.rollover_required, 0) + $3`,
                [user_id, bonus, Number((bonus * mult).toFixed(2))]
              );
              logger.info('Bônus aplicado via webhook', { user_id, bonus, rollover: bonus * mult });
            }
          }

          await client.query('COMMIT');
          logger.info('Depósito creditado', { user_id, amount: txAmount, external_id });
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
        break;
      }

      case 'deposit.cancelled': {
        await pool.query(
          "UPDATE transactions SET status = 'cancelled' WHERE id = $1 AND type = 'deposit'",
          [externalId]
        );
        logger.info('Depósito cancelado', { externalId });
        break;
      }

      case 'withdrawal.paid': {
        await pool.query(
          "UPDATE transactions SET status = 'completed', paid_at = NOW() WHERE id = $1 AND type = 'withdrawal'",
          [externalId]
        );
        logger.info('Saque confirmado', { externalId });
        break;
      }

      case 'withdrawal.cancelled': {
        const external_id = externalId;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = await client.query(
            "SELECT * FROM transactions WHERE id = $1 AND type = 'withdrawal' AND status = 'pending'",
            [external_id]
          );
          if (tx.rows[0]) {
            const { user_id, amount } = tx.rows[0];
            await client.query(
              "UPDATE transactions SET status = 'cancelled' WHERE id = $1",
              [external_id]
            );
            await client.query(
              'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
              [amount, user_id]
            );
          }
          await client.query('COMMIT');
          logger.info('Saque cancelado — saldo estornado', { external_id });
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
        break;
      }

      default:
        logger.info('Webhook Simplify: evento não tratado', { event });
    }

    res.json({ received: true });
  } catch (e) {
    logger.error('Erro no webhook Simplify', { error: e.message, stack: e.stack });
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
