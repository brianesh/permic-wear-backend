/**
 * returns.js — Returns & Refunds
 * Uses ONLY existing tables (sales, sale_items, products)
 * No return_items table needed
 */

const express = require('express');
const db = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN = requireRole('super_admin', 'admin');

const RETURN_WINDOW_DAYS = 120;

async function query(sql, params = []) {
    try {
        const result = await db.query(sql, params);
        if (result && result.rows) return result.rows;
        if (Array.isArray(result)) return result[0] || [];
        return [];
    } catch (err) {
        console.error('[DB Error]', err.message);
        throw err;
    }
}

// ── GET /api/returns/lookup/:ref ──────────────────────────────────
router.get('/lookup/:ref', requireAuth, ADMIN, async (req, res) => {
    try {
        const ref = req.params.ref?.trim()?.toUpperCase();
        
        if (!ref) {
            return res.status(400).json({ 
                success: false, 
                error: 'Transaction reference is required' 
            });
        }

        console.log(`[Returns] Looking up: ${ref}`);

        // Find the sale
        const sales = await query(`
            SELECT 
                s.id,
                s.txn_id,
                s.cashier_id,
                s.store_id,
                s.selling_total,
                s.amount_paid,
                s.status,
                s.sale_date,
                s.phone,
                s.tuma_ref,
                s.mpesa_ref,
                u.name as cashier_name,
                st.name as store_name
            FROM sales s
            LEFT JOIN users u ON u.id = s.cashier_id
            LEFT JOIN stores st ON st.id = s.store_id
            WHERE s.txn_id = $1 OR s.tuma_ref = $1 OR s.mpesa_ref = $1
            LIMIT 1
        `, [ref]);

        if (sales.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: `No sale found for "${ref}"`
            });
        }

        const sale = sales[0];

        // Calculate days since sale
        const saleDate = new Date(sale.sale_date);
        const daysSinceSale = Math.floor((Date.now() - saleDate) / (1000 * 60 * 60 * 24));
        const withinWindow = daysSinceSale <= RETURN_WINDOW_DAYS;

        // Get sale items
        const items = await query(`
            SELECT 
                id,
                product_id,
                product_name,
                size,
                qty,
                selling_price,
                sku
            FROM sale_items
            WHERE sale_id = $1
        `, [sale.id]);

        const itemsWithReturnable = items.map(item => ({
            id: item.id,
            sale_item_id: item.id,
            product_id: item.product_id,
            product_name: item.product_name,
            size: item.size,
            qty: item.qty,
            selling_price: parseFloat(item.selling_price) || 0,
            sku: item.sku,
            returnable_qty: item.qty
        }));

        res.json({
            success: true,
            sale: {
                id: sale.id,
                txn_id: sale.txn_id,
                selling_total: parseFloat(sale.selling_total) || 0,
                sale_date: sale.sale_date,
                cashier_name: sale.cashier_name || 'Cashier',
                store_name: sale.store_name || 'Main Store',
                phone: sale.phone
            },
            items: itemsWithReturnable,
            return_window_days: RETURN_WINDOW_DAYS,
            within_window: withinWindow,
            days_since_sale: daysSinceSale,
            can_return: withinWindow,
            message: withinWindow ? null : `Return window expired (${RETURN_WINDOW_DAYS} days / 4 months)`
        });

    } catch (err) {
        console.error('[Returns] Lookup error:', err.message);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to lookup transaction',
            message: err.message
        });
    }
});

// ── POST /api/returns ─────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
    try {
        const { original_sale_id, items, reason } = req.body;

        if (!original_sale_id || !items?.length) {
            return res.status(400).json({ 
                error: 'Sale ID and items are required' 
            });
        }

        console.log(`[Returns] Processing return for sale ${original_sale_id}`);

        // Get the sale
        const sales = await query(
            'SELECT * FROM sales WHERE id = $1',
            [original_sale_id]
        );

        if (sales.length === 0) {
            return res.status(404).json({ error: 'Sale not found' });
        }

        const sale = sales[0];

        // Check return window
        const saleDate = new Date(sale.sale_date);
        const daysSince = Math.floor((Date.now() - saleDate) / (1000 * 60 * 60 * 24));
        
        if (daysSince > RETURN_WINDOW_DAYS) {
            return res.status(400).json({ 
                error: `Return window expired (${RETURN_WINDOW_DAYS} days / 4 months)`
            });
        }

        let totalRefund = 0;
        const returnedItems = [];

        // Process each item - just restock inventory
        for (const item of items) {
            const saleItems = await query(
                'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2',
                [item.sale_item_id, original_sale_id]
            );

            if (saleItems.length === 0) {
                return res.status(404).json({ error: `Sale item not found` });
            }

            const saleItem = saleItems[0];
            const refundAmount = parseFloat(saleItem.selling_price || 0) * item.qty;
            totalRefund += refundAmount;

            // Restock inventory
            await query(
                'UPDATE products SET stock = stock + $1 WHERE id = $2',
                [item.qty, saleItem.product_id]
            );

            returnedItems.push({
                product_name: saleItem.product_name,
                qty: item.qty,
                refund: refundAmount
            });

            console.log(`[Returns] Restocked ${item.qty} of ${saleItem.product_name}`);
        }

        // Log the return
        await log(req.user.id, req.user.name, req.user.role, 'return_processed',
            `Sale ${original_sale_id} (${sale.txn_id})`, 
            `KES ${totalRefund} refunded. Items: ${returnedItems.map(i => `${i.qty}x ${i.product_name}`).join(', ')}. Reason: ${reason || 'None'}`, 
            'sale', req.ip);

        console.log(`[Returns] Return completed for sale ${original_sale_id}, refund: KES ${totalRefund}`);

        res.json({
            success: true,
            sale_id: original_sale_id,
            txn_id: sale.txn_id,
            total_refund: totalRefund,
            items_returned: returnedItems,
            message: `✅ Return processed. KES ${totalRefund} refunded. Inventory restocked.`
        });

    } catch (err) {
        console.error('[Returns] POST error:', err.message);
        res.status(500).json({ error: 'Return processing failed: ' + err.message });
    }
});

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
    try {
        // Return simple response (returns aren't tracked in a separate table)
        res.json({ 
            returns: [], 
            total: 0,
            message: 'Returns are processed but not stored in a separate table. Check logs for return history.'
        });
    } catch (err) {
        console.error('[Returns] GET error:', err.message);
        res.json({ returns: [], total: 0 });
    }
});

module.exports = router;