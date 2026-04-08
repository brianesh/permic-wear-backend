# 🚀 Render.com Deployment Guide - Permic Wear API

## Overview
This guide will walk you through deploying your Permic Wear backend API to Render.com using your existing `render.yaml` configuration.

## Prerequisites
- GitHub account with the repository: `brianesh/permic-wear-backend`
- Render.com account (free tier available)
- Supabase PostgreSQL database (already configured)

## Step-by-Step Deployment

### 1. Log in to Render.com
Go to [https://render.com](https://render.com) and sign in with your GitHub account.

### 2. Create a New Web Service

**Option A: Using render.yaml (Recommended)**
1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub account if prompted
3. Select repository: `brianesh/permic-wear-backend`
4. Render will automatically detect your `render.yaml` configuration
5. Click **"Apply"**

**Option B: Manual Configuration**
If render.yaml doesn't auto-configure:
- **Name**: `permic-wear-api`
- **Region**: Choose closest to your users (e.g., Frankfurt for Kenya)
- **Branch**: `main`
- **Root Directory**: (leave blank)
- **Runtime**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `node src/server.js`
- **Instance Type**: `Free`

### 3. Configure Environment Variables

Go to your service → **Environment** tab → **Add Environment Variable**

**Required Variables:**

```bash
# Database (Supabase PostgreSQL)
DATABASE_URL=postgresql://postgres.vxzjyxvehpeblbqcljvf:brianesh1308n@aws-0-eu-west-1.pooler.supabase.com:5432/postgres

# Authentication
JWT_SECRET=<generate_64_char_random_string>
JWT_EXPIRES_IN=8h

# TUMA Payment (Production)
TUMA_ENV=production
TUMA_EMAIL=permicwear@gmail.com
TUMA_API_KEY=tuma_3f82a5064b3157e4b24b51528a71e3ab9f7a3af3b6e65bdc2b3f51f88a4567aa_1775478305
TUMA_PAYBILL=880100
TUMA_ACCOUNT=505008
TUMA_CALLBACK_URL=https://<your-render-app-name>.onrender.com/api/tuma/callback

# Server Configuration
NODE_ENV=production
PORT=10000
FRONTEND_URL=https://permic-wear-frontend.vercel.app

# Optional: Africa's Talking (SMS)
AT_API_KEY=<your_africa_talking_key>
AT_USERNAME=<your_africa_talking_username>
AT_SENDER_ID=PERMICWEAR
ADMIN_PHONE=+254792369700

# Optional: Email Alerts
GMAIL_USER=<your_gmail>
GMAIL_APP_PASSWORD=<your_gmail_app_password>
ADMIN_EMAIL=permicwear@gmail.com

# Business Logic
DEFAULT_COMMISSION_RATE=10
LOW_STOCK_THRESHOLD=5
```

**Generate JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4. Deploy and Wait for Build

1. Click **"Create Web Service"**
2. Render will:
   - Clone your repository
   - Run `npm install`
   - Start your application
3. This takes 2-5 minutes
4. Monitor the **Logs** tab for progress

### 5. Run Database Migrations

Once deployed, you need to run migrations on the Render instance:

**Method 1: Render Shell (Recommended)**
1. Go to your service → **Shell** tab
2. Click **"Connect"**
3. Run these commands:
```bash
npm run migrate
npm run seed
```

**Method 2: Manual SQL via Supabase**
If migrations fail, run the SQL manually:
1. Go to Supabase Dashboard → SQL Editor
2. Copy contents of `migrations/schema_postgresql.sql`
3. Execute the SQL

### 6. Update TUMA Callback URL

**Important:** Update your TUMA merchant portal with the new callback URL:

```
https://<your-render-app-name>.onrender.com/api/tuma/callback
```

### 7. Test Your Deployment

**Health Check:**
```bash
curl https://<your-render-app-name>.onrender.com/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "Permic Wear API",
  "payment": "tuma",
  "time": "2024-04-08T13:45:00.000Z"
}
```

**Test Setup Status:**
```bash
curl https://<your-render-app-name>.onrender.com/api/auth/setup-status
```

**Test Login (after seeding):**
```bash
curl -X POST https://<your-render-app-name>.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"david@permicwear.co.ke","password":"superadmin123"}'
```

## Troubleshooting

### Common Issues

**1. Database Connection Failed**
```
Error: password authentication failed for user "postgres"
```
**Solution:** Verify `DATABASE_URL` in Render environment variables matches your Supabase credentials. Check Supabase dashboard → Project Settings → Database.

**2. Port Binding Error**
```
Error: listen EADDRINUSE: address already in use
```
**Solution:** Ensure `PORT=10000` is set in environment variables (Render requires this).

**3. Health Check Failing**
**Solution:** Check logs for startup errors. Common causes:
- Missing environment variables
- Database connection issues
- Migration not run

**4. CORS Errors**
```
CORS blocked: <origin>
```
**Solution:** Update `FRONTEND_URL` environment variable to match your frontend domain.

**5. TUMA Payment Not Working**
**Solution:** 
- Verify TUMA credentials in environment variables
- Ensure callback URL is updated in TUMA merchant portal
- Check logs for TUMA API errors

### Viewing Logs

Go to your Render service → **Logs** tab to see real-time application logs.

### Restarting Service

If you need to restart:
1. Go to service → **Manual Deploy**
2. Click **"Deploy Latest Commit"**

## Post-Deployment Tasks

### 1. Update Frontend
Update your frontend's API URL to point to your Render deployment:
```javascript
// In your frontend .env or config
VITE_API_URL=https://<your-render-app-name>.onrender.com/api
```

### 2. Set Up Monitoring
- Enable Render's **Health Check** notifications
- Set up uptime monitoring (e.g., UptimeRobot)
- Monitor Render dashboard for resource usage

### 3. Database Backups
Configure automatic backups in Supabase:
- Go to Supabase Dashboard → Backups
- Enable point-in-time recovery

### 4. Security Checklist
- [ ] All default passwords changed
- [ ] JWT_SECRET is a strong random string (64+ chars)
- [ ] TUMA_ENV set to `production`
- [ ] CORS properly configured
- [ ] Rate limiting enabled (already configured)
- [ ] HTTPS enforced (Render does this automatically)

## Updating Your Deployment

After making code changes:

```bash
# Commit and push changes
git add .
git commit -m "Your changes"
git push origin main

# Render will automatically deploy the new version
# Monitor the Logs tab to see the deployment progress
```

## Cost Estimation

**Render Free Tier:**
- Web Service: 750 hours/month (enough for 1 service running 24/7)
- PostgreSQL: Not included (using Supabase free tier)
- Bandwidth: 100GB/month

**Note:** Render free services sleep after 15 minutes of inactivity. First request after sleep takes ~30 seconds to respond.

## Support Resources

- **Render Docs:** https://render.com/docs
- **Supabase Docs:** https://supabase.com/docs
- **TUMA Docs:** https://docs.tuma.co.ke
- **Your Project Issues:** Check Render logs first

## Next Steps

1. ✅ Deploy to Render
2. ✅ Configure environment variables
3. ✅ Run migrations
4. ✅ Test all endpoints
5. ✅ Update frontend API URL
6. ✅ Update TUMA callback URL
7. ✅ Test payment flow end-to-end

---

**Need help?** Check the Render logs first, then refer to the troubleshooting section above.

Good luck with your deployment! 🎉