/**
 * tuma.js routes — Tuma Payment Solutions integration
 *
 * POST /api/tuma/stk-push          → initiate payment (checks block first)
 * POST /api/tuma/callback          → Tuma webhook (must be public HTTPS)
 * GET  /api/tuma/status/:id        → frontend polling (supports TUMA-*, checkout_id, merchant_id, sale_id)
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
  const { rows: [sale] } = await db.query(
    'SELECT status, selling_total, tuma_ref, mpesa_ref FROM sales WHERE id = $1', 
    [saleId]
  );
  
  // If sale doesn't exist or is already completed, return false (no action taken)
  if (!sale) return false;
  if (sale.status === 'completed') {
    console.log(`[Tuma] Sale ${saleId} already completed - skipping (idempotent)`);
    return false;
  }
  
  // Prevent completing failed sales
  if (sale.status === 'failed') {
    console.log(`[Tuma] Sale ${saleId} is marked as failed - cannot complete`);
    return false;
  }

  // Use atomic update to prevent race conditions
  const { rows: [updated] } = await db.query(
    `UPDATE sales 
     SET status='completed', 
         tuma_ref=COALESCE($1, tuma_ref), 
         mpesa_ref=COALESCE($1, mpesa_ref), 
         amount_paid=selling_total
     WHERE id=$2 
     AND status NOT IN ('completed', 'failed')
     RETURNING id`,
    [paymentRef, saleId]
  );
  
  // If no rows were updated, the sale was already completed by another process
  if (!updated) {
    console.log(`[Tuma] Sale ${saleId} was completed by another process - skipping`);
    return false;
  }

  await deductStock(saleId);

  // Async SMS confirmation
  try {
    const { rows: [saleRow] } = await db.query(
      'SELECT txn_id, selling_total, phone FROM sales WHERE id = $1', [saleId]
    );
    const { rows: saleItems } = await db.query(
      'SELECT product_name, size, qty FROM sale_items WHERE sale_id = $1', [saleId]
    );
    if (saleRow?.phone) {
      sendSaleConfirmationSMS(db, {
        customerPhone: saleRow.phone, txnId: saleRow.txn_id,
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
    
    // Accept pending_tuma, pending_mpesa (legacy), and pending_split statuses
    if (!['pending_mpesa', 'pending_tuma', 'pending_split'].includes(sale.status))
      return res.status(400).json({ error: `Sale is already ${sale.status}` });

    // Generate a reference immediately - this will be used for tracking and frontend polling
    const reference = `TUMA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    
    console.log(`[Tuma STK Push] Generated reference: ${reference} for sale ${sale_id}`);

    const tumaResp = await stkPush(phone, amount, sale.txn_id);

    // Handle different Tuma API response formats
    const checkoutRequestId = tumaResp.checkout_request_id 
      || tumaResp.checkoutRequestID 
      || tumaResp.CheckoutRequestID
      || (tumaResp.data && tumaResp.data.checkout_request_id)
      || (tumaResp.data && tumaResp.data.checkoutRequestID)
      || (tumaResp.response && tumaResp.response.checkout_request_id)
      || reference; // Fallback to our reference if none provided

    const merchantRequestId = tumaResp.merchant_request_id 
      || tumaResp.merchantRequestID 
      || tumaResp.MerchantRequestID
      || (tumaResp.data && tumaResp.data.merchant_request_id)
      || (tumaResp.data && tumaResp.data.merchantRequestID)
      || null;

    // IMPORTANT: Insert transaction with BOTH IDs - our reference AND Tuma's checkout ID
    // This ensures the frontend can find the transaction using our TUMA-* reference
    const insertResult = await db.query(
      `INSERT INTO tuma_transactions
         (sale_id, checkout_request_id, merchant_request_id, phone, amount, payment_ref, status, initiated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
       ON CONFLICT (checkout_request_id) DO UPDATE SET
         merchant_request_id = EXCLUDED.merchant_request_id, 
         phone = EXCLUDED.phone,
         amount = EXCLUDED.amount, 
         payment_ref = EXCLUDED.payment_ref,
         status = 'pending', 
         initiated_at = NOW()
       RETURNING id, payment_ref, checkout_request_id`,
      [sale_id, checkoutRequestId, merchantRequestId, fmtPhone, amount, reference]
    );
    
    const inserted = insertResult.rows[0];
    console.log(`[Tuma STK Push] Transaction inserted: id=${inserted.id}, payment_ref=${inserted.payment_ref}, checkout_id=${inserted.checkout_request_id}`);

    await log(req.user.id, req.user.name, req.user.role, 'tuma_stk_sent',
      sale.txn_id, `Phone: ${phone}, KES ${amount}, Ref: ${reference}`, 'sale', req.ip);

    // Return our reference - this is what the frontend MUST use for polling
    res.json({
      success: true,
      message: tumaResp.customer_message || 'STK push sent',
      checkout_request_id: checkoutRequestId,
      reference: reference,  // CRITICAL: Frontend must use this for polling
      merchant_request_id: merchantRequestId,
      transaction_id: inserted.id
    });
  } catch (err) {
    console.error('[Tuma STK Push] Error:', err.message);
    console.error('[Tuma STK Push] Stack:', err.stack);
    res.status(500).json({ error: err.message || 'Failed to initiate payment.' });
  }
});

// ── POST /api/tuma/callback ───────────────────────────────────────
const handleTumaCallback = async (req, res) => {
  // Log the raw callback body first
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[Tuma Callback] RAW BODY:', JSON.stringify(req.body, null, 2));
  console.log('═══════════════════════════════════════════════════════════');

  // Send immediate ACK to prevent timeout
  res.status(200).json({ success: true, message: 'Received' });

  try {
    const body = req.body;
    
    // STEP 1: Extract M-Pesa receipt number (priority order)
    const paymentRef = body?.receipt_number 
                    || body?.mpesa_receipt_number 
                    || body?.MpesaReceiptNumber 
                    || body?.ReceiptNumber 
                    || body?.receiptNumber
                    || body?.TransactionID
                    || body?.TransID
                    || body?.trans_id
                    || body?.transaction_id
                    || body?.reference
                    || body?.Reference
                    || body?.mpesa_ref
                    || body?.MpesaRef
                    || body?.payment_ref
                    || body?.PaymentRef
                    || body?.ref
                    || body?.Ref
                    || '';
    
    // STEP 2: Extract status and result codes
    const status = body?.status || body?.Status || '';
    const resultCode = body?.result_code || body?.ResultCode || null;
    const resultDesc = body?.result_desc || body?.ResultDesc || body?.result_description || '';
    const failReason = body?.failure_reason || body?.FailureReason || '';
    
    // Get identifiers for database lookup
    const checkoutId = body?.checkout_request_id || body?.CheckoutRequestID || '';
    const merchantId = body?.merchant_request_id || body?.MerchantRequestID || '';
    const customerPhone = body?.msisdn || body?.phone || body?.phone_number || body?.Msisdn || '';
    const amount = body?.amount || body?.Amount || 0;

    console.log('[Tuma Callback] Extracted Data:');
    console.log('  paymentRef:', paymentRef);
    console.log('  status:', status);
    console.log('  resultCode:', resultCode);
    console.log('  checkoutId:', checkoutId);
    console.log('  merchantId:', merchantId);
    console.log('  phone:', customerPhone);
    console.log('  amount:', amount);
    
    // STEP 3: Find transaction in database (try multiple strategies)
    let txn = null;
    
    // Strategy 1: By checkout_request_id (most reliable)
    if (checkoutId && !txn) {
      const result = await db.query(
        'SELECT * FROM tuma_transactions WHERE checkout_request_id = $1', [checkoutId]
      );
      txn = result.rows[0];
      if (txn) console.log('[Tuma Callback] ✅ Found by checkout_request_id');
    }
    
    // Strategy 2: By merchant_request_id
    if (merchantId && !txn) {
      const result = await db.query(
        'SELECT * FROM tuma_transactions WHERE merchant_request_id = $1', [merchantId]
      );
      txn = result.rows[0];
      if (txn) console.log('[Tuma Callback] ✅ Found by merchant_request_id');
    }
    
    // Strategy 3: By our payment_ref (TUMA-...)
    if (paymentRef && !txn) {
      const result = await db.query(
        'SELECT * FROM tuma_transactions WHERE payment_ref = $1', [paymentRef]
      );
      txn = result.rows[0];
      if (txn) console.log('[Tuma Callback] ✅ Found by payment_ref');
    }
    
    // Strategy 4: By phone + amount + recent (fallback)
    if (customerPhone && amount && !txn) {
      const result = await db.query(
        `SELECT * FROM tuma_transactions 
         WHERE phone = $1 AND amount = $2 
         AND status = 'pending' 
         AND initiated_at > NOW() - INTERVAL '5 minutes'
         ORDER BY initiated_at DESC LIMIT 1`,
        [customerPhone, parseFloat(amount)]
      );
      txn = result.rows[0];
      if (txn) console.log('[Tuma Callback] ✅ Found by phone+amount (fallback)');
    }
    
    if (!txn) {
      console.error('[Tuma Callback] ❌ TRANSACTION NOT FOUND in database!');
      console.error('  Searched with:');
      console.error('  - checkoutId:', checkoutId);
      console.error('  - merchantId:', merchantId);
      console.error('  - paymentRef:', paymentRef);
      console.error('  - phone:', customerPhone);
      console.error('  - amount:', amount);
      return;
    }

    console.log(`[Tuma Callback] 📦 Found transaction: id=${txn.id}, sale_id=${txn.sale_id}, current_status=${txn.status}, payment_ref=${txn.payment_ref}`);

    // Skip if already processed
    if (txn.status !== 'pending') {
      console.log(`[Tuma Callback] ⏭️ Already processed (${txn.status}), skipping`);
      return;
    }

    console.log(`[Tuma Callback] 🔄 Processing transaction ID: ${txn.id}, Sale ID: ${txn.sale_id}`);

    // STEP 4: Process based on payment status
    const isSuccess = status === 'completed' || resultCode === 0 || resultCode === '0';
    
    if (isSuccess) {
      const finalPaymentRef = paymentRef || txn.payment_ref;
      console.log(`[Tuma Callback] ✅ SUCCESS - Completing sale ${txn.sale_id} with ref ${finalPaymentRef}`);
      
      // Update transaction as successful
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'success', 
             payment_ref = COALESCE($1, payment_ref),
             confirmed_at = NOW(), 
             result_code = $2, 
             result_desc = $3
         WHERE id = $4`,
        [finalPaymentRef, resultCode, resultDesc, txn.id]
      );
      
      // Complete the sale (idempotent)
      const completed = await completeSale(txn.sale_id, finalPaymentRef);
      
      // Reset cancellation counter on success
      await resetCancels(txn.phone);

      console.log(`[Tuma Callback] 🎉 Payment Confirmed & Sale Completed`);
      console.log(`  Sale ID: ${txn.sale_id}`);
      console.log(`  Payment Ref: ${finalPaymentRef}`);
      console.log(`  Phone: ${txn.phone}`);
      console.log(`  Amount: KES ${txn.amount}`);
      console.log(`  Result: ${completed ? 'NEWLY COMPLETED' : 'ALREADY COMPLETED'}`);
    } else {
      // Handle failure/cancellation
      console.log(`[Tuma Callback] ❌ FAILED - Marking sale ${txn.sale_id} as failed`);
      
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'failed', 
             result_code = $1,
             result_desc = $2, 
             confirmed_at = NOW() 
         WHERE id = $3`,
        [resultCode, resultDesc || failReason, txn.id]
      );
      
      // Update sale status only if not already completed
      await db.query(
        "UPDATE sales SET status = 'failed' WHERE id = $1 AND status NOT IN ('completed')", 
        [txn.sale_id]
      );

      // Handle cancellation policy (result_code 1032 = user cancelled)
      if (resultCode === 1032 || resultCode === '1032') {
        const cancelResult = await recordCancellation(txn.phone);
        if (cancelResult.blocked) {
          console.warn(`[Tuma Callback] 🚫 Phone ${txn.phone} BLOCKED after 3 cancellations`);
        }
      }
      
      console.log(`[Tuma Callback] ❌ Failed - Code: ${resultCode}, Reason: ${resultDesc || failReason}`);
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('[Tuma Callback] ✅ Processing COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
  } catch (err) {
    console.error('═══════════════════════════════════════════════════════════');
    console.error('[Tuma Callback] ❌ ERROR:', err.message);
    console.error('Stack:', err.stack);
    console.error('═══════════════════════════════════════════════════════════');
  }
};

router.post('/callback', handleTumaCallback);
router.get('/callback', handleTumaCallback); // For testing/debugging

// ── GET /api/tuma/status/:id ──────────────────────────────────────
// Supports: TUMA-* (payment_ref), checkout_request_id, merchant_request_id, or sale_id
router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`[Tuma Status] 🔍 Looking up transaction with ID: ${id}`);
    
    let txn = null;
    
    // Strategy 1: Search by payment_ref (TUMA-* reference)
    const { rows: [byPaymentRef] } = await db.query(
      `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
       FROM tuma_transactions tt 
       JOIN sales s ON tt.sale_id = s.id
       WHERE tt.payment_ref = $1`,
      [id]
    );
    txn = byPaymentRef;
    if (txn) console.log(`[Tuma Status] ✅ Found by payment_ref`);
    
    // Strategy 2: Search by checkout_request_id
    if (!txn) {
      const { rows: [byCheckout] } = await db.query(
        `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
         FROM tuma_transactions tt 
         JOIN sales s ON tt.sale_id = s.id
         WHERE tt.checkout_request_id = $1`,
        [id]
      );
      txn = byCheckout;
      if (txn) console.log(`[Tuma Status] ✅ Found by checkout_request_id`);
    }
    
    // Strategy 3: Search by merchant_request_id
    if (!txn) {
      const { rows: [byMerchant] } = await db.query(
        `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
         FROM tuma_transactions tt 
         JOIN sales s ON tt.sale_id = s.id
         WHERE tt.merchant_request_id = $1`,
        [id]
      );
      txn = byMerchant;
      if (txn) console.log(`[Tuma Status] ✅ Found by merchant_request_id`);
    }
    
    // Strategy 4: If ID is numeric, search by sale_id
    if (!txn && /^\d+$/.test(id)) {
      const { rows: [bySaleId] } = await db.query(
        `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
         FROM tuma_transactions tt 
         JOIN sales s ON tt.sale_id = s.id
         WHERE tt.sale_id = $1
         ORDER BY tt.initiated_at DESC
         LIMIT 1`,
        [parseInt(id)]
      );
      txn = bySaleId;
      if (txn) console.log(`[Tuma Status] ✅ Found by sale_id: ${id}`);
    }
    
    // Strategy 5: Last resort - get most recent transaction for this user session
    if (!txn && id.startsWith('TUMA-')) {
      const { rows: [recent] } = await db.query(
        `SELECT tt.*, s.txn_id, s.selling_total, s.status AS sale_status
         FROM tuma_transactions tt 
         JOIN sales s ON tt.sale_id = s.id
         WHERE tt.initiated_at > NOW() - INTERVAL '10 minutes'
         ORDER BY tt.initiated_at DESC
         LIMIT 1`
      );
      txn = recent;
      if (txn) console.log(`[Tuma Status] ✅ Found most recent transaction as fallback`);
    }
    
    if (!txn) {
      console.log(`[Tuma Status] ❌ No transaction found for: ${id}`);
      return res.status(404).json({ 
        success: false,
        error: 'Transaction not found',
        id: id 
      });
    }
    
    console.log(`[Tuma Status] ✅ Found transaction:`, {
      id: txn.id,
      payment_ref: txn.payment_ref,
      checkout_request_id: txn.checkout_request_id,
      status: txn.status,
      sale_status: txn.sale_status,
      sale_id: txn.sale_id
    });
    
    // Sync if callback already fired but status not updated in tuma_transactions
    if (txn.sale_status === 'completed' && txn.status !== 'success') {
      console.log(`[Tuma Status] 🔄 Syncing status - sale completed but transaction pending`);
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'success', confirmed_at = NOW() 
         WHERE id = $1 AND status = 'pending'`,
        [txn.id]
      );
      txn.status = 'success';
    }
    
    // Return completed status immediately
    if (txn.sale_status === 'completed' || txn.status === 'success') {
      return res.json({ 
        success: true,
        status: 'success', 
        payment_ref: txn.payment_ref || '', 
        txn_id: txn.txn_id, 
        amount: txn.amount,
        sale_id: txn.sale_id
      });
    }
    
    // Calculate age for timeout logic
    const ageMs = txn.initiated_at ? Date.now() - new Date(txn.initiated_at).getTime() : 0;
    const ageSeconds = Math.floor(ageMs / 1000);
    
    // Auto-timeout after 90 seconds (standard M-Pesa timeout)
    if (txn.status === 'pending' && ageMs > 90000) {
      console.log(`[Tuma Status] ⏰ Auto-timeout after ${ageSeconds}s`);
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'timeout', confirmed_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [txn.id]
      );
      return res.json({ 
        success: true,
        status: 'timeout', 
        txn_id: txn.txn_id, 
        amount: txn.amount, 
        age_seconds: ageSeconds,
        message: 'Payment request timed out'
      });
    }
    
    // Return current status for pending/failed transactions
    const response = { 
      success: true,
      status: txn.status, 
      payment_ref: txn.payment_ref || null,
      txn_id: txn.txn_id, 
      amount: txn.amount, 
      age_seconds: ageSeconds,
      sale_id: txn.sale_id
    };
    
    // Include error details for failed transactions
    if (txn.status === 'failed' && txn.result_code !== null) {
      response.error_code = txn.result_code;
      response.error_message = txn.result_desc || 'Payment failed';
      
      // Special handling for user cancellation
      if (txn.result_code === 1032 || txn.result_code === '1032') {
        response.error_message = 'Payment was cancelled by user';
      }
    }
    
    // For pending transactions, include helpful info
    if (txn.status === 'pending') {
      response.message = 'Waiting for payment confirmation on your phone';
      response.remaining_seconds = Math.max(0, 90 - ageSeconds);
    }
    
    res.json(response);
  } catch (err) {
    console.error('[Tuma Status] ❌ Error:', err.message);
    console.error('[Tuma Status] Stack:', err.stack);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check payment status',
      details: err.message 
    });
  }
});

// ── POST /api/tuma/confirm-manual ────────────────────────────────
router.post('/confirm-manual', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id } = req.body;
    let resolvedSaleId = sale_id;
    
    if (checkout_request_id && !resolvedSaleId) {
      const { rows: [t] } = await db.query(
        'SELECT sale_id FROM tuma_transactions WHERE checkout_request_id = $1', 
        [checkout_request_id]
      );
      if (t) resolvedSaleId = t.sale_id;
    }
    
    if (!resolvedSaleId) {
      return res.status(400).json({ error: 'sale_id or checkout_request_id required' });
    }

    const { rows: [sale] } = await db.query(
      'SELECT id, cashier_id, status FROM sales WHERE id = $1', 
      [resolvedSaleId]
    );
    
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (sale.status === 'completed') {
      return res.json({ message: 'Already completed', status: 'completed' });
    }

    const manualRef = `MANUAL-${Date.now()}`;
    await completeSale(resolvedSaleId, manualRef);
    
    if (checkout_request_id) {
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'success', payment_ref = $1, confirmed_at = NOW()
         WHERE checkout_request_id = $2 AND status != 'success'`, 
        [manualRef, checkout_request_id]
      );
    }
    
    await log(req.user.id, req.user.name, req.user.role, 'tuma_manual_confirm',
      `sale_${resolvedSaleId}`, `Manually confirmed by ${req.user.name}`, 'sale', req.ip);

    res.json({ 
      message: 'Sale completed manually', 
      status: 'completed', 
      payment_ref: manualRef 
    });
  } catch (err) {
    console.error('[Manual Confirm]', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── POST /api/tuma/confirm-by-ref ────────────────────────────────
router.post('/confirm-by-ref', requireAuth, async (req, res) => {
  try {
    const { checkout_request_id, sale_id, payment_ref } = req.body;
    
    if (!payment_ref) {
      return res.status(400).json({ error: 'payment_ref required' });
    }

    let resolvedSaleId = sale_id;
    
    if (checkout_request_id && !resolvedSaleId) {
      const { rows: [t] } = await db.query(
        'SELECT sale_id FROM tuma_transactions WHERE checkout_request_id = $1', 
        [checkout_request_id]
      );
      if (t) resolvedSaleId = t.sale_id;
    }
    
    if (!resolvedSaleId) {
      return res.status(400).json({ error: 'sale_id or checkout_request_id required' });
    }

    const { rows: [sale] } = await db.query(
      'SELECT id, cashier_id, status FROM sales WHERE id = $1', 
      [resolvedSaleId]
    );
    
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const completed = await completeSale(resolvedSaleId, payment_ref);
    
    if (checkout_request_id) {
      await db.query(
        `UPDATE tuma_transactions 
         SET status = 'success', payment_ref = $1, confirmed_at = NOW()
         WHERE checkout_request_id = $2 AND status != 'success'`, 
        [payment_ref, checkout_request_id]
      );
    }
    
    await log(req.user.id, req.user.name, req.user.role, 'tuma_ref_confirm',
      `sale_${resolvedSaleId}`, `Ref: ${payment_ref}`, 'sale', req.ip);

    res.json({ 
      message: completed ? 'Sale confirmed' : 'Already completed', 
      status: 'completed', 
      payment_ref 
    });
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
  try {
    const { rows } = await db.query(
      `SELECT phone, consecutive_cancels, last_cancel_at, blocked_at
       FROM tuma_cancel_blocks 
       WHERE blocked_at IS NOT NULL 
       ORDER BY blocked_at DESC`
    );
    res.json({ blocked: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tuma/cancel-blocks/:phone ────────────────────────
router.delete('/cancel-blocks/:phone', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const phone = formatPhone(req.params.phone);
    await db.query(
      `UPDATE tuma_cancel_blocks
       SET consecutive_cancels = 0, blocked_at = NULL, last_cancel_at = NULL 
       WHERE phone = $1`, 
      [phone]
    );
    await log(req.user.id, req.user.name, req.user.role, 'tuma_unblock',
      phone, `Unblocked by ${req.user.name}`, 'system', req.ip);
    res.json({ message: `Phone ${phone} unblocked` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;