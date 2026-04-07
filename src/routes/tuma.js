/**
 * tuma.js routes — Tuma Payment Solutions integration
 *
 * POST /api/tuma/stk-push          → initiate payment (checks block first)
 * POST /api/tuma/callback          → Tuma webhook (must be public HTTPS)
 * GET  /api/tuma/status/:id        → frontend polling
 * POST /api/tuma/confirm-manual    → cashier fallback confirm
 * POST /api/tuma/confirm-by-ref    → cashier enters M-Pesa receipt code
 * GET  /api/tuma/test-credentials  → credential diagnostic (super_admin)
 * GET  /api/tuma/cancel-blocks     → view blocked phones (admin+)
 * DELETE /api/tuma/cancel-blocks/:phone → unblock (super_admin)
 *
 * ── Mandatory Cancellation Policy ───────────────────────────────
 * result_code 1032 = user cancelled STK prompt
 * 3 consecutive cancellations → phone blocked from future STK requests
 * Reset on first successful payment
 */

const express = require('express');
const db      = require('../db/connection');
const { stkPush, formatPhone, testCredentials } = require('../services/tuma');
const { log }  = require('../services/logger');
const { sendSaleConfirmationSMS } = require('../services/sms');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');
const ADMIN_UP   = requireRole('super_admin', 'admin');

// ── Stock deduction helper ────────────────────────────────────────
async function deductStock(saleId) {
  const { rows: items } = await db.query(
    'SELECT product_id, qty FROM sale_items WHERE sale_id = $1', [saleId]
  );
  for (const item of items) {
    await db.query(
      'UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2',
      [item.qty, item.product_id]
    );
  }
}

// ── Complete a sale (idempotent) ──────────────────────────────────
async function completeSale(saleId, paymentRef = '') {
  const { rows: [sale] } = await db.query('SELECT status FROM sales WHERE id = $1', [saleId]);
  if (!sale || sale.status === 'completed') return false;

  // Use mpesa_ref column (matching DB schema)
  await db.query(
    `UPDATE sales SET status='completed', mpesa_ref=$1, amount_paid=selling_total WHERE id=$2`,
    [paymentRef, saleId]
  );
  await deductStock(saleId);

  // Async SMS confirmation
  try {
    const { rows: [saleRow] } = await db.query(
      'SELECT txn_id, selling_total, mpesa_phone FROM sales WHERE id = $1', [saleId]
    );
    const { rows: saleItems } = await db.query(
      'SELECT product_name, size, qty FROM sale_items WHERE sale_id = $1', [saleId]
    );
    if (saleRow?.mpesa_phone) {
      sendSaleConfirmationSMS(db, {
        customerPhone: saleRow.mpesa_phone, txnId: saleRow.txn_id,
        total: saleRow.selling_total, items: saleItems, paymentRef: paymentRef,
      }).catch(() => {});
    }
  } catch (_) {}
  return true;
}

// ── Cancellation policy ───────────────────────────────────────────
async function isBlocked(phone) {
  try {
    const { rows } = await db.query(
      'SELECT 1 FROM tuma_cancel_blocks WHERE phone=$1 AND blocked_at IS NOT NULL', [phone]
    );
    return rows.length > 0;
  } catch (_) { return false; }
}

async function recordCancellation(phone) {
  try {
    await db.query(
      `INSERT INTO tuma_cancel_blocks (phone, consecutive_cancels, last_cancel_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         consecutive_cancels = CASE
           WHEN tuma_cancel_blocks.blocked_at IS NOT NULL THEN tuma_cancel_blocks.consecutive_cancels
           ELSE tuma_cancel_blocks.consecutive_cancels + 1
         END,
         last_cancel_at = NOW()`,
      [phone]
    );
    const { rows: [row] } = await db.query(
      'SELECT consecutive_cancels, blocked_at FROM tuma_cancel_blocks WHERE phone=$1', [phone]
    );
    const count = row?.consecutive_cancels || 1;
    if (count >= 3 && !row?.blocked_at) {
      await db.query('UPDATE tuma_cancel_blocks SET blocked_at=NOW() WHERE phone=$1', [phone]);
      console.warn(`[Tuma] 🚫 BLOCKED ${phone} after ${count} cancels`);
      return { blocked: true, count };
    }
    console.log(`[Tuma] ⚠ ${phone}: ${count}/3 cancels`);
    return { blocked: count >= 3, count };
  } catch (err) {
    console.error('[Tuma] cancel record error:', err.message);
    return { blocked: false, count: 0 };
  }
}

async function resetCancels(phone) {
  await db.query(
    `UPDATE tuma_cancel_blocks SET consecutive_cancels=0, last_cancel_at=NULL
     WHERE phone=$1 AND blocked_at IS NULL`, [phone]
  ).catch(() => {});
}

