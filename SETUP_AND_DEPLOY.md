# ================================================================
# PERMIC WEAR SOLUTIONS — COMPLETE SETUP & DEPLOYMENT GUIDE
# ================================================================

## PART 1: APIs YOU NEED TO REGISTER

### A. Safaricom Daraja (M-Pesa STK Push)
─────────────────────────────────────────
1. Go to: https://developer.safaricom.co.ke
2. Click "Sign Up" → create account with your business email
3. Go to "Apps" → "Add a New App"
   - App Name: Permic Wear POS
   - Select: Lipa Na M-Pesa Sandbox (for testing)
4. After app is created, copy:
   - Consumer Key     → MPESA_CONSUMER_KEY in .env
   - Consumer Secret  → MPESA_CONSUMER_SECRET in .env
5. Go to "APIs" → "Lipa Na M-Pesa" → "Test Credentials"
   - Copy the Passkey → MPESA_PASSKEY in .env
   - Use Shortcode: 174379 for sandbox testing
6. For PRODUCTION (going live):
   - Apply for a Paybill at https://www.safaricom.co.ke/business
   - Your Paybill: 880100, Account: 505008 (already configured)
   - Get production keys from Daraja portal
   - Set MPESA_ENV=production in .env
   - MPESA_CALLBACK_URL must be a PUBLIC HTTPS URL
     (your deployed backend, e.g. https://api.permicwear.co.ke/api/mpesa/callback)

### B. Africa's Talking (SMS Alerts)
─────────────────────────────────────────
1. Go to: https://account.africastalking.com/auth/register
2. Create account → verify email → verify phone
3. For SANDBOX (testing):
   - Username: sandbox
   - API Key: from dashboard → Settings → API Key
4. For PRODUCTION:
   - Username: your registered username
   - Apply for Sender ID "PERMICWEAR" (takes 2-3 days approval)
   - Top up airtime balance (SMS costs ~KES 0.8 per SMS in Kenya)
   - Update AT_USERNAME and AT_SENDER_ID in .env

### C. Domain & SSL (for production)
─────────────────────────────────────────
- Register domain at: Kenya Network Information Center (KeNIC)
  https://www.kenic.or.ke  (for .co.ke domains)
- Or use: Namecheap, GoDaddy for .com domains
- SSL certificate: Free via Let's Encrypt (auto-configured by Railway/Render)


## PART 2: LOCAL DEVELOPMENT SETUP

### Prerequisites
```bash
# Install Node.js 20 LTS
# https://nodejs.org/en/download

# Install MySQL 8
# https://dev.mysql.com/downloads/installer/

# Or use MySQL via Docker:
docker run --name permic-mysql \
  -e MYSQL_ROOT_PASSWORD=password \
  -e MYSQL_DATABASE=permic_wear \
  -p 3306:3306 -d mysql:8
```

### Step 1 — Backend
```bash
cd permic-wear-backend
npm install

# Copy dev env
cp .env.development .env
# Edit .env with your local MySQL password

# Create database
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS permic_wear;"

# Run migrations (creates all tables)
npm run migrate

# Seed database (creates users with bcrypt-hashed passwords + products)
npm run seed

# Start backend
npm run dev
# → API running at http://localhost:5000
# → Test: http://localhost:5000/health
```

### Step 2 — Frontend
```bash
cd permic-wear-pos
npm install

# Dev mode (shows demo accounts on login)
cp .env.development .env.local
npm run dev
# → App running at http://localhost:5173
```

### Credentials after seeding:
| Email                         | Password       | Role        |
|-------------------------------|----------------|-------------|
| david@permicwear.co.ke        | superadmin123  | Super Admin |
| sarah@permicwear.co.ke        | admin123       | Admin       |
| jane@permicwear.co.ke         | cashier123     | Cashier     |
| brian@permicwear.co.ke        | cashier123     | Cashier     |
| peter@permicwear.co.ke        | cashier123     | Cashier     |

⚠️  IMPORTANT: Change all passwords immediately after first login in production!


## PART 3: TESTING M-PESA (Sandbox)

### Setup ngrok to expose local backend to Safaricom:
```bash
# Install ngrok: https://ngrok.com/download
ngrok http 5000

# Copy the https URL, e.g. https://abc123.ngrok.io
# Set in .env:
MPESA_CALLBACK_URL=https://abc123.ngrok.io/api/mpesa/callback
```

### Test STK Push:
- Use sandbox shortcode: 174379
- Use Safaricom test phone: 254708374149
- Password is always: Safaricom999!# (for sandbox test)


## PART 4: PRODUCTION DEPLOYMENT

### Option A: Railway (Recommended — Easiest)

#### Deploy Backend:
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login

cd permic-wear-backend
railway init                    # creates new Railway project
railway add                     # adds MySQL database service

# Copy all env variables to Railway dashboard:
# railway.app → your project → Variables → Add all from .env.example

railway up                      # deploys backend
# → Gets URL like: https://permic-wear-api.up.railway.app

# Run migrations on Railway:
railway run npm run migrate
railway run npm run seed
```

#### Deploy Frontend to Vercel:
```bash
# Install Vercel CLI
npm install -g vercel

cd permic-wear-pos

# Create production .env
echo "VITE_API_URL=https://permic-wear-api.up.railway.app/api" > .env.production
echo "VITE_MODE=production" >> .env.production

npm run build   # builds to dist/
vercel          # deploys to Vercel (free)
# → Gets URL like: https://permic-wear-pos.vercel.app

# Update backend CORS:
# Set FRONTEND_URL=https://permic-wear-pos.vercel.app in Railway variables
```

#### Update M-Pesa callback:
```bash
# In Railway Variables, set:
MPESA_CALLBACK_URL=https://permic-wear-api.up.railway.app/api/mpesa/callback
MPESA_ENV=production
MPESA_SHORTCODE=880100
MPESA_CONSUMER_KEY=<your production key>
MPESA_CONSUMER_SECRET=<your production secret>
MPESA_PASSKEY=<your production passkey>
```

---

### Option B: Render.com (Free tier, sleeps after 15 min inactivity)

#### Backend (Web Service):
- Connect GitHub repo
- Build Command:  `npm install`
- Start Command:  `npm start`
- Add PostgreSQL or use PlanetScale for MySQL
- Set all environment variables in Render dashboard

#### Frontend (Static Site):
- Build Command:  `npm install && npm run build`
- Publish Dir:    `dist`
- Set VITE_API_URL in environment variables

---

### Option C: VPS (DigitalOcean / Hetzner — Full Control)

```bash
# On Ubuntu 22.04 server:

# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install MySQL 8
sudo apt install mysql-server
sudo mysql_secure_installation
sudo mysql -u root -p << 'SQL'
CREATE DATABASE permic_wear CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'permic'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON permic_wear.* TO 'permic'@'localhost';
FLUSH PRIVILEGES;
SQL

# 3. Install PM2 (process manager)
sudo npm install -g pm2

# 4. Clone/upload your backend
cd /var/www
git clone <your-repo> permic-wear-backend
cd permic-wear-backend
npm install
cp .env.example .env          # fill in values
npm run migrate
npm run seed

# 5. Start with PM2
pm2 start src/server.js --name permic-wear-api
pm2 save
pm2 startup                   # auto-start on reboot

# 6. Build frontend
cd /var/www
git clone <your-repo> permic-wear-pos
cd permic-wear-pos
echo "VITE_API_URL=https://yourdomain.com/api" > .env.production
echo "VITE_MODE=production" >> .env.production
npm install && npm run build   # creates dist/

# 7. Install nginx
sudo apt install nginx certbot python3-certbot-nginx

# 8. Create nginx config
sudo nano /etc/nginx/sites-available/permic-wear
# (paste the nginx.conf from this project)

sudo ln -s /etc/nginx/sites-available/permic-wear /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx

# 9. SSL certificate (free Let's Encrypt)
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 10. Copy frontend build to nginx root
cp -r dist/* /var/www/permic-wear-pos/dist/

# Done! Visit https://yourdomain.com
```


## PART 5: POST-DEPLOYMENT CHECKLIST

- [ ] All passwords changed from seed defaults
- [ ] JWT_SECRET is a strong random string (64+ chars)
- [ ] MPESA_ENV=production (not sandbox)
- [ ] M-Pesa callback URL is live HTTPS endpoint
- [ ] Africa's Talking username is your production username (not 'sandbox')
- [ ] AT_API_KEY is from production (not sandbox)
- [ ] FRONTEND_URL matches your actual Vercel/custom domain
- [ ] Database backups configured
- [ ] SSL certificate valid
- [ ] Test one full sale end-to-end (cash + M-Pesa)
- [ ] Test SMS alert delivery to +254792369700
- [ ] Test all user roles (Super Admin, Admin, Cashier)


## PART 6: SECURITY REMINDERS

- Never push .env files to GitHub
- Rotate JWT_SECRET every 6 months
- Keep MySQL accessible from localhost only (not 0.0.0.0)
- Enable MySQL slow query log for performance monitoring
- Set up automatic database backups (Railway does this automatically)
- Review activity logs monthly for unusual access patterns


## PART 7: SUPPORT CONTACTS

| Service          | Support URL                              |
|-----------------|------------------------------------------|
| Safaricom Daraja | developer.safaricom.co.ke/contact       |
| Africa's Talking | account.africastalking.com/support      |
| Railway          | railway.app/help                        |
| Vercel           | vercel.com/support                      |
