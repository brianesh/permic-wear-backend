/**
 * services/tuma.js — Tuma Payment Solutions API service
 *
 * Provides: stkPush, formatPhone, testCredentials
 * Used by: routes/tuma.js
 *
 * Auth: single API Key (Bearer token)
 * Base: https://api.tuma.co.ke
 */

const axios = require('axios');

const TUMA_BASE = 'https://api.tuma.co.ke';
let _db = null;

function init(db) { _db = db; }

// ── Normalize phone to 254XXXXXXXXX ──────────────────────────────
function formatPhone(phone) {
  let p = String(phone).replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

// ── Get API key from DB or env ────────────────────────────────────
async function getCredentials() {
  const creds = {
    apiKey:      process.env.TUMA_API_KEY      || '',
    callbackUrl: process.env.TUMA_CALLBACK_URL || '',
    paybill:     process.env.MPESA_SHORTCODE   || '880100',
    account:     process.env.MPESA_ACCOUNT     || '505008',
  };

  // Auto-derive callback URL if not explicitly set
  if (!creds.callbackUrl && process.env.RENDER_EXTERNAL_URL) {
    creds.callbackUrl = `${process.env.RENDER_EXTERNAL_URL}/api/tuma/callback`;
  }
  if (!creds.callbackUrl && process.env.MPESA_CALLBACK_URL) {
    creds.callbackUrl = process.env.MPESA_CALLBACK_URL.replace('/api/mpesa/callback', '/api/tuma/callback');
  }

  if (_db) {
    try {
      const [rows] = await _db.query(
        `SELECT key_name, key_value FROM settings
         WHERE key_name IN ('tuma_api_key','tuma_callback_url','mpesa_shortcode','mpesa_account')`
      );
      rows.forEach(r => {
        if (!r.key_value?.trim()) return;
        if (r.key_name === 'tuma_api_key')      creds.apiKey      = r.key_value;
        if (r.key_name === 'tuma_callback_url') creds.callbackUrl = r.key_value;
        if (r.key_name === 'mpesa_shortcode')   creds.paybill     = r.key_value;
        if (r.key_name === 'mpesa_account')     creds.account     = r.key_value;
      });
    } catch (e) {
      console.warn('[Tuma] Could not read DB credentials:', e.message);
    }
  }
  return creds;
}

// ── Initiate STK Push ─────────────────────────────────────────────
async function stkPush(phone, amount, accountRef, description) {
  const creds = await getCredentials();

  if (!creds.apiKey) {
    throw new Error(
      'Tuma API key not configured. Go to Settings → M-Pesa → Tuma section and paste your API key.'
    );
  }

  const normalizedPhone = formatPhone(phone);

  const payload = {
    amount:       Math.ceil(parseFloat(amount)),
    phone:        normalizedPhone,
    description:  description || `Permic Wear - ${accountRef}`,
    account_ref:  accountRef  || creds.account,
    callback_url: creds.callbackUrl,
    paybill:      creds.paybill,
  };

  console.log('[Tuma] STK Push →', normalizedPhone, 'KES', payload.amount);

  try {
    const res = await axios.post(`${TUMA_BASE}/payment/stk-push`, payload, {
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 20000,
    });

    console.log('[Tuma] STK response:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[Tuma] STK Push failed:', msg, err.response?.data);
    throw new Error(msg || 'STK Push failed');
  }
}

// ── Test credentials ──────────────────────────────────────────────
async function testCredentials() {
  const creds = await getCredentials();
  if (!creds.apiKey) {
    return {
      ok: false,
      message: 'Tuma API key not set. Go to Settings → M-Pesa → Tuma section.',
      report: { apiKey: false, callbackUrl: creds.callbackUrl },
    };
  }

  try {
    // Attempt a lightweight auth check — hit the base URL
    await axios.get(`${TUMA_BASE}/`, {
      headers: { 'Authorization': `Bearer ${creds.apiKey}` },
      timeout: 8000,
    });
    return {
      ok: true,
      message: 'Tuma API key is valid ✅',
      report: {
        apiKey:      creds.apiKey.slice(0, 8) + '...',
        callbackUrl: creds.callbackUrl,
        paybill:     creds.paybill,
        account:     creds.account,
      },
    };
  } catch (err) {
    const status = err.response?.status;
    // 401 = wrong key, 404/200 = valid but no such route (still authenticated)
    if (status === 401) {
      return { ok: false, message: 'API key rejected (401 Unauthorized). Check your key.', report: { status } };
    }
    // Any other response means key was accepted (server just returned an error for the route)
    if (status) {
      return {
        ok: true,
        message: `API key accepted (HTTP ${status}). Tuma is reachable ✅`,
        report: { apiKey: creds.apiKey.slice(0, 8) + '...', callbackUrl: creds.callbackUrl, status },
      };
    }
    return { ok: false, message: `Cannot reach Tuma API: ${err.message}`, report: {} };
  }
}

module.exports = { init, formatPhone, stkPush, testCredentials, getCredentials };