// ── Duplicate STK prevention ──────────────────────────────────────
// A sale should have at most one pending STK at a time
async function hasPendingSTK(saleId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tuma_transactions
     WHERE sale_id=$1 AND status='pending'
       AND initiated_at > NOW() - INTERVAL '3 minutes'`, [saleId]
  );
  return rows.length > 0;
}

// ── POST /api/tuma/stk-push ───────────────────────────────────────
router.post('/stk-push', requireAuth, async (req, res) => {
  try {
    const { sale_id, phone, amount } = req.body;
    if (!phone || !amount || !sale_id)
      return res.status(400).json({ error: 'sale_id, phone, and amount are required' });

    const fmtPhone = formatPhone(phone);

    // Cancellation block check
    if (await isBlocked(fmtPhone)) {
      return res.status(403).json({
        error: 'Payment blocked: This number has cancelled 3 consecutive payment requests. Please contact support.',
        code: 'STK_CANCEL_BLOCKED',
      });
    }

    // Duplicate prevention
    if (await hasPendingSTK(sale_id)) {
      return res.status(429).json({
        error: 'A payment request is already pending for this sale. Please wait for it to complete.',
        code: 'STK_DUPLICATE',
      });
    }

    const { rows: [sale] } = await db.query(
      'SELECT id, txn_id, status FROM sales WHERE id = $1', [sale_id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    // Accept pending_mpesa, pending_tuma, and pending_split statuses
    if (!['pending_mpesa', 'pending_tuma', 'pending_split'].includes(sale.status))
      return res.status(400).json({ error: `Sale is already ${sale.status}` });

    // Generate a reference immediately - this will be used for tracking
    const reference = `TUMA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const tumaResp = await stkPush(phone, amount, sale.txn_id);

    // Handle different Tuma API response formats
    // The checkout_request_id might be nested under 'data' or have different casing
    const checkoutRequestId = tumaResp.checkout_request_id 
      || tumaResp.checkoutRequestID 
      || tumaResp.CheckoutRequestID
      || (tumaResp.data && tumaResp.data.checkout_request_id)
      || (tumaResp.data && tumaResp.data.checkoutRequestID)
      || (tumaResp.response && tumaResp.response.checkout_request_id);

    const merchantRequestId = tumaResp.merchant_request_id 
      || tumaResp.merchantRequestID 
      || tumaResp.MerchantRequestID
      || (tumaResp.data && tumaResp.data.merchant_request_id)
      || (tumaResp.data && tumaResp.data.merchantRequestID);

    // Insert transaction with our generated reference (even if checkout_request_id is missing)
    await db.query(
      `INSERT INTO tuma_transactions
         (sale_id, checkout_request_id, merchant_request_id, phone, amount, payment_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (checkout_request_id) DO UPDATE SET
         merchant_request_id=EXCLUDED.merchant_request_id, phone=EXCLUDED.phone,
         amount=EXCLUDED.amount, status='pending', initiated_at=NOW()`,
      [sale_id, checkoutRequestId || reference, merchantRequestId, fmtPhone, amount, reference]
    );

    await log(req.user.id, req.user.name, req.user.role, 'tuma_stk_sent',
      sale.txn_id, `Phone: ${phone}, KES ${amount}, Ref: ${reference}`, 'sale', req.ip);

    // Always return our reference - this is what the frontend will use for polling
    res.json({
      message:             tumaResp.customer_message || 'STK push sent',
      checkout_request_id: checkoutRequestId,
      reference:           reference,  // Our generated reference for tracking
    });
  } catch (err) {
    console.error('[Tuma STK Push]', err.message);
    res.status(500).json({ error: err.message || 'Failed to initiate payment.' });
  }
});

