/**
 * returns.js — Returns & Refunds
 * Complete working version - 120 days return window
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN = requireRole('super_admin', 'admin');

// Constants
const RETURN_WINDOW_DAYS = 120; // 4 months

// Helper function to safely execute queries regardless of return format
async function safeQuery(sql, params = []) {
    try {
        const result = await db.query(sql, params);
        // Handle both { rows } and direct array formats
        if (result && result.rows !== undefined) {
            return { rows: result.rows, rowCount: result.rowCount };
        }
        if (Array.isArray(result)) {
            return { rows: result[0] || [], rowCount: result.length };
        }
        return { rows: [], rowCount: 0 };
    } catch (err) {
        console.error('[safeQuery] Error:', err.message);
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

        // First, find the sale
        const saleResult = await safeQuery(`
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
                u.name AS cashier_name,
                st.name AS store_name
            FROM sales s
            LEFT JOIN users u ON u.id = s.cashier_id
            LEFT JOIN stores st ON st.id = s.store_id
            WHERE (s.txn_id = $1 OR s.tuma_ref = $1 OR s.mpesa_ref = $1)
                AND s.status = 'completed'
            LIMIT 1
        `, [ref]);

        if (!saleResult.rows || saleResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No completed sale found for "${ref}"`,
                message: 'Please check the transaction ID and try again'
            });
        }

        const sale = saleResult.rows[0];

        // Admin store check
        if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
            return res.status(403).json({
                success: false,
                error: 'This sale belongs to a different store'
            });
        }

        // Calculate days since sale
        const saleDate = new Date(sale.sale_date);
        const now = new Date();
        const diffDays = Math.floor((now - saleDate) / (1000 * 60 * 60 * 24));
        const withinWindow = diffDays <= RETURN_WINDOW_DAYS;

        // Get sale items
        const itemsResult = await safeQuery(`
            SELECT
                si.id,
                si.product_id,
                si.product_name,
                si.size,
                si.qty,
                si.selling_price,
                si.sku
            FROM sale_items si
            WHERE si.sale_id = $1
        `, [sale.id]);

        let items = itemsResult.rows || [];

        // Try to get already returned quantities (if tables exist)
        try {
            const returnedResult = await safeQuery(`
                SELECT 
                    ri.sale_item_id,
                    COALESCE(SUM(ri.qty), 0) as returned_qty
                FROM return_items ri
                JOIN returns r ON r.id = ri.return_id
                WHERE ri.sale_item_id IN (${items.map(i => i.id).join(',') || 0})
                    AND r.status != 'rejected'
                GROUP BY ri.sale_item_id
            `);

            const returnedMap = {};
            (returnedResult.rows || []).forEach(r => {
                returnedMap[r.sale_item_id] = parseInt(r.returned_qty) || 0;
            });

            items = items.map(item => ({
                ...item,
                already_returned: returnedMap[item.id] || 0,
                returnable_qty: Math.max(0, item.qty - (returnedMap[item.id] || 0)),
                selling_price: parseFloat(item.selling_price) || 0
            }));
        } catch (err) {
            // If return tables don't exist yet, all items are returnable
            console.log('[Returns] Return tables not yet set up, all items returnable');
            items = items.map(item => ({
                ...item,
                already_returned: 0,
                returnable_qty: item.qty,
                selling_price: parseFloat(item.selling_price) || 0
            }));
        }

        const hasReturnableItems = items.some(item => (item.returnable_qty || 0) > 0);
        const isFullyReturned = items.length > 0 && items.every(item => (item.returnable_qty || 0) === 0);

        // Success response
        res.json({
            success: true,
            sale: {
                id: sale.id,
                txn_id: sale.txn_id,
                cashier_id: sale.cashier_id,
                store_id: sale.store_id,
                selling_total: parseFloat(sale.selling_total) || 0,
                amount_paid: parseFloat(sale.amount_paid) || 0,
                status: sale.status,
                sale_date: sale.sale_date,
                phone: sale.phone,
                cashier_name: sale.cashier_name || 'Cashier',
                store_name: sale.store_name || 'Main Store',
                tuma_ref: sale.tuma_ref,
                mpesa_ref: sale.mpesa_ref,
            },
            items: items.map(item => ({
                id: item.id,
                sale_item_id: item.id,
                product_id: item.product_id,
                product_name: item.product_name,
                size: item.size,
                qty: item.qty,
                selling_price: item.selling_price,
                sku: item.sku,
                already_returned: item.already_returned || 0,
                returnable_qty: item.returnable_qty || item.qty
            })),
            return_window_days: RETURN_WINDOW_DAYS,
            within_window: withinWindow,
            days_since_sale: diffDays,
            months_since_sale: Math.floor(diffDays / 30),
            has_returnable_items: hasReturnableItems,
            is_fully_returned: isFullyReturned,
            can_return: withinWindow && hasReturnableItems && !isFullyReturned,
            message: !withinWindow 
                ? `Return window has expired (${RETURN_WINDOW_DAYS} days / 4 months). Sale was ${diffDays} days ago.`
                : isFullyReturned 
                    ? 'All items from this sale have already been returned.'
                    : null
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
        const { original_sale_id, items, reason, notes } = req.body;

        if (!original_sale_id || !items?.length) {
            return res.status(400).json({ error: 'original_sale_id and items are required' });
        }

        // Get the sale
        const saleResult = await safeQuery(
            'SELECT * FROM sales WHERE id = $1 AND status = $2',
            [original_sale_id, 'completed']
        );

        if (!saleResult.rows || saleResult.rows.length === 0) {
            return res.status(404).json({ error: 'Completed sale not found' });
        }

        const sale = saleResult.rows[0];

        // Check store access
        if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
            return res.status(403).json({ error: 'Sale belongs to a different store' });
        }

        // Check return window (120 days)
        const saleDate = new Date(sale.sale_date);
        const diffDays = Math.floor((Date.now() - saleDate) / (1000 * 60 * 60 * 24));

        if (diffDays > RETURN_WINDOW_DAYS) {
            return res.status(400).json({
                error: `Return window has expired (${RETURN_WINDOW_DAYS} days / 4 months). Sale was ${diffDays} days ago.`
            });
        }

        // Process each item
        let totalRefund = 0;
        const returnItems = [];

        for (const item of items) {
            const saleItemResult = await safeQuery(
                'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2',
                [item.sale_item_id, original_sale_id]
            );

            if (!saleItemResult.rows || saleItemResult.rows.length === 0) {
                return res.status(404).json({ error: `Sale item ${item.sale_item_id} not found` });
            }

            const saleItem = saleItemResult.rows[0];

            // Check if already returned
            try {
                const returnedResult = await safeQuery(`
                    SELECT COALESCE(SUM(ri.qty), 0) as returned
                    FROM return_items ri
                    JOIN returns r ON r.id = ri.return_id
                    WHERE ri.sale_item_id = $1 AND r.status != 'rejected'
                `, [item.sale_item_id]);

                const alreadyReturned = parseInt(returnedResult.rows?.[0]?.returned || 0);
                const maxReturnable = saleItem.qty - alreadyReturned;

                if (item.qty > maxReturnable) {
                    return res.status(400).json({
                        error: `Cannot return ${item.qty} of "${saleItem.product_name}". Only ${maxReturnable} available to return.`
                    });
                }
            } catch (err) {
                // If return tables don't exist, assume no returns yet
                console.log('[Returns] No existing returns found');
            }

            const refundAmount = parseFloat(saleItem.selling_price || 0) * item.qty;
            totalRefund += refundAmount;

            returnItems.push({
                sale_item_id: saleItem.id,
                product_id: saleItem.product_id,
                product_name: saleItem.product_name,
                sku: saleItem.sku,
                size: saleItem.size,
                qty: item.qty,
                refund_price: parseFloat(saleItem.selling_price || 0),
                restock: item.restock !== false,
                condition: item.condition || 'good'
            });
        }

        // Create return record
        const returnRef = `RET-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        
        const returnResult = await safeQuery(`
            INSERT INTO returns 
            (return_ref, original_sale_id, store_id, processed_by, reason, notes, total_refund, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
            RETURNING id
        `, [returnRef, original_sale_id, sale.store_id, req.user.id, reason || '', notes || '', totalRefund]);

        const returnId = returnResult.rows?.[0]?.id;

        if (!returnId) {
            throw new Error('Failed to create return record');
        }

        // Insert return items and restock
        for (const item of returnItems) {
            await safeQuery(`
                INSERT INTO return_items 
                (return_id, sale_item_id, product_id, product_name, sku, size, qty, refund_price, restock, condition)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [returnId, item.sale_item_id, item.product_id, item.product_name,
                item.sku, item.size, item.qty, item.refund_price, item.restock, item.condition]);

            // Restock inventory
            if (item.restock && item.condition !== 'unsellable') {
                await safeQuery(
                    'UPDATE products SET stock = stock + $1 WHERE id = $2',
                    [item.qty, item.product_id]
                );
            }
        }

        // Log the return
        await log(req.user.id, req.user.name, req.user.role, 'return_processed',
            returnRef, `KES ${totalRefund} — ${returnItems.length} item(s)`, 'sale', req.ip);

        res.json({
            success: true,
            return_ref: returnRef,
            return_id: returnId,
            total_refund: totalRefund,
            message: `Return processed successfully. KES ${totalRefund} to be refunded.`
        });

    } catch (err) {
        console.error('[Returns] POST error:', err.message);
        res.status(500).json({ error: 'Return processing failed: ' + err.message });
    }
});

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const result = await safeQuery(`
            SELECT 
                r.*,
                u.name AS processed_by_name,
                s.txn_id AS original_txn,
                st.name AS store_name
            FROM returns r
            JOIN users u ON u.id = r.processed_by
            JOIN sales s ON s.id = r.original_sale_id
            LEFT JOIN stores st ON st.id = r.store_id
            ORDER BY r.created_at DESC
            LIMIT $1 OFFSET $2
        `, [parseInt(limit), offset]);

        const countResult = await safeQuery('SELECT COUNT(*) as total FROM returns');
        const total = parseInt(countResult.rows?.[0]?.total || 0);

        res.json({
            returns: result.rows || [],
            total,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    } catch (err) {
        console.error('[Returns] GET error:', err.message);
        res.json({ returns: [], total: 0, page: 1, limit: 20 });
    }
});

module.exports = router;