/**
 * mpesa.js — Safaricom Daraja API service
 *
 * Credential priority (highest → lowest):
 *   1. DB settings table  (saved via Settings UI)
 *   2. .env file          (fallback)
 *
 * This ensures credentials saved in the admin panel take effect
 * immediately without restarting the server.
 */

const axios = require('axios');

// ── DB reference (set once from server.js via init()) ─────────────
let _db = null;
function init(db) { _db = db; }

// ── Credential resolution ─────────────────────────────────────────
// Reads from DB settings first, falls back to .env.
// Sandbox and Production have SEPARATE credential sets stored.
// Active set is determined by mpesa_env setting.
async function getCredentials() {
  const base = {
    env:              process.env.MPESA_ENV                  || 'sandbox',
    // Production
    shortcode:        process.env.MPESA_SHORTCODE            || '880100',
    account:          process.env.MPESA_ACCOUNT              || '505008',
    mpesaPhone:       process.env.MPESA_PHONE                || '0706505008',
    key:              process.env.MPESA_CONSUMER_KEY         || '',
    secret:           process.env.MPESA_CONSUMER_SECRET      || '',
    // Sandbox (separate keys)
    sandboxShortcode: process.env.MPESA_SANDBOX_SHORTCODE    || '174379',
    sandboxKey:       process.env.MPESA_SANDBOX_KEY          || '',
    sandboxSecret:    process.env.MPESA_SANDBOX_SECRET       || '',
    // Shared
    passkey:          process.env.MPESA_PASSKEY              || '',
    callbackUrl:      process.env.MPESA_CALLBACK_URL         || '',
  };

  // Override with DB values if available
  if (_db) {
    try {
      const [rows] = await _db.query(
        `SELECT key_name, key_value FROM settings
         WHERE key_name IN (
           'mpesa_env',
           'mpesa_shortcode','mpesa_account','mpesa_phone',
           'mpesa_consumer_key','mpesa_consumer_secret',
           'mpesa_sandbox_shortcode','mpesa_sandbox_key','mpesa_sandbox_secret',
           'mpesa_passkey','mpesa_callback_url'
         )`
      );
      rows.forEach(r => {
        if (r.key_value && r.key_value.trim()) {
          switch (r.key_name) {
            case 'mpesa_env':              base.env              = r.key_value; break;
            case 'mpesa_shortcode':        base.shortcode        = r.key_value; break;
            case 'mpesa_account':          base.account          = r.key_value; break;
            case 'mpesa_phone':            base.mpesaPhone       = r.key_value; break;
            case 'mpesa_consumer_key':     base.key              = r.key_value; break;
            case 'mpesa_consumer_secret':  base.secret           = r.key_value; break;
            case 'mpesa_sandbox_shortcode':base.sandboxShortcode = r.key_value; break;
            case 'mpesa_sandbox_key':      base.sandboxKey       = r.key_value; break;
            case 'mpesa_sandbox_secret':   base.sandboxSecret    = r.key_value; break;
            case 'mpesa_passkey':          base.passkey          = r.key_value; break;
            case 'mpesa_callback_url':     base.callbackUrl      = r.key_value; break;
          }
        }
      });
    } catch (e) {
      console.warn('[M-Pesa] Could not read DB credentials, using .env:', e.message);
    }
  }

  // Return active credential set based on environment
  const isSandbox = base.env !== 'production';
  return {
    env:         base.env,
    shortcode:   isSandbox ? base.sandboxShortcode : base.shortcode,
    account:     base.account,
    mpesaPhone:  base.mpesaPhone,
    key:         isSandbox ? base.sandboxKey    : base.key,
    secret:      isSandbox ? base.sandboxSecret : base.secret,
    passkey:     base.passkey,
    callbackUrl: base.callbackUrl,
  };
}