// ── POST /api/tuma/callback ───────────────────────────────────────
// Tuma POSTs here. ACK immediately, process asynchronously.
// Also supports GET for testing/debugging purposes.
const handleTumaCallback = async (req, res) => {
  res.json({ success: true, message: 'Received' }); // fast ACK

  try {
    const body        = req.body;
    const status      = body?.status;
    const resultCode  = body?.result_code;
    const resultDesc  = body?.result_desc      || '';
    const checkoutId  = body?.checkout_request_id;
    const paymentRef  = body?.receipt_number || body?.mpesa_receipt_number || '';
    const failReason  = body?.failure_reason   || '';

    // Extract additional customer information if available
    // Tuma/M-Pesa may provide: msisdn, firstname, middlename, lastname, bank name, etc.
    const customerPhone = body?.msisdn || body?.phone || body?.phone_number || body?.Msisdn || '';
    const firstName     = body?.firstname || body?.FirstName || body?.first_name || '';
    const middleName    = body?.middlename || body?.MiddleName || body?.middle_name || '';
    const lastName      = body?.lastname || body?.LastName || body?.last_name || '';
    const bankName      = body?.bank_name || body?.BankName || body?.bank || body?.Bank || '';
    const accountNumber = body?.account_number || body?.AccountNumber || body?.account || '';

    // Build full customer name if available
    const customerName = [firstName, middleName, lastName].filter(Boolean).join(' ') || '';

    console.log('[Tuma Callback]', JSON.stringify(body, null, 2));
    if (!checkoutId) return;

    const { rows: [txn] } = await db.query(
      'SELECT * FROM tuma_transactions WHERE checkout_request_id=$1', [checkoutId]
    );
    if (!txn) { console.warn('[Tuma Callback] No txn for', checkoutId); return; }

    // Idempotency: skip if already processed
    if (txn.status !== 'pending') {
      console.log(`[Tuma Callback] Already ${txn.status}, skipping`);
      return;
    }

    if (status === 'completed' || resultCode === 0) {
      await db.query(
        `UPDATE tuma_transactions SET status='success', payment_ref=$1,
         confirmed_at=NOW(), result_code=$2, result_desc=$3
         WHERE checkout_request_id=$4`,
        [paymentRef, resultCode, resultDesc, checkoutId]
      );
      const done = await completeSale(txn.sale_id, paymentRef);
      await resetCancels(txn.phone);

      // Get customer name from sales table (use mpesa_phone column)
      const { rows: [saleRow] } = await db.query(
        'SELECT s.txn_id, s.mpesa_phone, u.name as cashier_name FROM sales s LEFT JOIN users u ON s.cashier_id = u.id WHERE s.id = $1',
        [txn.sale_id]
      );

      console.log(`[Tuma Callback] ✅ Payment Confirmed`);
      console.log(`  Sale ID: ${txn.sale_id} (${saleRow?.txn_id || 'N/A'})`);
      console.log(`  Tuma Ref: ${paymentRef || 'N/A'}`);
      console.log(`  Phone: ${txn.phone}`);
      console.log(`  Amount: KES ${txn.amount}`);
      console.log(`  Customer: ${saleRow?.mpesa_phone || 'N/A'}`);
      console.log(`  Cashier: ${saleRow?.cashier_name || 'N/A'}`);
      console.log(`  Status: ${done ? 'completed' : 'already done'}`);
    } else {
      await db.query(
        `UPDATE tuma_transactions SET status='failed', result_code=$1,
         result_desc=$2, confirmed_at=NOW() WHERE checkout_request_id=$3`,
        [resultCode, resultDesc || failReason, checkoutId]
      );
      await db.query("UPDATE sales SET status='failed' WHERE id=$1", [txn.sale_id]);

      // Cancellation policy
      if (resultCode === 1032) {
        await recordCancellation(txn.phone);
      }
      console.log(`[Tuma Callback] ❌ code=${resultCode}: ${resultDesc || failReason}`);
    }
  } catch (err) {
    console.error('[Tuma Callback] Error:', err.message);
  }
};
router.post('/callback', handleTumaCallback);
router.get('/callback', handleTumaCallback);

