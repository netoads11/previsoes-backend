const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const auth = require("../middleware/auth");
const logger = require("../config/logger");

router.get("/transaction/:id/status", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, status, amount FROM transactions WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Transação não encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get("/balance", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT balance, COALESCE(balance_bonus,0) AS balance_bonus, COALESCE(rollover_required,0) AS rollover_required, COALESCE(rollover_done,0) AS rollover_done FROM wallets WHERE user_id = $1",
      [req.user.id]
    );
    if (!result.rows[0]) return res.json({ balance: 0, balance_bonus: 0, rollover_required: 0, rollover_done: 0 });
    res.json({
      balance: Number(result.rows[0].balance),
      balance_bonus: Number(result.rows[0].balance_bonus),
      rollover_required: Number(result.rows[0].rollover_required),
      rollover_done: Number(result.rows[0].rollover_done),
    });
  } catch (err) {
    logger.error('Erro ao buscar saldo', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: "Erro interno" });
  }
});

router.get("/transactions", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Erro ao buscar transações', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: "Erro interno" });
  }
});

router.post("/deposit", auth, async (req, res) => {
  const { amount, cpf } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valor invalido" });
  logger.info('Solicitação de depósito', { userId: req.user.id, amount });
  try {
    // Cria transação pendente primeiro (ID vira external_id na Simplify)
    const txResult = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.user.id, "deposit", amount, "pending"]
    );
    const tx = txResult.rows[0];

    // Tenta gerar cobrança PIX real via Simplify
    try {
      const simplify = require('../services/simplify.service');
      const creds = await simplify.getCredentials();

      if (creds.simplify_active === 'true' && creds.simplify_client_id) {
        const userRow = await pool.query('SELECT name, email, cpf, phone FROM users WHERE id=$1', [req.user.id]);
        const u = userRow.rows[0] || {};
        const document = (cpf || u.cpf || '').replace(/\D/g,'');
        const phoneNum = (u.phone || '').replace(/\D/g,'');

        // Salva CPF para próximas vezes
        if (cpf && !u.cpf) {
          await pool.query('UPDATE users SET cpf=$1 WHERE id=$2', [document, req.user.id]);
        }

        const webhookBase = process.env.API_BASE_URL || 'http://ww5y7zdj6dn9y63m6zk4ec7r.187.77.248.115.sslip.io';
        const pixData = await simplify.createPixCharge({
          amount: Number(amount),
          externalId: tx.id,
          customerName: u.name || 'Cliente',
          customerDocument: document,
          customerEmail: u.email || '',
          customerPhone: phoneNum,
          webhookURL: `${webhookBase}/api/webhook/simplify`,
        });

        // Mapeia campos da resposta Simplify
        // Documentado: qrcode, internal_id, external_id, status, amount
        const qrCode    = pixData.qrcode      || pixData.qrCode  || pixData.qr_code || pixData.emv || null;
        const expiresAt = pixData.expiresAt   || pixData.expires_at || null;
        const gatewayId = pixData.internal_id || pixData.id       || pixData.deposit_id || null;

        // Gera imagem QR Code localmente a partir do código EMV
        let qrCodeImage = pixData.qrcode_image || pixData.qrCodeImage || pixData.qr_code_image || null;
        if (!qrCodeImage && qrCode) {
          try {
            const QRCode = require('qrcode');
            qrCodeImage = await QRCode.toDataURL(qrCode, { width: 300, margin: 2 });
          } catch (qrErr) {
            logger.warn('Falha ao gerar imagem QR', { error: qrErr.message });
          }
        }

        await pool.query(
          `UPDATE transactions SET qr_code=$1, qr_code_image=$2, expires_at=$3, external_id=$4
           WHERE id=$5`,
          [qrCode, qrCodeImage, expiresAt, gatewayId || tx.id, tx.id]
        );

        logger.info('Cobrança PIX gerada', { txId: tx.id, gatewayId, amount });
        return res.status(201).json({ ...tx, pix_code: qrCode, qr_code_image: qrCodeImage, expires_at: expiresAt });
      }
    } catch (gwErr) {
      // Gateway falhou — retorna transação manual (admin aprova manualmente)
      logger.warn('Simplify indisponível, depósito manual', { txId: tx.id, error: gwErr.message });
    }

    // Aplica bônus de depósito se ativo
    try {
      const cfg = await pool.query("SELECT value FROM settings WHERE key IN ('bonus_enabled','bonus_percentage','bonus_max','bonus_rollover') ORDER BY key");
      const s = {}; cfg.rows.forEach(r => s[r.key] = r.value);
      if (s['bonus_enabled'] === 'true') {
        const pct = Number(s['bonus_percentage'] || 0) / 100;
        const max = Number(s['bonus_max'] || 0);
        const mult = Number(s['bonus_rollover'] || 1);
        let bonus = amount * pct;
        if (max > 0 && bonus > max) bonus = max;
        if (bonus > 0) {
          await pool.query(
            'UPDATE wallets SET balance_bonus = COALESCE(balance_bonus,0)+$1, rollover_required = COALESCE(rollover_required,0)+$2, rollover_done = COALESCE(rollover_done,0) WHERE user_id=$3',
            [bonus, bonus * mult, req.user.id]
          );
          logger.info('Bônus aplicado', { userId: req.user.id, bonus, rollover: bonus * mult });
        }
      }
    } catch (bErr) { logger.warn('Erro ao aplicar bônus', { error: bErr.message }); }

    // Fallback: sem gateway ativo — transação pendente para aprovação manual
    logger.info('Depósito criado (manual)', { userId: req.user.id, txId: tx.id, amount });
    res.status(201).json({ ...tx, pix_code: null, qr_code_image: null });
  } catch (err) {
    logger.error('Erro ao criar depósito', { userId: req.user.id, amount, error: err.message, stack: err.stack });
    res.status(500).json({ error: "Erro interno" });
  }
});

