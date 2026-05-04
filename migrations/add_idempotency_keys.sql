-- Migration: Add idempotency_keys table to prevent duplicate sales
-- Run this migration to add duplicate sale prevention

-- Create idempotency_keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    sale_id INTEGER REFERENCES sales(id),
    response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);

-- Function to cleanup old idempotency keys (older than 24 hours)
-- This should be called periodically or we can use a cron job
CREATE OR REPLACE FUNCTION cleanup_old_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM idempotency_keys 
    WHERE created_at < NOW() - INTERVAL '24 hours';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Add composite index for duplicate detection on sales
-- This helps detect potential duplicate sales quickly
CREATE INDEX IF NOT EXISTS idx_sales_dedup ON sales(cashier_id, selling_total, sale_date) 
WHERE status IN ('completed', 'pending_tuma', 'pending_split');