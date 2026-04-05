const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/chat/:marketId — últimas 60 mensagens
router.get('/:marketId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cm.id, cm.username, cm.message, cm.created_at
       FROM chat_messages cm
       WHERE cm.market_id = $1
       ORDER BY cm.created_at ASC
       LIMIT 60`,
      [req.params.marketId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/chat/:marketId — envia mensagem
router.post('/:marketId', auth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  if (message.trim().length > 200) return res.status(400).json({ error: 'Mensagem muito longa' });

  try {
    // Verifica se o mercado existe e está live
    const market = await pool.query("SELECT id FROM markets WHERE id=$1 AND status='live'", [req.params.marketId]);
    if (!market.rows[0]) return res.status(404).json({ error: 'Mercado não encontrado ou não está ao vivo' });

    const user = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
    const username = user.rows[0]?.name || 'Usuário';

    const result = await pool.query(
      'INSERT INTO chat_messages (market_id, user_id, username, message) VALUES ($1,$2,$3,$4) RETURNING id, username, message, created_at',
      [req.params.marketId, req.user.id, username, message.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