router.post("/withdraw", auth, async (req, res) => {
  const { amount, pix_key } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valor invalido" });
  if (!pix_key) return res.status(400).json({ error: "Chave PIX obrigatoria" });
  logger.info('Solicitação de saque', { userId: req.user.id, amount, pixKey: pix_key });
  try {
    const wallet = await pool.query("SELECT balance FROM wallets WHERE user_id = $1", [req.user.id]);
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      logger.warn('Saque rejeitado: saldo insuficiente', { userId: req.user.id, balance: wallet.rows[0]?.balance, amount });
      return res.status(400).json({ error: "Saldo insuficiente" });
    }
    await pool.query("UPDATE wallets SET balance = balance - $1 WHERE user_id = $2", [amount, req.user.id]);

    // Verifica limite de saque automático do admin
    const limitRow = await pool.query("SELECT value FROM settings WHERE key='auto_withdraw_limit'");
    const autoLimit = Number(limitRow.rows[0]?.value || 0);
    const autoApprove = autoLimit > 0 && Number(amount) <= autoLimit;

    // Cria transação inicialmente como pending
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, pix_key) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, "withdrawal", amount, 'pending', pix_key]
    );
    const tx = result.rows[0];

    if (autoApprove) {
      // Tenta processar via gateway
      let gatewayOk = false;
      try {
        const simplify = require('../services/simplify.service');
        const creds = await simplify.getCredentials();
        if (creds.simplify_active === 'true' && creds.simplify_client_id) {
          const userRow = await pool.query('SELECT name, email, cpf, phone FROM users WHERE id=$1', [req.user.id]);
          const u = userRow.rows[0] || {};

          // Detecta tipo da chave PIX
          const key = pix_key.replace(/\s/g, '');
          let pixKeyType = 'random';
          if (/^\d{11}$/.test(key.replace(/\D/g,''))) pixKeyType = 'cpf';
          else if (/^\d{14}$/.test(key.replace(/\D/g,''))) pixKeyType = 'cnpj';
          else if (key.includes('@')) pixKeyType = 'email';
          else if (/^\+?\d{10,13}$/.test(key.replace(/\D/g,''))) pixKeyType = 'phone';

          const webhookBase = process.env.API_BASE_URL || 'http://ww5y7zdj6dn9y63m6zk4ec7r.187.77.248.115.sslip.io';
          await simplify.createWithdrawal({
            amount: Number(amount),
            pixKey: key,
            pixKeyType,
            recipientName: u.name || 'Cliente',
            recipientDocument: (u.cpf || '').replace(/\D/g,''),
            recipientEmail: u.email || '',
            recipientPhone: (u.phone || '').replace(/\D/g,''),
            externalId: tx.id,
            webhookURL: `${webhookBase}/api/webhook/simplify`,
          });
          gatewayOk = true;
          logger.info('Saque enviado ao gateway', { txId: tx.id, amount, pixKeyType });
        }
      } catch (gwErr) {
        logger.warn('Gateway falhou no saque automático — aguarda aprovação manual', { txId: tx.id, error: gwErr.message });
      }

      // Se gateway processou, marca como completed; se falhou, mantém pending
      const finalStatus = gatewayOk ? 'completed' : 'pending';
      await pool.query("UPDATE transactions SET status=$1 WHERE id=$2", [finalStatus, tx.id]);
      tx.status = finalStatus;
      logger.info('Saque automático', { txId: tx.id, amount, gatewayOk, finalStatus });
    } else {
      logger.info('Saque criado (aguarda aprovação manual)', { userId: req.user.id, txId: tx.id, amount });
    }

    res.status(201).json({ ...tx, auto_approved: autoApprove });
  } catch (err) {
    logger.error('Erro ao criar saque', { userId: req.user.id, amount, error: err.message, stack: err.stack });
    res.status(500).json({ error: "Erro interno" });
  }
});

