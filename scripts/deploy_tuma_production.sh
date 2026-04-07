#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Permic Wear - TUMA Production Deployment Script
# ═══════════════════════════════════════════════════════════════════

set -e

echo "🚀 Starting TUMA Production Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on production
if [ "$NODE_ENV" != "production" ]; then
    echo -e "${YELLOW}Warning: NODE_ENV is not set to 'production'${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Step 1: Backup database
echo -e "${GREEN}[1/6] Creating database backup...${NC}"
node scripts/backup.js || echo -e "${YELLOW}Warning: Backup script failed, continuing...${NC}"

# Step 2: Install dependencies
echo -e "${GREEN}[2/6] Installing dependencies...${NC}"
npm ci --production

# Step 3: Run database migrations
echo -e "${GREEN}[3/6] Running database migrations...${NC}"

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}Error: DATABASE_URL not set${NC}"
    exit 1
fi

# Run migration based on database type
if [[ $DATABASE_URL == *"supabase.co"* ]]; then
    echo "PostgreSQL detected (Supabase)"
    # For PostgreSQL, we'll use the schema_postgresql.sql
    # Note: This requires psql to be installed
    if command -v psql &> /dev/null; then
        psql "$DATABASE_URL" -f migrations/schema_postgresql.sql || echo -e "${YELLOW}PostgreSQL migration skipped (run manually)${NC}"
    else
        echo -e "${YELLOW}psql not installed. Run migrations/schema_postgresql.sql manually in Supabase SQL Editor${NC}"
    fi
else
    echo "MySQL detected"
    # For MySQL, run the schema.sql
    if command -v mysql &> /dev/null; then
        mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/schema.sql || echo -e "${YELLOW}MySQL migration skipped (run manually)${NC}"
    else
        echo -e "${YELLOW}mysql client not installed. Run migrations/schema.sql manually${NC}"
    fi
fi

# Step 4: Verify environment variables
echo -e "${GREEN}[4/6] Verifying environment configuration...${NC}"

required_vars=(
    "TUMA_EMAIL"
    "TUMA_API_KEY"
    "TUMA_PAYBILL"
    "TUMA_ACCOUNT"
    "TUMA_CALLBACK_URL"
    "JWT_SECRET"
    "DATABASE_URL"
)

missing_vars=()
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
    echo -e "${RED}Error: Missing required environment variables:${NC}"
    printf ' - %s\n' "${missing_vars[@]}"
    exit 1
fi

echo "✓ All required environment variables are set"

# Step 5: Test TUMA credentials
echo -e "${GREEN}[5/6] Testing TUMA API connection...${NC}"

# Create a simple test script
cat > /tmp/test_tuma.js << 'EOF'
const axios = require('axios');

async function testTuma() {
    try {
        const response = await axios.post('https://api.tuma.co.ke/auth/token', {
            email: process.env.TUMA_EMAIL,
            api_key: process.env.TUMA_API_KEY
        }, { timeout: 10000 });
        
        if (response.data.token || response.data.access_token) {
            console.log('✓ TUMA API connection successful');
            process.exit(0);
        } else {
            throw new Error('No token in response');
        }
    } catch (error) {
        console.error('✗ TUMA API connection failed:', error.message);
        process.exit(1);
    }
}

testTuma();
EOF

node /tmp/test_tuma.js
rm -f /tmp/test_tuma.js

# Step 6: Restart application
echo -e "${GREEN}[6/6] Restarting application...${NC}"

if command -v pm2 &> /dev/null; then
    pm2 restart permic-wear-backend || echo -e "${YELLOW}PM2 restart failed, restart manually${NC}"
elif [ -f "Procfile" ]; then
    echo -e "${YELLOW}Heroku deployment detected. Push changes to trigger deploy.${NC}"
elif [ -f "render.yaml" ]; then
    echo -e "${YELLOW}Render deployment detected. Push changes to trigger deploy.${NC}"
else
    echo -e "${YELLOW}No process manager detected. Restart your application manually.${NC}"
fi

echo ""
echo -e "${GREEN}✅ Deployment completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Update your frontend to use 'Tuma' payment method"
echo "2. Configure your TUMA callback URL in the merchant portal"
echo "3. Test a small transaction to verify everything works"
echo "4. Monitor logs for any issues"
echo ""
echo "Callback URL: $TUMA_CALLBACK_URL"
echo ""