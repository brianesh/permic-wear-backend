/**
 * mpesa.js routes
 *
 * STK Push flow:
 *   POST /stk-push        → initiates Lipa Na M-Pesa prompt on customer's phone
 *   POST /callback        → Safaricom POSTs result here (must be public HTTPS)
 *   GET  /status/:id      → frontend polls this every 3s; queries Safaricom directly after 10s
 *   POST /confirm-manual  → cashier manually marks payment as received (bypass for callback issues)
 *
 * C2B (manual paybill) flow:
 *   POST /c2b-validate    → Safaricom pre-validates payment
 *   POST /c2b-callback    → Safaricom confirms payment after debit
 *   GET  /c2b-register    → one-time URL registration with Safaricom
 *
 * Diagnostic:
 *   GET  /test-credentials → checks all credentials and returns report (super_admin only)
 */

const express  = require('express');
const db       = require('../db/connection');
const { stkPush, stkQuery, registerC2BUrls, getCredentials } = require('../services/mpesa');
const { log }  = require('../services/logger');
const { sendSaleConfirmationSMS } = require('../services/sms');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');

// Helper: deduct stock for a completed sale
async function deductStock(saleId) {
  const [items] = await db.query(
    'SELECT product_id, qty FROM sale_items WHERE sale_id = ?', [saleId]
  );
  for (const item of items) {
    await db.query(
      'UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?',
      [item.qty, item.product_id]
    );
  }
}

// Helper: complete a sale and deduct stock (idempotent)
async function completeSale(saleId, mpesaRef = '') {
  const [[sale]] = await db.query('SELECT status FROM sales WHERE id = ?', [saleId]);
  if (!sale || sale.status === 'completed') return false; // already done

  await db.query(
    `UPDATE sales SET status = 'completed', mpesa_ref = ?, amount_paid = selling_total WHERE id = ?`,
    [mpesaRef, saleId]
  );
  await deductStock(saleId);

  // Async: send confirmation SMS to customer (M-Pesa phone)
  try {
    const [[saleRow]] = await db.query(
      'SELECT txn_id, selling_total, mpesa_phone FROM sales WHERE id = ?', [saleId]
    );
    const [saleItems] = await db.query(
      'SELECT product_name, size, qty FROM sale_items WHERE sale_id = ?', [saleId]
    );
    if (saleRow?.mpesa_phone) {
      sendSaleConfirmationSMS(db, {
        customerPhone: saleRow.mpesa_phone,
        txnId:   saleRow.txn_id,
        total:   saleRow.selling_total,
        items:   saleItems,
        mpesaRef,
      }).catch(() => {});
    }
  } catch (_) {}

  return true;
}

// ── POST /api/mpesa/stk-push ──────────────────────────────────────
router.post('/stk-push', requireAuth, async (req, res) => {
  try {
    const { sale_id, phone, amount } = req.body;
    if (!phone || !amount || !sale_id)
      return res.status(400).json({ error: 'sale_id, phone, and amount are required' });

    const [[sale]] = await db.query(
      'SELECT id, txn_id, status FROM sales WHERE id = ?', [sale_id]
    );
    if (!sale)
      return res.status(404).json({ error: 'Sale not found' });
    if (sale.status !== 'pending_mpesa' && sale.status !== 'pending_split')
      return res.status(400).json({ error: `Sale is already ${sale.status}` });

    const mpesaResp = await stkPush(phone, amount, sale.txn_id);

    if (mpesaResp.ResponseCode !== '0') {
      return res.status(502).json({
        error: mpesaResp.ResponseDescription || 'STK push rejected by Safaricom',
        safaricom: mpesaResp,
      });
    }

    // Upsert pending transaction record
    await db.query(
      `INSERT INTO mpesa_transactions
         (sale_id, checkout_request_id, merchant_request_id, phone, amount)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (checkout_request_id) DO UPDATE SET
         merchant_request_id = EXCLUDED.merchant_request_id,
         phone = EXCLUDED.phone,
         amount = EXCLUDED.amount,
         status = 'pending',
         initiated_at = NOW()`,
      [sale_id, mpesaResp.CheckoutRequestID, mpesaResp.MerchantRequestID, phone, amount]
    );

    await log(req.user.id, req.user.name, req.user.role, 'mpesa_stk_sent',
      sale.txn_id, `Phone: ${phone}, KES ${amount}`, 'sale', req.ip);

    res.json({
      message:             mpesaResp.CustomerMessage || 'STK push sent',
      checkout_request_id: mpesaResp.CheckoutRequestID,
    });

  } catch (err) {
    console.error('[STK Push]', err.message);
    const userMsg = err.message.includes('Consumer Key') || err.message.includes('Passkey') ||
                    err.message.includes('Callback URL') || err.message.includes('auth failed') ||
                    err.message.includes('Merchant')
      ? err.message
      : 'Failed to initiate M-Pesa payment. Check server logs.';
    res.status(500).json({ error: userMsg });
  }
});

