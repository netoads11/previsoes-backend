const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../config/database");

function genReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function uniqueReferralCode() {
  let code, exists = true, attempts = 0;
  while (exists && attempts < 10) {
    code = genReferralCode();
    const r = await pool.query('SELECT id FROM users WHERE referral_code=$1', [code]);
    exists = r.rows.length > 0;
    attempts++;
  }
  return code;
}

router.post("/register", async (req, res) => {
  const { name, email, password, ref } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const referral_code = await uniqueReferralCode();

    let referred_by = null;
    if (ref) {
      const refUser = await pool.query('SELECT referral_code FROM users WHERE referral_code=$1', [ref.toUpperCase()]);
      if (refUser.rows.length > 0) referred_by = ref.toUpperCase();
    }

    const result = await pool.query(
      "INSERT INTO users (name, email, password, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, is_admin, referral_code",
      [name, email, hash, referral_code, referred_by]
    );
    const user = result.rows[0];
    await pool.query(
      "INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING",
      [user.id]
    );
    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(400).json({ error: "Email ja cadastrado" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (!result.rows[0]) return res.status(401).json({ error: "Credenciais invalidas" });
    const valid = await bcrypt.compare(password, result.rows[0].password);
    if (!valid) return res.status(401).json({ error: "Credenciais invalidas" });
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, referral_code: user.referral_code }, token });
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

module.exports = router;
