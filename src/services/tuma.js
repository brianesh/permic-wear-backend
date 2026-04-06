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
    email:       process.env.TUMA_EMAIL        || '',
    callbackUrl: process.env.TUMA_CALLBACK_URL || '',
    paybill:     process.env.TUMA_PAYBILL      || '880100',
    account:     process.env.TUMA_ACCOUNT      || '505008',
  };

  // Auto-derive callback URL if not explicitly set
  if (!creds.callbackUrl && process.env.RENDER_EXTERNAL_URL) {
    creds.callbackUrl = `${process.env.RENDER_EXTERNAL_URL}/api/tuma/callback`;
  }

  if (_db) {
    try {
      const [rows] = await _db.query(
        `SELECT key_name, key_value FROM settings
         WHERE key_name IN ('tuma_api_key','tuma_email','tuma_callback_url','tuma_paybill','tuma_account')`
      );
      rows.forEach(r => {
        if (!r.key_value?.trim()) return;
        if (r.key_name === 'tuma_api_key')      creds.apiKey      = r.key_value;
        if (r.key_name === 'tuma_email')        creds.email       = r.key_value;
        if (r.key_name === 'tuma_callback_url') creds.callbackUrl = r.key_value;
        if (r.key_name === 'tuma_paybill')      creds.paybill     = r.key_value;
        if (r.key_name === 'tuma_account')      creds.account     = r.key_value;
      });
    } catch (e) {
      console.warn('[Tuma] Could not read DB credentials:', e.message);
    }
  }
  return creds;
}

// ── Get JWT token from Tuma ────────────────────────────────────────
// Tuma requires getting a JWT token first using email + API key
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getTumaToken() {
  // Return cached token if still valid (tokens last 24 hours)
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }

  const creds = await getCredentials();
  if (!creds.apiKey || !creds.email) {
    throw new Error('Tuma API key or email not configured. Go to Settings → Payment (Tuma).');
  }

  try {
    const res = await axios.post(`${TUMA_BASE}/auth/token`, {
      email: creds.email,
      api_key: creds.apiKey,
    }, { timeout: 10000 });

    // Tuma API returns different response formats - check for token in multiple places
    const token = res.data.token || res.data.access_token || res.data.data?.token;
    const message = res.data.message || res.data.msg;
    
    if (token) {
      _cachedToken = token;
      // Token expires in 24 hours (86400 seconds), cache for 23 hours to be safe
      _tokenExpiresAt = Date.now() + (23 * 3600 * 1000);
      console.log('[Tuma] Got JWT token, expires in 23 hours');
      return _cachedToken;
    } else {
      throw new Error(message || 'Failed to get token');
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[Tuma] Token request failed:', msg);
    throw new Error(`Tuma auth failed: ${msg}`);
  }
}

// ── Initiate STK Push ─────────────────────────────────────────────
async function stkPush(phone, amount, accountRef, description) {
  const creds = await getCredentials();

  if (!creds.apiKey || !creds.email) {
    throw new Error(
      'Tuma API key or email not configured. Go to Settings → Payment (Tuma).'
    );
  }

  // Get JWT token using email + API key
  const token = await getTumaToken();

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
        'Authorization': `Bearer ${token}`,
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
      message: 'Tuma API key not set. Go to Settings → Payment (Tuma) and enter your API key.',
      report: { apiKey: false, callbackUrl: creds.callbackUrl },
    };
  }

  if (!creds.email) {
    return {
      ok: false,
      message: 'Tuma email not set. Go to Settings → Payment (Tuma) and enter your business email.',
      report: { apiKey: true, email: false, callbackUrl: creds.callbackUrl },
    };
  }

  try {
    // Test by getting a JWT token (this validates email + API key)
    const token = await getTumaToken();
    
    return {
      ok: true,
      message: 'Tuma credentials are valid ✅ JWT token obtained successfully.',
      report: {
        apiKey:      creds.apiKey.slice(0, 8) + '...',
        email:       creds.email,
        callbackUrl: creds.callbackUrl,
        paybill:     creds.paybill,
        account:     creds.account,
        token:       token.slice(0, 20) + '...',
      },
    };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    
    if (status === 401 || status === 403) {
      return { 
        ok: false, 
        message: `Authentication failed (${status}): ${msg}. Check your email and API key.`, 
        report: { status, email: creds.email } 
      };
    }
    
    return { 
      ok: false, 
      message: `Cannot authenticate with Tuma: ${msg || err.message}`, 
      report: { status: status || 'network_error', email: creds.email } 
    };
  }
}

module.exports = { init, formatPhone, stkPush, testCredentials, getCredentials };