// ── GET /api/tuma/status/:id ──────────────────────────────────────
// Accepts either checkout_request_id or our generated payment_ref (TUMA-...)
router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try to find by payment_ref first (our generated reference like TUMA-...)
    let { rows: [txn] } = await db.query(
      `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
       FROM tuma_transactions tt JOIN sales s ON tt.sale_id=s.id
       WHERE tt.payment_ref=$1`, [id]
    );
    
    // If not found, try checkout_request_id
    if (!txn) {
      const { rows: rows2 } = await db.query(
        `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
         FROM tuma_transactions tt JOIN sales s ON tt.sale_id=s.id
         WHERE tt.checkout_request_id=$1`, [id]
      );
      txn = rows2;
    }
    
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    // Sync if callback already fired
    if (txn.sale_status === 'completed' && txn.status !== 'success') {
      await db.query(
        "UPDATE tuma_transactions SET status='success', confirmed_at=NOW() WHERE checkout_request_id=$1",
        [txn.checkout_request_id]
      );
    }
    if (txn.sale_status === 'completed') {
      return res.json({ status: 'success', payment_ref: txn.payment_ref||'', txn_id: txn.txn_id, amount: txn.amount });
    }

    const ageMs = txn.initiated_at ? Date.now() - new Date(txn.initiated_at).getTime() : 0;

    // Auto-timeout after 90 s
    if (txn.status === 'pending' && ageMs > 90000) {
      await db.query(
        `UPDATE tuma_transactions SET status='timeout', confirmed_at=NOW()
         WHERE checkout_request_id=$1 AND status='pending'`, [txn.checkout_request_id]
      );
      return res.json({ status: 'timeout', txn_id: txn.txn_id, amount: txn.amount, age_ms: ageMs });
    }

    res.json({ status: txn.status, payment_ref: txn.payment_ref||null,
               txn_id: txn.txn_id, amount: txn.amount, age_ms: ageMs });
  } catch (err) {
    console.error('[Tuma Status]', err.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ── POST /api/tuma/confirm-manual ────────────────────────────────
router.post('/confirm-manual', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id } = req.body;
    let resolvedSaleId = sale_id;
    if (checkout_request_id && !resolvedSaleId) {
      const { rows: [t] } = await db.query(
        'SELECT sale_id FROM tuma_transactions WHERE checkout_request_id=$1', [checkout_request_id]
      );
      if (t) resolvedSaleId = t.sale_id;
    }
    if (!resolvedSaleId) return res.status(400).json({ error: 'sale_id or checkout_request_id required' });

    const { rows: [sale] } = await db.query('SELECT id, cashier_id, status FROM sales WHERE id=$1', [resolvedSaleId]);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const isAdmin = ['super_admin','admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (sale.status === 'completed') return res.json({ message: 'Already completed', status: 'completed' });

    const manualRef = `MANUAL-${Date.now()}`;
    await completeSale(resolvedSaleId, manualRef);
    if (checkout_request_id) {
      await db.query(
        `UPDATE tuma_transactions SET status='success', payment_ref=$1, confirmed_at=NOW()
         WHERE checkout_request_id=$2`, [manualRef, checkout_request_id]
      );
    }
    await log(req.user.id, req.user.name, req.user.role, 'tuma_manual_confirm',
      `sale_${resolvedSaleId}`, `Manually confirmed by ${req.user.name}`, 'sale', req.ip);

    res.json({ message: 'Sale completed manually', status: 'completed', payment_ref: manualRef });
  } catch (err) {
    console.error('[Manual Confirm]', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── POST /api/tuma/confirm-by-ref ────────────────────────────────
router.post('/confirm-by-ref', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id, payment_ref } = req.body;
    if (!payment_ref) return res.status(400).json({ error: 'payment_ref required' });

    let resolvedSaleId = sale_id;
    if (checkout_request_id && !resolvedSaleId) {
      const { rows: [t] } = await db.query(
        'SELECT sale_id FROM tuma_transactions WHERE checkout_request_id=$1', [checkout_request_id]
      );
      if (t) resolvedSaleId = t.sale_id;
    }
    if (!resolvedSaleId) return res.status(400).json({ error: 'sale_id or checkout_request_id required' });

    const { rows: [sale] } = await db.query('SELECT id, cashier_id, status FROM sales WHERE id=$1', [resolvedSaleId]);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const isAdmin = ['super_admin','admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const completed = await completeSale(resolvedSaleId, payment_ref);
    if (checkout_request_id) {
      await db.query(
        `UPDATE tuma_transactions SET status='success', payment_ref=$1, confirmed_at=NOW()
         WHERE checkout_request_id=$2`, [payment_ref, checkout_request_id]
      );
    }
    await log(req.user.id, req.user.name, req.user.role, 'tuma_ref_confirm',
      `sale_${resolvedSaleId}`, `Ref: ${payment_ref}`, 'sale', req.ip);

    res.json({ message: completed ? 'Sale confirmed' : 'Already completed', status: 'completed', payment_ref });
  } catch (err) {
    console.error('[Confirm by Ref]', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── GET /api/tuma/test-credentials ───────────────────────────────
router.get('/test-credentials', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const result = await testCredentials();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── GET /api/tuma/cancel-blocks ──────────────────────────────────
router.get('/cancel-blocks', requireAuth, ADMIN_UP, async (req, res) => {
  const { rows } = await db.query(
    `SELECT phone, consecutive_cancels, last_cancel_at, blocked_at
     FROM tuma_cancel_blocks WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC`
  );
  res.json({ blocked: rows });
});

// ── DELETE /api/tuma/cancel-blocks/:phone ────────────────────────
router.delete('/cancel-blocks/:phone', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const phone = formatPhone(req.params.phone);
    await db.query(
      `UPDATE tuma_cancel_blocks
       SET consecutive_cancels=0, blocked_at=NULL, last_cancel_at=NULL WHERE phone=$1`, [phone]
    );
    await log(req.user.id, req.user.name, req.user.role, 'tuma_unblock',
      phone, `Unblocked by ${req.user.name}`, 'system', req.ip);
    res.json({ message: `Phone ${phone} unblocked` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
