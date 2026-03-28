const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/database");
const logger = { info: console.log, warn: console.warn, error: console.error };

router.post("/register", async (req, res) => {
  const { name, email, password, ref } = req.body;
  logger.info('Tentativa de cadastro', { email });
  try {
    // Gerar referral_code único de 8 chars
    let referral_code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = Math.random().toString(36).substring(2, 10).toUpperCase();
      const exists = await pool.query("SELECT id FROM users WHERE referral_code = $1", [candidate]);
      if (!exists.rows.length) { referral_code = candidate; break; }
    }

    // Validar código de referência recebido
    let referred_by = null;
    if (ref) {
      const refUser = await pool.query("SELECT id FROM users WHERE referral_code = $1", [ref.toUpperCase()]);
      if (refUser.rows.length) referred_by = ref.toUpperCase();
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (name, email, password, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, is_admin, referral_code",
      [name, email, hash, referral_code, referred_by]
    );
    const user = result.rows[0];

    // Criar carteira automaticamente para o novo usuario
    await pool.query(
      "INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING",
      [user.id]
    );

    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, process.env.JWT_SECRET, { expiresIn: "7d" });
    logger.info('Usuário cadastrado com sucesso', { userId: user.id, email: user.email, referral_code, referred_by });
    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      logger.warn('Cadastro rejeitado: email já existe', { email });
    } else {
      logger.error('Erro ao cadastrar usuário', { email, error: err.message, stack: err.stack });
    }
    res.status(400).json({ error: "Email ja cadastrado" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  logger.info('Tentativa de login', { email });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (!result.rows[0]) {
      logger.warn('Login falhou: usuário não encontrado', { email });
      return res.status(401).json({ error: "Credenciais invalidas" });
    }
    const valid = await bcrypt.compare(password, result.rows[0].password);
    if (!valid) {
      logger.warn('Login falhou: senha incorreta', { email });
      return res.status(401).json({ error: "Credenciais invalidas" });
    }
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, process.env.JWT_SECRET, { expiresIn: "7d" });
    logger.info('Login bem-sucedido', { userId: user.id, email: user.email, isAdmin: user.is_admin });
    res.json({ user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, token });
  } catch (err) {
    logger.error('Erro no login', { email, error: err.message, stack: err.stack });
    res.status(500).json({ error: "Erro interno" });
  }
});

module.exports = router;
