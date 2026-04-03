# ================================================================
# DEPLOYMENT GUIDE — Sneaker Empire
# ================================================================
# OPTION A: Railway (Recommended — easiest, free tier available)
# OPTION B: Render (free tier, cold starts)
# OPTION C: VPS (DigitalOcean / Hetzner)
# ================================================================

# ──────────────────────────────────────────────────────────────────
# OPTION A: RAILWAY DEPLOYMENT
# ──────────────────────────────────────────────────────────────────

# 1. Install Railway CLI
#    npm install -g @railway/cli

# 2. Login
#    railway login

# 3. From backend folder:
#    cd sneaker-empire-backend
#    railway init
#    railway up

# 4. Add MySQL database on Railway dashboard:
#    New Service → Database → MySQL
#    Then copy the DATABASE_URL from Railway dashboard

# 5. Set environment variables on Railway dashboard:
#    PORT=5000
#    DB_HOST=<from Railway MySQL>
#    DB_PORT=<from Railway MySQL>
#    DB_NAME=railway
#    DB_USER=<from Railway MySQL>
#    DB_PASSWORD=<from Railway MySQL>
#    JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
#    MPESA_CONSUMER_KEY=<your key>
#    MPESA_CONSUMER_SECRET=<your secret>
#    MPESA_SHORTCODE=<your shortcode>
#    MPESA_PASSKEY=<your passkey>
#    MPESA_ENV=production
#    MPESA_CALLBACK_URL=https://<your-railway-url>/api/mpesa/callback
#    AT_API_KEY=<africastalking key>
#    AT_USERNAME=<your username>
#    ADMIN_PHONE=+254700000000
#    FRONTEND_URL=https://<your-vercel-url>
#    NODE_ENV=production

# 6. Run migrations & seed:
#    railway run node migrations/run.js
#    railway run node migrations/seed.js

# 7. Deploy frontend to Vercel:
#    cd sneaker-empire-complete
#    npx vercel
#    Set VITE_API_URL=https://<your-railway-url>/api

# ──────────────────────────────────────────────────────────────────
# OPTION B: RENDER DEPLOYMENT
# ──────────────────────────────────────────────────────────────────

# Backend (Web Service):
#   Build Command:  npm install
#   Start Command:  npm start
#   Add MySQL via Render's managed database or PlanetScale

# Frontend (Static Site):
#   Build Command:  npm install && npm run build
#   Publish Dir:    dist
#   Env: VITE_API_URL=https://<your-render-service>.onrender.com/api

# ──────────────────────────────────────────────────────────────────
# OPTION C: VPS (Ubuntu 22.04)
# ──────────────────────────────────────────────────────────────────

# Install Node.js 20
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
# sudo apt-get install -y nodejs

# Install MySQL
# sudo apt install mysql-server
# sudo mysql_secure_installation
# mysql -u root -p -e "CREATE DATABASE sneaker_empire; CREATE USER 'se_user'@'localhost' IDENTIFIED BY 'strongpassword'; GRANT ALL ON sneaker_empire.* TO 'se_user'@'localhost';"

# Install PM2
# sudo npm install -g pm2

# Deploy backend
# cd sneaker-empire-backend
# npm install
# cp .env.example .env   # fill in values
# node migrations/run.js
# node migrations/seed.js
# pm2 start src/server.js --name sneaker-empire-api
# pm2 save && pm2 startup

# Build frontend
# cd sneaker-empire-complete
# echo "VITE_API_URL=https://your-domain.com/api" > .env
# npm install && npm run build

# Install nginx
# sudo apt install nginx

# Nginx config at /etc/nginx/sites-available/sneaker-empire:
# (see nginx.conf below)