// ── POST /api/mpesa/callback ──────────────────────────────────────
// Safaricom POSTs here after STK push succeeds or fails.
// MUST be public HTTPS. MUST return 200 immediately.
router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // ACK first

  try {
    const stk        = req.body?.Body?.stkCallback;
    const code       = stk?.ResultCode;
    const desc       = stk?.ResultDesc;
    const checkoutId = stk?.CheckoutRequestID;

    console.log('[STK Callback]', JSON.stringify(stk, null, 2));
    if (checkoutId == null) return;

    const [[txn]] = await db.query(
      'SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?',
      [checkoutId]
    );
    if (!txn) {
      console.warn('[STK Callback] No transaction found for', checkoutId);
      return;
    }

    if (code === 0) {
      const items    = stk.CallbackMetadata?.Item || [];
      const getMeta  = name => items.find(i => i.Name === name)?.Value;
      const mpesaRef = getMeta('MpesaReceiptNumber') || '';

      await db.query(
        `UPDATE mpesa_transactions
         SET status = 'success', mpesa_ref = ?, confirmed_at = NOW(),
             result_code = ?, result_desc = ?
         WHERE checkout_request_id = ?`,
        [mpesaRef, code, desc, checkoutId]
      );
      const completed = await completeSale(txn.sale_id, mpesaRef);
      console.log(`[STK Callback] ✅ ${mpesaRef} sale ${txn.sale_id} ${completed ? 'completed' : 'already done'}`);
    } else {
      await db.query(
        `UPDATE mpesa_transactions
         SET status = 'failed', result_code = ?, result_desc = ?, confirmed_at = NOW()
         WHERE checkout_request_id = ?`,
        [code, desc, checkoutId]
      );
      await db.query("UPDATE sales SET status = 'failed' WHERE id = ?", [txn.sale_id]);
      console.log(`[STK Callback] ❌ Failed (code ${code}): ${desc}`);
    }
  } catch (err) {
    console.error('[STK Callback] Error:', err.message);
  }
});

