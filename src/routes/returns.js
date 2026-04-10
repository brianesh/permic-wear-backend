/**
 * returns.js — Returns & Refunds
 * Complete working version with 120 days (4 months) return window
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN = requireRole('super_admin', 'admin');

// Return window: 120 days = 4 months
const RETURN_WINDOW_DAYS = 120;

// Simple query helper that always returns rows array
async function query(sql, params = []) {
    try {
        const result = await db.query(sql, params);
        // Handle different return formats from your connection.js
        if (result && result.rows) {
            return result.rows;
        }
        if (Array.isArray(result)) {
            return result[0] || [];
        }
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

        // Find the sale by txn_id, tuma_ref, or mpesa_ref
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
            WHERE s.txn_id = $1 
               OR s.tuma_ref = $1 
               OR s.mpesa_ref = $1
            LIMIT 1
        `, [ref]);

        if (sales.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: `No completed sale found for "${ref}"`,
                message: 'Please check the transaction ID and try again'
            });
        }

        const sale = sales[0];
        
        // Check store access for admin (non-super_admin)
        if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
            return res.status(403).json({ 
                success: false, 
                error: 'This sale belongs to a different store' 
            });
        }

        // Calculate days since sale
        const saleDate = new Date(sale.sale_date);
        const now = new Date();
        const daysSinceSale = Math.floor((now - saleDate) / (1000 * 60 * 60 * 24));
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

        // Get already returned quantities
        let returnedMap = {};
        if (items.length > 0) {
            try {
                const itemIds = items.map(i => i.id).join(',');
                const returnedItems = await query(`
                    SELECT 
                        ri.sale_item_id,
                        SUM(ri.qty) as returned_qty
                    FROM return_items ri
                    JOIN returns r ON r.id = ri.return_id
                    WHERE ri.sale_item_id IN (${itemIds})
                        AND r.status != 'rejected'
                    GROUP BY ri.sale_item_id
                `);
                
                returnedItems.forEach(item => {
                    returnedMap[item.sale_item_id] = parseInt(item.returned_qty) || 0;
                });
            } catch (err) {
                console.log('[Returns] No previous returns found or error:', err.message);
            }
        }

        // Build items with returnable quantities
        const itemsWithReturnable = items.map(item => ({
            id: item.id,
            sale_item_id: item.id,
            product_id: item.product_id,
            product_name: item.product_name,
            size: item.size,
            qty: item.qty,
            selling_price: parseFloat(item.selling_price) || 0,
            sku: item.sku,
            already_returned: returnedMap[item.id] || 0,
            returnable_qty: Math.max(0, item.qty - (returnedMap[item.id] || 0))
        }));

        const hasReturnableItems = itemsWithReturnable.some(item => item.returnable_qty > 0);
        const isFullyReturned = itemsWithReturnable.length > 0 && 
            itemsWithReturnable.every(item => item.returnable_qty === 0);

        // Prepare response
        const response = {
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
            items: itemsWithReturnable,
            return_window_days: RETURN_WINDOW_DAYS,
            within_window: withinWindow,
            days_since_sale: daysSinceSale,
            months_since_sale: Math.floor(daysSinceSale / 30),
            has_returnable_items: hasReturnableItems,
            is_fully_returned: isFullyReturned,
            can_return: withinWindow && hasReturnableItems && !isFullyReturned,
            message: null
        };

        // Add helpful message
        if (!withinWindow) {
            response.message = `Return window has expired (${RETURN_WINDOW_DAYS} days / 4 months). Sale was ${daysSinceSale} days ago.`;
        } else if (isFullyReturned) {
            response.message = 'All items from this sale have already been returned.';
        } else if (!hasReturnableItems) {
            response.message = 'No items available for return.';
        }

        console.log(`[Returns] Found sale ${sale.txn_id}, ${itemsWithReturnable.filter(i => i.returnable_qty > 0).length} returnable items`);
        res.json(response);

    } catch (err) {
        console.error('[Returns] Lookup error:', err.message);
        console.error('[Returns] Stack:', err.stack);
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
            return res.status(400).json({ 
                error: 'original_sale_id and items are required' 
            });
        }

        console.log(`[Returns] Processing return for sale ${original_sale_id}`);

        // Get the sale
        const sales = await query(
            'SELECT * FROM sales WHERE id = $1 AND status = $2',
            [original_sale_id, 'completed']
        );

        if (sales.length === 0) {
            return res.status(404).json({ error: 'Completed sale not found' });
        }

        const sale = sales[0];

        // Check store access
        if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
            return res.status(403).json({ error: 'Sale belongs to a different store' });
        }

        // Check return window (120 days)
        const saleDate = new Date(sale.sale_date);
        const daysSince = Math.floor((Date.now() - saleDate) / (1000 * 60 * 60 * 24));
        
        if (daysSince > RETURN_WINDOW_DAYS) {
            return res.status(400).json({ 
                error: `Return window has expired (${RETURN_WINDOW_DAYS} days / 4 months). Sale was ${daysSince} days ago.`
            });
        }

        // Validate items and calculate refund
        let totalRefund = 0;
        const returnItems = [];

        for (const item of items) {
            const saleItems = await query(
                'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2',
                [item.sale_item_id, original_sale_id]
            );

            if (saleItems.length === 0) {
                return res.status(404).json({ 
                    error: `Sale item ${item.sale_item_id} not found on this receipt` 
                });
            }

            const saleItem = saleItems[0];

            // Check if already returned
            const returned = await query(`
                SELECT COALESCE(SUM(ri.qty), 0) as returned
                FROM return_items ri
                JOIN returns r ON r.id = ri.return_id
                WHERE ri.sale_item_id = $1 AND r.status != 'rejected'
            `, [item.sale_item_id]);

            const alreadyReturned = parseInt(returned[0]?.returned || 0);
            const maxReturnable = saleItem.qty - alreadyReturned;

            if (item.qty > maxReturnable) {
                return res.status(400).json({ 
                    error: `Cannot return ${item.qty} of "${saleItem.product_name}". Only ${maxReturnable} available to return.`
                });
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
        
        const returns = await query(`
            INSERT INTO returns 
            (return_ref, original_sale_id, store_id, processed_by, reason, notes, total_refund, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
            RETURNING id
        `, [returnRef, original_sale_id, sale.store_id, req.user.id, reason || '', notes || '', totalRefund]);

        const returnId = returns[0]?.id;

        if (!returnId) {
            throw new Error('Failed to create return record');
        }

        // Insert return items and restock
        for (const item of returnItems) {
            await query(`
                INSERT INTO return_items 
                (return_id, sale_item_id, product_id, product_name, sku, size, qty, refund_price, restock, condition)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [returnId, item.sale_item_id, item.product_id, item.product_name,
                item.sku, item.size, item.qty, item.refund_price, item.restock, item.condition]);

            // Restock inventory
            if (item.restock && item.condition !== 'unsellable') {
                await query(
                    'UPDATE products SET stock = stock + $1 WHERE id = $2',
                    [item.qty, item.product_id]
                );
            }
        }

        // Log the return
        await log(req.user.id, req.user.name, req.user.role, 'return_processed',
            returnRef, `KES ${totalRefund} — ${returnItems.length} item(s)`, 'sale', req.ip);

        console.log(`[Returns] Return completed: ${returnRef}, refund: KES ${totalRefund}`);
        
        res.json({
            success: true,
            return_ref: returnRef,
            return_id: returnId,
            total_refund: totalRefund,
            message: `Return processed successfully. KES ${totalRefund} to be refunded.`
        });

    } catch (err) {
        console.error('[Returns] POST error:', err.message);
        console.error('[Returns] Stack:', err.stack);
        res.status(500).json({ error: 'Return processing failed: ' + err.message });
    }
});

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const returns = await query(`
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

        const countResult = await query('SELECT COUNT(*) as total FROM returns');
        const total = parseInt(countResult[0]?.total || 0);

        res.json({
            returns: returns,
            total: total,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    } catch (err) {
        console.error('[Returns] GET error:', err.message);
        res.json({ returns: [], total: 0, page: 1, limit: 20 });
    }
});

// ── PUT /api/returns/:id/approve ──────────────────────────────────
router.put('/:id/approve', requireAuth, ADMIN, async (req, res) => {
    try {
        const returns = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
        
        if (returns.length === 0) {
            return res.status(404).json({ error: 'Return not found' });
        }
        
        const ret = returns[0];
        
        if (ret.status !== 'pending_approval') {
            return res.status(400).json({ error: `Return is already ${ret.status}` });
        }

        await query(
            'UPDATE returns SET status = $1, approved_by = $2 WHERE id = $3',
            ['completed', req.user.id, ret.id]
        );

        // Restock items
        const items = await query('SELECT * FROM return_items WHERE return_id = $1', [ret.id]);
        
        for (const item of items) {
            if (item.restock && item.condition !== 'unsellable') {
                await query(
                    'UPDATE products SET stock = stock + $1 WHERE id = $2',
                    [item.qty, item.product_id]
                );
            }
        }

        await log(req.user.id, req.user.name, req.user.role, 'return_approved',
            ret.return_ref, `Approved by ${req.user.name}`, 'sale', req.ip);

        res.json({
            success: true,
            message: 'Return approved and inventory updated',
            return_ref: ret.return_ref
        });
    } catch (err) {
        console.error('[Returns] Approve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /api/returns/:id/reject ───────────────────────────────────
router.put('/:id/reject', requireAuth, ADMIN, async (req, res) => {
    try {
        const returns = await query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
        
        if (returns.length === 0) {
            return res.status(404).json({ error: 'Return not found' });
        }
        
        const ret = returns[0];
        
        if (ret.status === 'completed') {
            return res.status(400).json({ error: 'Cannot reject a completed return' });
        }

        const rejectReason = req.body.reason || 'No reason given';
        const newNotes = ret.notes 
            ? `${ret.notes}\n[Rejected: ${rejectReason}]`
            : `[Rejected: ${rejectReason}]`;

        await query(
            'UPDATE returns SET status = $1, actioned_by = $2, notes = $3 WHERE id = $4',
            ['rejected', req.user.id, newNotes, ret.id]
        );

        await log(req.user.id, req.user.name, req.user.role, 'return_rejected',
            ret.return_ref, rejectReason, 'sale', req.ip);

        res.json({
            success: true,
            message: 'Return rejected',
            return_ref: ret.return_ref
        });
    } catch (err) {
        console.error('[Returns] Reject error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;