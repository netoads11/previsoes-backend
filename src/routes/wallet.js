const express = require("express");
const router = express.Router();
const pool = require("../config/database");
const auth = require("../middleware/auth");

router.get("/balance", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT COALESCE(balance, 0) as balance FROM wallets WHERE user_id = $1", [req.user.id]);
    if (!result.rows[0]) return res.json({ balance: 0 });
    res.json({ balance: parseFloat(result.rows[0].balance) || 0 });
  } catch (err) {
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
    res.status(500).json({ error: "Erro interno" });
  }
});

// Solicitar deposito (usuario informa chave PIX e valor)
router.post("/deposit", auth, async (req, res) => {
  const { amount, pix_key } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valor invalido" });
  try {
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, pix_key) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, "deposit", amount, "pending", pix_key || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

// Solicitar saque (usuario informa chave PIX e valor)
router.post("/withdraw", auth, async (req, res) => {
  const { amount, pix_key } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valor invalido" });
  if (!pix_key) return res.status(400).json({ error: "Chave PIX obrigatoria" });
  try {
    const wallet = await pool.query("SELECT COALESCE(balance, 0) as balance FROM wallets WHERE user_id = $1", [req.user.id]);
    if (!wallet.rows[0] || parseFloat(wallet.rows[0].balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }
    // Reservar saldo
    await pool.query("UPDATE wallets SET balance = balance - $1 WHERE user_id = $2", [amount, req.user.id]);
    const result = await pool.query(
      "INSERT INTO transactions (user_id, type, amount, status, pix_key) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [req.user.id, "withdrawal", amount, "pending", pix_key]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

module.exports = router;
