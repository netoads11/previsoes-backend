const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const auth = require("../middleware/auth");
const logger = require("../config/logger");

router.get("/balance", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT balance FROM wallets WHERE user_id = $1", [req.user.id]);
    if (!result.rows[0]) return res.json({ balance: 0 });
    res.json({ balance: result.rows[0].balance });
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
  const { amount, pix_key } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valor invalido" });
  logger.info('Solicitação de depósito', { userId: req.user.id, amount });
  try {
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, pix_key) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, "deposit", amount, "pending", pix_key || null]
    );
    logger.info('Depósito criado', { userId: req.user.id, txId: result.rows[0].id, amount });
    res.status(201).json(result.rows[0]);
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
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, pix_key) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, "withdrawal", amount, "pending", pix_key]
    );
    logger.info('Saque criado', { userId: req.user.id, txId: result.rows[0].id, amount });
    res.status(201).json(result.rows[0]);
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

module.exports = router;
