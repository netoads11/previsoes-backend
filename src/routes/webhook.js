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

    // Verificar assinatura se secret estiver configurado
    if (secret) {
      const signature = req.headers['x-signature'] || req.headers['x-simplify-signature'] || '';
      const rawBody   = req.body; // Buffer graças ao express.raw()
      if (!verifyWebhook(rawBody, signature, secret)) {
        logger.warn('Webhook Simplify: assinatura inválida', { signature });
        return res.status(401).json({ error: 'Assinatura inválida' });
      }
    }

    const payload = JSON.parse(req.body.toString());
    const { event, data } = payload;
    logger.info('Webhook Simplify recebido', { event, externalId: data?.external_id });

    switch (event) {
      case 'deposit.paid': {
        // external_id = transaction_id no nosso banco
        const { external_id, amount } = data;
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
        const { external_id } = data;
        await pool.query(
          "UPDATE transactions SET status = 'cancelled' WHERE id = $1 AND type = 'deposit'",
          [external_id]
        );
        logger.info('Depósito cancelado', { external_id });
        break;
      }

      case 'withdrawal.paid': {
        const { external_id } = data;
        await pool.query(
          "UPDATE transactions SET status = 'completed', paid_at = NOW() WHERE id = $1 AND type = 'withdrawal'",
          [external_id]
        );
        logger.info('Saque confirmado', { external_id });
        break;
      }

      case 'withdrawal.cancelled': {
        // Estorna saldo do usuário
        const { external_id } = data;
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