router.get("/affiliate-balance", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT COALESCE(balance_affiliate,0) AS balance_affiliate FROM wallets WHERE user_id = $1", [req.user.id]);
    res.json({ balance_affiliate: Number(result.rows[0]?.balance_affiliate || 0) });
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

router.post("/affiliate-withdraw", auth, async (req, res) => {
  const { amount, pix_key } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Valor inválido" });
  if (!pix_key) return res.status(400).json({ error: "Chave PIX obrigatória" });
  const amt = Number(amount);
  try {
    const wallet = await pool.query("SELECT COALESCE(balance_affiliate,0) AS balance_affiliate FROM wallets WHERE user_id = $1", [req.user.id]);
    const available = Number(wallet.rows[0]?.balance_affiliate || 0);
    if (available < amt) return res.status(400).json({ error: "Saldo de afiliado insuficiente" });
    await pool.query("UPDATE wallets SET balance_affiliate = balance_affiliate - $1 WHERE user_id = $2", [amt, req.user.id]);
    const result = await pool.query(
      "INSERT INTO affiliate_withdrawal_requests (user_id, amount, pix_key) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, amt, pix_key]
    );
    logger.info('Saque afiliado solicitado', { userId: req.user.id, amount: amt });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('Erro ao solicitar saque afiliado', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: "Erro interno" });
  }
});


// GET /api/wallet/bonus — status do bônus/rollover
router.get("/bonus", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT COALESCE(balance_bonus,0) AS bonus, COALESCE(rollover_required,0) AS required, COALESCE(rollover_done,0) AS done FROM wallets WHERE user_id=$1",
      [req.user.id]
    );
    const w = r.rows[0] || {};
    res.json({ balance_bonus: Number(w.bonus), rollover_required: Number(w.required), rollover_done: Number(w.done) });
  } catch (err) { res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
