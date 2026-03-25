const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Previsoes API rodando!" });
});

// Garantir pasta de uploads
fs.mkdirSync("/app/uploads/markets", { recursive: true });

// Servir uploads publicamente
app.use("/uploads", express.static("/app/uploads"));


// Rota pública de settings (sem auth)
app.get('/api/settings/public', async (req, res) => {
  const pool = require('./src/config/database');
  const PUBLIC_KEYS = ['min_deposit', 'saque_minimo', 'saque_maximo'];
  try {
    const result = await pool.query(
      'SELECT key, value FROM settings WHERE key = ANY($1)',
      [PUBLIC_KEYS]
    );
    const data = {};
    result.rows.forEach(r => data[r.key] = r.value);
    res.json(data);
  } catch (err) {
    res.json({ min_deposit: '10.00' }); // fallback
  }
});

const authRoutes = require("./src/routes/auth");
const marketRoutes = require("./src/routes/markets");
const betRoutes = require("./src/routes/bets");
const walletRoutes = require("./src/routes/wallet");
const adminRoutes = require("./src/routes/admin");

app.use("/api/auth", authRoutes);
app.use("/api/markets", marketRoutes);
app.use("/api/bets", betRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

module.exports = app;