// ── GET /api/mpesa/status/:checkoutRequestId ──────────────────────
// Polled every 3s by the frontend.
// Strategy:
//   - Always return current DB status first
//   - After 10s of pending, start querying Safaricom directly on EVERY poll
//     (not just once) so we catch the confirmation as fast as possible
//   - If sale is already completed in DB (callback fired), sync txn status
router.get('/status/:checkoutRequestId', requireAuth, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    const [[txn]] = await db.query(
      `SELECT mt.*, s.txn_id, s.selling_total, s.status AS sale_status
       FROM mpesa_transactions mt
       JOIN sales s ON mt.sale_id = s.id
       WHERE mt.checkout_request_id = ?`,
      [checkoutRequestId]
    );
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    // If the sale is already completed (e.g. callback fired, or manual confirm),
    // sync the txn record and return success immediately
    if (txn.sale_status === 'completed' && txn.status !== 'success') {
      await db.query(
        "UPDATE mpesa_transactions SET status = 'success', confirmed_at = NOW() WHERE checkout_request_id = ?",
        [checkoutRequestId]
      );
      return res.json({ status: 'success', mpesa_ref: txn.mpesa_ref || '', txn_id: txn.txn_id, amount: txn.amount });
    }

    if (txn.sale_status === 'completed') {
      return res.json({ status: 'success', mpesa_ref: txn.mpesa_ref || '', txn_id: txn.txn_id, amount: txn.amount });
    }

    // For pending transactions: after 10s start querying Safaricom directly
    // on every single poll — this is our main confirmation path when the
    // callback URL is not reachable (e.g. during development / ngrok not set)
    const ageMs = txn.initiated_at ? Date.now() - new Date(txn.initiated_at).getTime() : 0;

    if (txn.status === 'pending' && ageMs > 10000) {
      try {
        const qr = await stkQuery(checkoutRequestId);
        console.log('[STK Query] Result:', JSON.stringify(qr));

        if (qr.ResultCode === 0) {
          // Confirmed via direct query
          const mpesaRef = qr.MpesaReceiptNumber || '';
          await db.query(
            `UPDATE mpesa_transactions SET status = 'success', mpesa_ref = ?, confirmed_at = NOW()
             WHERE checkout_request_id = ?`,
            [mpesaRef, checkoutRequestId]
          );
          await completeSale(txn.sale_id, mpesaRef);
          return res.json({ status: 'success', mpesa_ref: mpesaRef, txn_id: txn.txn_id, amount: txn.amount });

        } else if (qr.ResultCode === 1032) {
          // Customer cancelled
          await db.query(
            `UPDATE mpesa_transactions SET status = 'failed', result_code = 1032,
             result_desc = 'Cancelled by user', confirmed_at = NOW()
             WHERE checkout_request_id = ?`, [checkoutRequestId]
          );
          await db.query("UPDATE sales SET status = 'failed' WHERE id = ?", [txn.sale_id]);
          return res.json({ status: 'failed', txn_id: txn.txn_id, amount: txn.amount });

        } else if (qr.ResultCode === 1037) {
          // Timeout — DS not reachable (often sandbox issue, keep polling)
          console.log('[STK Query] DS timeout, keep polling');
        } else if (qr.ResultCode === 17) {
          // Still processing
          console.log('[STK Query] Still processing');
        } else if (qr.ResultCode != null && qr.ResultCode !== 1) {
          // Unexpected failure code — mark failed
          await db.query(
            `UPDATE mpesa_transactions SET status = 'failed', result_code = ?,
             result_desc = ?, confirmed_at = NOW() WHERE checkout_request_id = ?`,
            [qr.ResultCode, qr.ResultDesc || 'Unknown', checkoutRequestId]
          );
          await db.query("UPDATE sales SET status = 'failed' WHERE id = ?", [txn.sale_id]);
          return res.json({ status: 'failed', txn_id: txn.txn_id, amount: txn.amount });
        }
      } catch (qErr) {
        // STK query API error — sandbox sometimes returns 500 for pending txns
        // Keep polling, don't give up
        console.warn('[STK Query] API error (keep polling):', qErr.message);
      }
    }

    res.json({
      status:    txn.status,
      mpesa_ref: txn.mpesa_ref || null,
      txn_id:    txn.txn_id,
      amount:    txn.amount,
      age_ms:    ageMs,
    });

  } catch (err) {
    console.error('[STK Status]', err.message);
    res.status(500).json({ error: 'Failed to check M-Pesa status' });
  }
});

