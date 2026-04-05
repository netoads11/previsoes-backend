const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const auth    = require('../middleware/auth');

// Helper: verifica se chat está ativo nas settings
async function isChatEnabled() {
  const r = await pool.query("SELECT value FROM settings WHERE key='chat_enabled'");
  return !r.rows[0] || r.rows[0].value !== 'false';
}

// GET /api/chat/:marketId — últimas 60 mensagens (público)
router.get('/:marketId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, message, created_at FROM chat_messages
       WHERE market_id = $1 ORDER BY created_at ASC LIMIT 60`,
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
    if (!await isChatEnabled()) return res.status(403).json({ error: 'Chat desativado' });

    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [req.user.id]);
    if (!wallet.rows[0] || Number(wallet.rows[0].balance) <= 0) {
      return res.status(403).json({ error: 'Saldo insuficiente' });
    }

    const market = await pool.query("SELECT id FROM markets WHERE id=$1 AND status='live'", [req.params.marketId]);
    if (!market.rows[0]) return res.status(404).json({ error: 'Mercado não está ao vivo' });

    const user = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
    const username = user.rows[0]?.name || 'Usuário';

    const result = await pool.query(
      'INSERT INTO chat_messages (market_id, user_id, username, message) VALUES ($1,$2,$3,$4) RETURNING id, username, message, created_at',
      [req.params.marketId, req.user.id, username, message.trim()]
    );
    // Emite mensagem em tempo real para todos na sala
    const io = req.app.get('io');
    if (io) io.to(`market:${req.params.marketId}`).emit('new_message', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── ROTAS ADMIN ──

// GET /api/chat/admin/messages — todas as mensagens de todos os mercados live
router.get('/admin/messages', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cm.id, cm.username, cm.message, cm.created_at,
              m.question AS market_question, m.id AS market_id
       FROM chat_messages cm
       JOIN markets m ON m.id = cm.market_id
       ORDER BY cm.created_at DESC
       LIMIT 200`
    );
    const enabled = await isChatEnabled();
    res.json({ messages: result.rows, chat_enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DELETE /api/chat/admin/messages/:id — remove mensagem
router.delete('/admin/messages/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM chat_messages WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/chat/admin/toggle — ativa/desativa chat globalmente
router.post('/admin/toggle', auth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const val = enabled ? 'true' : 'false';
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('chat_enabled',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
      [val]
    );
    res.json({ chat_enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
