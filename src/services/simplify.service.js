/**
 * simplify.service.js
 * Integração com Simplify BR — PIX depósitos e saques
 * Docs: https://simplifybr.gitbook.io/documentacao-simplify
 *
 * Endpoints:
 *   POST /pix/deposit  — cria cobrança PIX (depósito)
 *   POST /pix/withdraw — cria transferência PIX (saque)
 *
 * Auth: headers client-id + client-secret
 * Amounts: em reais (float), NÃO centavos
 */

const https = require('https');
const pool  = require('../config/database');

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
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: raw.slice(0, 200) });
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
 * Testa conexão com a API.
 * Estratégia: envia POST /pix/deposit com corpo intencionalmente incompleto.
 *   - 401/403 → credenciais inválidas
 *   - 422/400 → credenciais válidas, corpo rejeitado (esperado)
 *   - 200/201 → conexão OK e depósito criado (improvável com corpo mínimo)
 */
async function testConnection() {
  try {
    const creds = await getCredentials();
    if (!creds.simplify_client_id || !creds.simplify_client_secret) {
      return { success: false, message: 'Credenciais não configuradas' };
    }

    // Corpo mínimo proposital — só para testar autenticação
    const probe = {
      amount: 0.01,
      external_id: `test_${Date.now()}`,
      payer: { name: 'Teste', email: 'teste@teste.com', document: '00000000000' },
    };

    const { status, body } = await request('POST', '/pix/deposit', probe, creds);

    // 401/403 = credenciais erradas
    if (status === 401 || status === 403) {
      const msg = (typeof body === 'object' ? body.message || body.error : body) || `HTTP ${status}`;
      return { success: false, message: `Credenciais inválidas: ${msg}` };
    }

    // 422/400 = autenticou mas rejeitou os dados — credenciais OK
    if (status === 422 || status === 400) {
      return { success: true, message: 'Conexão estabelecida com sucesso!' };
    }

    // 2xx = funcionou de verdade
    if (status >= 200 && status < 300) {
      return { success: true, message: 'Conexão estabelecida com sucesso!' };
    }

    // Qualquer outro erro
    const msg = (typeof body === 'object' ? body.message || body.error : body) || `HTTP ${status}`;
    return { success: false, message: msg };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * Cria cobrança PIX (depósito)
 * @param {object} params - { amount, externalId, customerName, customerDocument, customerEmail, customerPhone, webhookURL }
 * @returns {object} Resposta da API — contém qrCode, qrCodeImage, depositId, etc.
 */
async function createPixCharge(params) {
  const creds = await getCredentials();
  if (creds.simplify_active !== 'true') throw new Error('Gateway inativo');

  const body = {
    amount: Number(params.amount), // reais (float)
    external_id: params.externalId,
    payer: {
      name: params.customerName || 'Cliente',
      document: params.customerDocument || '',
      email: params.customerEmail || '',
      phone: params.customerPhone || '',
    },
    ...(params.webhookURL ? { webhookURL: params.webhookURL } : {}),
  };

  const { status, body: resp } = await request('POST', '/pix/deposit', body, creds);
  if (status >= 400) {
    const msg = (typeof resp === 'object' ? resp.message || resp.error : resp) || `HTTP ${status}`;
    throw new Error(msg);
  }
  return resp;
}

/**
 * Cria transferência PIX (saque)
 * @param {object} params - { amount, pixKey, pixKeyType, recipientName, recipientDocument, recipientEmail, recipientPhone, externalId, webhookURL }
 * pixKeyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random'
 */
async function createWithdrawal(params) {
  const creds = await getCredentials();
  if (creds.simplify_active !== 'true') throw new Error('Gateway inativo');

  const body = {
    amount: Number(params.amount), // reais (float)
    external_id: params.externalId,
    pix_type: params.pixKeyType || 'cpf',
    pix_key: params.pixKey,
    beneficiary: {
      name: params.recipientName,
      document: params.recipientDocument || '',
      email: params.recipientEmail || '',
      phone: params.recipientPhone || '',
    },
    ...(params.webhookURL ? { webhookURL: params.webhookURL } : {}),
  };

  const { status, body: resp } = await request('POST', '/pix/withdraw', body, creds);
  if (status >= 400) {
    const msg = (typeof resp === 'object' ? resp.message || resp.error : resp) || `HTTP ${status}`;
    throw new Error(msg);
  }
  return resp;
}

/**
 * Verifica assinatura do webhook
 * @param {string|Buffer} payload - corpo bruto da requisição
 * @param {string} signature - valor do header X-Signature (ou similar)
 * @param {string} secret - simplify_webhook_secret
 */
function verifyWebhook(payload, signature, secret) {
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}

module.exports = { testConnection, createPixCharge, createWithdrawal, verifyWebhook, getCredentials };
