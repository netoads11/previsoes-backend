const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets WHERE status = $1 ORDER BY created_at DESC', ['open']);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Mercado nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
