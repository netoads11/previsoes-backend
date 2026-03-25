const express = require('express');
const router = express.Router();
const pool = require('../config/database');

router.get('/', async (req, res) => {
  try {
    const markets = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    const result = markets.rows;

    const multipleIds = result.filter(m => m.type === 'multiple').map(m => m.id);
    let optionsMap = {};
    if (multipleIds.length > 0) {
      const opts = await pool.query(
        'SELECT * FROM market_options WHERE market_id = ANY($1) ORDER BY market_id, order_index',
        [multipleIds]
      );
      opts.rows.forEach(o => {
        if (!optionsMap[o.market_id]) optionsMap[o.market_id] = [];
        optionsMap[o.market_id].push(o);
      });
    }

    const enriched = result.map(m => ({
      ...m,
      options: m.type === 'multiple' ? (optionsMap[m.id] || []) : [],
    }));
    res.json(enriched);
  } catch (err) {
    console.error('GET /markets error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const m = await pool.query('SELECT * FROM markets WHERE id=$1', [req.params.id]);
    if (!m.rows[0]) return res.status(404).json({ error: 'Mercado nao encontrado' });
    const market = m.rows[0];
    if (market.type === 'multiple') {
      const opts = await pool.query('SELECT * FROM market_options WHERE market_id=$1 ORDER BY order_index', [market.id]);
      market.options = opts.rows;
    } else {
      market.options = [];
    }
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
