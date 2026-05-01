/**
 * returns.js — Returns & Refunds
 * Uses ONLY existing tables (sales, sale_items, products)
 *
 * FIX: Removed local query() helper that conflicted with connection.js dual-style
 *      wrapper. Now uses db.query() with { rows } destructuring throughout.
 * FIX: Stores JOIN removed from main lookup — fetched separately with try/catch
 *      so a missing/null store never crashes the entire lookup.
 * FIX: Real DB error now exposed in 500 response for easier debugging.
 */

const express = require('express');
const db = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN = requireRole('super_admin', 'admin');
const RETURN_WINDOW_DAYS = 120;

// ── GET /api/returns/lookup/:ref ──────────────────────────────────
router.get('/lookup/:ref', requireAuth, ADMIN, async (req, res) => {
  try {
    const ref = req.params.ref?.trim()?.toUpperCase();
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Transaction reference is required' });
    }

    console.log(`[Returns] Looking up: ${ref}`);

    // No stores JOIN — avoids crash when store_id is null or stores table issue
    const { rows: sales } = await db.query(`
      SELECT
        s.id, s.txn_id, s.cashier_id, s.store_id,
        s.selling_total, s.amount_paid, s.status,
        s.sale_date, s.phone, s.tuma_ref, s.mpesa_ref,
        u.name AS cashier_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.cashier_id
      WHERE s.txn_id = $1 OR s.tuma_ref = $1 OR s.mpesa_ref = $1
      LIMIT 1
    `, [ref]);

    if (!sales.length) {
      return res.status(404).json({ success: false, error: `No sale found for "${ref}"` });
    }

    const sale = sales[0];

    // Days since sale
    const saleDate = new Date(sale.sale_date);
    const daysSinceSale = Math.floor((Date.now() - saleDate) / (1000 * 60 * 60 * 24));
    const withinWindow = daysSinceSale <= RETURN_WINDOW_DAYS;

    // Get sale items
    const { rows: items } = await db.query(`
      SELECT id, product_id, product_name, size, qty, selling_price, sku
      FROM sale_items
      WHERE sale_id = $1
    `, [sale.id]);

    // Get store name safely — won't crash main lookup if it fails
    let storeName = 'Main Store';
    if (sale.store_id) {
      try {
        const { rows: [store] } = await db.query('SELECT name FROM stores WHERE id = $1', [sale.store_id]);
        if (store?.name) storeName = store.name;
      } catch { /* use default */ }
    }

    const itemsWithReturnable = items.map(item => ({
      id:            item.id,
      sale_item_id:  item.id,
      product_id:    item.product_id,
      product_name:  item.product_name,
      size:          item.size,
      qty:           item.qty,
      selling_price: parseFloat(item.selling_price) || 0,
      sku:           item.sku,
      returnable_qty: item.qty,
    }));

    res.json({
      success: true,
      sale: {
        id:            sale.id,
        txn_id:        sale.txn_id,
        selling_total: parseFloat(sale.selling_total) || 0,
        sale_date:     sale.sale_date,
        cashier_name:  sale.cashier_name || 'Cashier',
        store_name:    storeName,
        phone:         sale.phone,
      },
      items: itemsWithReturnable,
      return_window_days: RETURN_WINDOW_DAYS,
      within_window:  withinWindow,
      days_since_sale: daysSinceSale,
      can_return:     withinWindow,
      message: withinWindow ? null : `Return window expired (${RETURN_WINDOW_DAYS} days / 4 months)`,
    });

  } catch (err) {
    console.error('[Returns] Lookup error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to lookup transaction', message: err.message });
  }
});