// ── POST /api/mpesa/confirm-manual ───────────────────────────────
// Cashier manually marks payment as received.
// Used when: customer paid but callback never fired (ngrok down, etc.)
// This is the "✓ Mark as Paid Manually" button on the POS overlay.
router.post('/confirm-manual', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id } = req.body;

    let resolvedSaleId = sale_id;

    // If checkout_request_id given, look up sale_id from it
    if (checkout_request_id && !resolvedSaleId) {
      const [[txn]] = await db.query(
        'SELECT sale_id FROM mpesa_transactions WHERE checkout_request_id = ?',
        [checkout_request_id]
      );
      if (txn) resolvedSaleId = txn.sale_id;
    }

    if (!resolvedSaleId)
      return res.status(400).json({ error: 'sale_id or checkout_request_id required' });

    const [[sale]] = await db.query(
      'SELECT id, cashier_id, status FROM sales WHERE id = ?', [resolvedSaleId]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    if (sale.status === 'completed')
      return res.json({ message: 'Already completed', status: 'completed' });

    const manualRef = `MANUAL-${Date.now()}`;
    await completeSale(resolvedSaleId, manualRef);

    if (checkout_request_id) {
      await db.query(
        `UPDATE mpesa_transactions
         SET status = 'success', mpesa_ref = ?, confirmed_at = NOW()
         WHERE checkout_request_id = ?`,
        [manualRef, checkout_request_id]
      );
    }

    await log(req.user.id, req.user.name, req.user.role, 'mpesa_manual_confirm',
      `sale_${resolvedSaleId}`, `Manually confirmed by ${req.user.name}`, 'sale', req.ip);

    res.json({ message: 'Sale completed manually', status: 'completed', mpesa_ref: manualRef });
  } catch (err) {
    console.error('[Manual Confirm]', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── POST /api/mpesa/confirm-by-ref ───────────────────────────────
// Cashier entered the M-Pesa receipt code from the customer's SMS.
// Marks the sale complete and records the real M-Pesa ref.
router.post('/confirm-by-ref', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id, mpesa_ref } = req.body;
    if (!mpesa_ref) return res.status(400).json({ error: 'mpesa_ref required' });

    let resolvedSaleId = sale_id;
    if (checkout_request_id && !resolvedSaleId) {
      const [[txn]] = await db.query(
        'SELECT sale_id FROM mpesa_transactions WHERE checkout_request_id = ?',
        [checkout_request_id]
      );
      if (txn) resolvedSaleId = txn.sale_id;
    }
    if (!resolvedSaleId) return res.status(400).json({ error: 'sale_id or checkout_request_id required' });

    const [[sale]] = await db.query('SELECT id, cashier_id, status FROM sales WHERE id = ?', [resolvedSaleId]);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const completed = await completeSale(resolvedSaleId, mpesa_ref);
    if (checkout_request_id) {
      await db.query(
        `UPDATE mpesa_transactions SET status = 'success', mpesa_ref = ?, confirmed_at = NOW()
         WHERE checkout_request_id = ?`,
        [mpesa_ref, checkout_request_id]
      );
    }

    await log(req.user.id, req.user.name, req.user.role, 'mpesa_ref_confirm',
      `sale_${resolvedSaleId}`, `Ref: ${mpesa_ref} by ${req.user.name}`, 'sale', req.ip);

    res.json({ message: completed ? 'Sale confirmed' : 'Already completed', status: 'completed', mpesa_ref });
  } catch (err) {
    console.error('[Confirm by Ref]', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── POST /api/mpesa/c2b-validate ─────────────────────────────────
router.post('/c2b-validate', async (req, res) => {
  console.log('[C2B Validate]', JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ── POST /api/mpesa/c2b-callback ─────────────────────────────────
router.post('/c2b-callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const { TransID, TransAmount, BillRefNumber, MSISDN } = req.body;
    console.log('[C2B Callback]', JSON.stringify(req.body));

    const amount   = parseFloat(TransAmount) || 0;
    const phone    = String(MSISDN   || '').trim();
    const mpesaRef = String(TransID  || '').trim();
    const billRef  = String(BillRefNumber || '').trim().toUpperCase();
    if (!mpesaRef) return;

    let matchedSaleId = null;

    if (billRef) {
      const [[s]] = await db.query(
        "SELECT id FROM sales WHERE txn_id = ? AND status = 'pending_mpesa' LIMIT 1", [billRef]
      );
      if (s) matchedSaleId = s.id;
    }
    if (!matchedSaleId && phone) {
      const [[s]] = await db.query(
        `SELECT id FROM sales WHERE selling_total = ? AND mpesa_phone = ? AND status = 'pending_mpesa'
         ORDER BY sale_date DESC LIMIT 1`, [amount, phone]
      );
      if (s) matchedSaleId = s.id;
    }

    if (matchedSaleId) {
      await completeSale(matchedSaleId, mpesaRef);
      await db.query(
        "UPDATE mpesa_transactions SET status = 'success', mpesa_ref = ?, confirmed_at = NOW() WHERE sale_id = ? AND status = 'pending'",
        [mpesaRef, matchedSaleId]
      );
      console.log(`[C2B Callback] ✅ Matched sale ${matchedSaleId}: ${mpesaRef} KES ${amount}`);
    } else {
      console.warn(`[C2B Callback] ⚠ Unmatched: ${mpesaRef} KES ${amount} from ${phone} (BillRef: ${billRef})`);
    }
  } catch (err) {
    console.error('[C2B Callback] Error:', err.message);
  }
});

// ── GET /api/mpesa/c2b-register ───────────────────────────────────
router.get('/c2b-register', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const result = await registerC2BUrls();
    res.json({ message: 'C2B URLs registered with Safaricom', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/mpesa/test-credentials ──────────────────────────────
router.get('/test-credentials', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const creds = await getCredentials();
    const report = {
      env:             creds.env,
      shortcode:       creds.shortcode,
      consumer_key:    creds.key    ? `${creds.key.slice(0,8)}…` : '❌ NOT SET',
      consumer_secret: creds.secret ? `${creds.secret.slice(0,4)}…` : '❌ NOT SET',
      passkey:         creds.passkey ? '✓ set' : '❌ NOT SET — add MPESA_PASSKEY to .env',
      callback_url:    creds.callbackUrl || '❌ NOT SET — add MPESA_CALLBACK_URL to .env',
      callback_reachable: creds.callbackUrl && !creds.callbackUrl.includes('localhost'),
    };

    if (!creds.key || !creds.secret) {
      return res.status(400).json({ ok: false, message: 'Consumer Key or Secret missing', report });
    }
    if (!creds.passkey) {
      return res.status(400).json({ ok: false, message: 'MPESA_PASSKEY not set in .env', report });
    }
    if (!creds.callbackUrl || creds.callbackUrl.includes('localhost')) {
      return res.status(400).json({
        ok: false,
        message: 'MPESA_CALLBACK_URL not set or points to localhost. Safaricom cannot reach localhost.',
        report,
        fix: 'For development: install ngrok, run "ngrok http 5000", copy the https URL and set MPESA_CALLBACK_URL=https://xxxx.ngrok.io/api/mpesa/callback in .env'
      });
    }

    // Try fetching a real token to verify key+secret work
    try {
      const { default: axios } = require('axios');
      const baseUrl = creds.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
      const encoded = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64');
      const tokenRes = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${encoded}` }, timeout: 8000
      });
      report.token_test = tokenRes.data.access_token ? '✅ Token fetched successfully' : '⚠ Empty token';
      res.json({ ok: true, message: 'All credentials look good', report });
    } catch (tokenErr) {
      report.token_test = `❌ Token fetch failed: ${tokenErr.response?.data?.errorMessage || tokenErr.message}`;
      res.status(400).json({ ok: false, message: 'Credentials set but token fetch failed — check Key/Secret are correct', report });
    }
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;
