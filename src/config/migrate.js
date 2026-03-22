const pool = require('./database');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        balance DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS markets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question TEXT NOT NULL,
        description TEXT,
        yes_odds DECIMAL(5,2) DEFAULT 50,
        no_odds DECIMAL(5,2) DEFAULT 50,
        status VARCHAR(20) DEFAULT 'open',
        result VARCHAR(10),
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        market_id UUID REFERENCES markets(id),
        choice VARCHAR(10) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        pix_key VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Migracao concluida!');
    process.exit(0);
  } catch (err) {
    console.error('Erro na migracao:', err);
    process.exit(1);
  }
}

migrate();
