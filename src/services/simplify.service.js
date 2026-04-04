/**
 * simplify.service.js
 * Integração com Simplify BR — PIX cobranças e saques
 * Docs: https://simplifybr.com/api/v1
 */

const https = require('https');
const pool  = require('../config/database');

const BASE_URL = 'https://simplifybr.com/api/v1';

async function getCredentials() {
  const r = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('simplify_client_id','simplify_client_secret','simplify_active','simplify_webhook_secret')"
  );
  const map = {};
  r.rows.forEach(row => { map[row.key] = row.value; });
  return map;
}

function request(method, path, body, credentials) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'simplifybr.com',
      path: `/api/v1${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'client-id': credentials.simplify_client_id,
        'client-secret': credentials.simplify_client_secret,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(json.message || json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch {
          reject(new Error(`Resposta inválida: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout na requisição')); });
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Testa conexão com a API
 */
async function testConnection() {
  try {
    const creds = await getCredentials();
    if (!creds.simplify_client_id || !creds.simplify_client_secret) {
      return { success: false, message: 'Credenciais não configuradas' };
    }
    // Endpoint de verificação — lista últimas transações
    await request('GET', '/transactions?limit=1', null, creds);
    return { success: true, message: 'Conexão estabelecida com sucesso!' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * Cria cobrança PIX
 * @param {object} params - { amount, externalId, customerName, customerDocument, customerEmail, expiresInMinutes }
 */
async function createPixCharge(params) {
  const creds = await getCredentials();
  if (creds.simplify_active !== 'true') throw new Error('Gateway inativo');

  const body = {
    amount: Math.round(Number(params.amount) * 100), // centavos
    external_id: params.externalId,
    customer: {
      name: params.customerName || 'Cliente',
      document: params.customerDocument || '',
      email: params.customerEmail || '',
    },
    expires_in: (params.expiresInMinutes || 30) * 60, // segundos
    description: params.description || 'Depósito',
  };

  return request('POST', '/pix/charge', body, creds);
}

/**
 * Consulta status de uma cobrança PIX
 * @param {string} chargeId
 */
async function getChargeStatus(chargeId) {
  const creds = await getCredentials();
  return request('GET', `/pix/charge/${chargeId}`, null, creds);
}

/**
 * Cria transferência PIX (saque)
 * @param {object} params - { amount, pixKey, pixKeyType, recipientName, recipientDocument, externalId }
 */
async function createWithdrawal(params) {
  const creds = await getCredentials();
  if (creds.simplify_active !== 'true') throw new Error('Gateway inativo');

  const body = {
    amount: Math.round(Number(params.amount) * 100),
    external_id: params.externalId,
    recipient: {
      name: params.recipientName,
      document: params.recipientDocument || '',
      pix_key: params.pixKey,
      pix_key_type: params.pixKeyType || 'cpf', // cpf | cnpj | email | phone | random
    },
    description: params.description || 'Saque',
  };

  return request('POST', '/pix/transfer', body, creds);
}

/**
 * Verifica assinatura do webhook
 */
function verifyWebhook(payload, signature, secret) {
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}

module.exports = { testConnection, createPixCharge, getChargeStatus, createWithdrawal, verifyWebhook, getCredentials };