function getBaseUrl(env) {
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// ── Token cache (per credential set) ──────────────────────────────
let tokenCache = { token: null, expiry: 0, key: '' };

async function getToken(creds) {
  const cacheKey = `${creds.key}:${creds.env}`;

  if (tokenCache.token && Date.now() < tokenCache.expiry && tokenCache.key === cacheKey) {
    return tokenCache.token;
  }

  if (!creds.key || !creds.secret) {
    throw new Error(
      'M-Pesa Consumer Key and Secret are not configured. ' +
      'Go to Settings → M-Pesa and enter your Daraja credentials.'
    );
  }

  const encoded  = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64');
  const baseUrl  = getBaseUrl(creds.env);

  let response;
  try {
    response = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${encoded}` },
        timeout: 10000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.errorMessage || err.message;
    if (status === 400 || status === 401) {
      throw new Error(`M-Pesa auth failed (${status}): Invalid Consumer Key or Secret. Check Settings → M-Pesa.`);
    }
    throw new Error(`M-Pesa token request failed: ${msg}`);
  }

  const token     = response.data.access_token;
  const expiresIn = response.data.expires_in || 3600;

  tokenCache = {
    token,
    expiry: Date.now() + (expiresIn - 60) * 1000,
    key: cacheKey,
  };

  return token;
}

// ── Helpers ───────────────────────────────────────────────────────
function getTimestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

function buildPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

// Sanitise phone: accepts 07XX, +2547XX, 2547XX → returns 2547XXXXXXXX
function formatPhone(phone) {
  const clean = String(phone).replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+254')) return clean.slice(1);
  if (clean.startsWith('254'))  return clean;
  if (clean.startsWith('0'))    return `254${clean.slice(1)}`;
  return `254${clean}`;
}

// ── STK Push ──────────────────────────────────────────────────────
async function stkPush(phone, amount, txnId) {
  const creds     = await getCredentials();
  const token     = await getToken(creds);
  const timestamp = getTimestamp();
  const baseUrl   = getBaseUrl(creds.env);

  if (!creds.passkey) {
    throw new Error(
      'M-Pesa Passkey is not configured. ' +
      'Get it from Daraja portal → Lipa Na M-Pesa → Passkey, then add it to your .env as MPESA_PASSKEY.'
    );
  }

  if (!creds.callbackUrl || creds.callbackUrl.includes('localhost')) {
    throw new Error(
      'M-Pesa Callback URL is not set or points to localhost. ' +
      'Safaricom cannot reach localhost. Set MPESA_CALLBACK_URL in .env to your public HTTPS URL.'
    );
  }

  const password = buildPassword(creds.shortcode, creds.passkey, timestamp);

  const payload = {
    BusinessShortCode: creds.shortcode,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',
    Amount:            Math.ceil(Number(amount)),
    PartyA:            formatPhone(phone),
    PartyB:            creds.shortcode,
    PhoneNumber:       formatPhone(phone),
    CallBackURL:       creds.callbackUrl,
    AccountReference:  creds.account || '505008',  // Account number shown on customer's STK prompt
    TransactionDesc:   `Permic Wear ${txnId}`,     // TXN ID for internal reference
  };

  let response;
  try {
    response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
  } catch (err) {
    const daraja = err.response?.data;
    const msg    = daraja?.errorMessage || daraja?.ResponseDescription || err.message;
    throw new Error(`STK Push failed: ${msg}`);
  }

  console.log('[STK Push] Response:', JSON.stringify(response.data));
  return response.data;
}

// ── STK Query (poll Safaricom directly) ───────────────────────────
async function stkQuery(checkoutRequestId) {
  const creds     = await getCredentials();
  const token     = await getToken(creds);
  const timestamp = getTimestamp();
  const baseUrl   = getBaseUrl(creds.env);
  const password  = buildPassword(creds.shortcode, creds.passkey, timestamp);

  const response = await axios.post(
    `${baseUrl}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: creds.shortcode,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
  );

  return response.data;
}

// ── C2B URL Registration ──────────────────────────────────────────
async function registerC2BUrls() {
  const creds   = await getCredentials();
  const token   = await getToken(creds);
  const baseUrl = getBaseUrl(creds.env);

  // Derive C2B URLs from the STK callback URL base
  const apiBase = creds.callbackUrl.replace(/\/mpesa\/callback.*$/, '');

  const payload = {
    ShortCode:       creds.shortcode,
    ResponseType:    'Completed',
    ConfirmationURL: `${apiBase}/mpesa/c2b-callback`,
    ValidationURL:   `${apiBase}/mpesa/c2b-validate`,
  };

  const response = await axios.post(
    `${baseUrl}/mpesa/c2b/v1/registerurl`,
    payload,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
  );

  return response.data;
}

module.exports = { init, stkPush, stkQuery, formatPhone, registerC2BUrls, getCredentials };