// ── POST /api/returns ─────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
  const client = await db.connect();
  try {
    const { original_sale_id, items, reason } = req.body;
    if (!original_sale_id || !items?.length) {
      return res.status(400).json({ error: 'Sale ID and items are required' });
    }

    console.log(`[Returns] Processing return for sale ${original_sale_id}`);

    await client.query('BEGIN');

    const { rows: sales } = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [original_sale_id]);
    if (!sales.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sale not found' });
    }

    const sale = sales[0];
    const daysSince = Math.floor((Date.now() - new Date(sale.sale_date)) / (1000 * 60 * 60 * 24));
    if (daysSince > RETURN_WINDOW_DAYS) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Return window expired (${RETURN_WINDOW_DAYS} days / 4 months)` });
    }

    // Get all sale items for this sale
    const { rows: allSaleItems } = await client.query(
      'SELECT * FROM sale_items WHERE sale_id = $1',
      [original_sale_id]
    );

    // Track what's being returned vs kept
    let totalRefund = 0;
    const returnedItems = [];
    const itemsToKeep = []; // Items that are NOT being returned

    for (const saleItem of allSaleItems) {
      // Check if this item is being returned
      const returnEntry = items.find(i => i.sale_item_id === saleItem.id);

      if (returnEntry) {
        // This item is being returned (possibly partially)
        const returnQty = parseInt(returnEntry.qty) || 0;
        const keepQty = saleItem.qty - returnQty;

        if (returnQty > 0) {
          const refundAmount = parseFloat(saleItem.selling_price || 0) * returnQty;
          totalRefund += refundAmount;

          // Restock the returned items (only if condition allows)
          if (returnEntry.restock !== false && returnEntry.condition !== 'unsellable') {
            await client.query(
              'UPDATE products SET stock = stock + $1 WHERE id = $2',
              [returnQty, saleItem.product_id]
            );
            console.log(`[Returns] Restocked ${returnQty} of ${saleItem.product_name}`);
          }

          returnedItems.push({
            product_name: saleItem.product_name,
            qty: returnQty,
            refund: refundAmount,
            sku: saleItem.sku,
            size: saleItem.size
          });
        }

        // If there are remaining items to keep, add to keep list
        if (keepQty > 0) {
          itemsToKeep.push({
            ...saleItem,
            qty: keepQty,
            extra_profit: saleItem.extra_profit * (keepQty / saleItem.qty),
            commission: saleItem.commission * (keepQty / saleItem.qty)
          });
        }
      } else {
        // This item is not being returned at all
        itemsToKeep.push(saleItem);
      }
    }

    // Check if ALL items are being returned
    const allItemsFullyReturned = itemsToKeep.length === 0;

    if (allItemsFullyReturned) {
      // ALL items returned - delete the entire sale
      // Delete sale_items first (or let ON DELETE CASCADE handle it)
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [original_sale_id]);
      await client.query('DELETE FROM sales WHERE id = $1', [original_sale_id]);
      console.log(`[Returns] Deleted sale ${original_sale_id} (${sale.txn_id}) - all items returned`);
    } else {
      // PARTIAL return - we need to:
      // 1. Delete the original sale and sale_items
      // 2. Create a new sale with only the kept items

      // Calculate new totals for the kept items
      let newSellingTotal = 0;
      let newExtraProfit = 0;
      let newCommission = 0;

      for (const item of itemsToKeep) {
        newSellingTotal += parseFloat(item.selling_price) * item.qty;
        newExtraProfit += parseFloat(item.extra_profit) || 0;
        newCommission += parseFloat(item.commission) || 0;
      }

      // Delete original sale items
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [original_sale_id]);

      // Update the sale with new totals
      await client.query(
        `UPDATE sales SET
          selling_total = $1,
          extra_profit = $2,
          commission = $3
         WHERE id = $4`,
        [newSellingTotal, newExtraProfit, newCommission, original_sale_id]
      );

      // Re-insert the kept items
      for (const item of itemsToKeep) {
        await client.query(
          `INSERT INTO sale_items
            (sale_id, product_id, product_name, sku, size, qty, min_price,
             selling_price, extra_profit, commission)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [original_sale_id, item.product_id, item.product_name, item.sku, item.size,
           item.qty, item.min_price, item.selling_price, item.extra_profit, item.commission]
        );
      }

      console.log(`[Returns] Updated sale ${original_sale_id} (${sale.txn_id}) - partial return, ${itemsToKeep.length} items kept`);
    }

    await log(req.user.id, req.user.name, req.user.role, 'return_processed',
      `Sale ${original_sale_id} (${sale.txn_id})`,
      `KES ${totalRefund} refunded. Items: ${returnedItems.map(i => `${i.qty}x ${i.product_name}`).join(', ')}. Reason: ${reason || 'None'}`,
      'sale', req.ip);

    await client.query('COMMIT');

    console.log(`[Returns] Return completed for sale ${original_sale_id}, refund: KES ${totalRefund}`);

    res.json({
      success: true,
      sale_id: original_sale_id,
      txn_id: sale.txn_id,
      total_refund: totalRefund,
      items_returned: returnedItems,
      sale_deleted: allItemsFullyReturned,
      message: allItemsFullyReturned
        ? `✅ Return processed. Sale deleted. KES ${totalRefund} refunded. Inventory restocked.`
        : `✅ Return processed. Sale updated. KES ${totalRefund} refunded. Inventory restocked.`,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Returns] POST error:', err.message);
    res.status(500).json({ error: 'Return processing failed: ' + err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    res.json({
      returns: [],
      total: 0,
      message: 'Returns are processed but not stored in a separate table. Check activity logs for return history.',
    });
  } catch (err) {
    console.error('[Returns] GET error:', err.message);
    res.json({ returns: [], total: 0 });
  }
});

module.exports = router;