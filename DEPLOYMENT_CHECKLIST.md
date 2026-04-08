# ✅ Render.com Deployment Checklist - Permic Wear API

Use this checklist to ensure a smooth deployment to Render.com.

## Pre-Deployment

- [ ] **Render.com account created** (sign in with GitHub at render.com)
- [ ] **Supabase database accessible** (verify credentials work)
- [ ] **TUMA API credentials ready** (API key, Paybill, Account)
- [ ] **Frontend URL known** (e.g., permic-wear-frontend.vercel.app)

## Deployment Steps

### Step 1: Create Web Service on Render
- [ ] Log in to [Render Dashboard](https://dashboard.render.com)
- [ ] Click **New +** → **Web Service**
- [ ] Connect GitHub account (if not already connected)
- [ ] Select repository: `brianesh/permic-wear-backend`
- [ ] Verify `render.yaml` is detected and auto-configured
- [ ] Choose region (recommend: **Frankfurt** for Kenya/East Africa)
- [ ] Select **Free** instance type
- [ ] Click **Create Web Service**

### Step 2: Configure Environment Variables
Go to your service → **Environment** tab → Add each variable:

- [ ] `DATABASE_URL` - Supabase PostgreSQL connection string
- [ ] `JWT_SECRET` - Generate with: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- [ ] `JWT_EXPIRES_IN` - Set to `8h`
- [ ] `NODE_ENV` - Set to `production`
- [ ] `PORT` - Set to `10000`
- [ ] `FRONTEND_URL` - Your frontend URL (e.g., https://permic-wear-frontend.vercel.app)
- [ ] `TUMA_ENV` - Set to `production`
- [ ] `TUMA_EMAIL` - permicwear@gmail.com
- [ ] `TUMA_API_KEY` - Your TUMA API key
- [ ] `TUMA_PAYBILL` - 880100
- [ ] `TUMA_ACCOUNT` - 505008
- [ ] `TUMA_CALLBACK_URL` - https://<your-app>.onrender.com/api/tuma/callback
- [ ] `AT_API_KEY` - (Optional) Africa's Talking API key
- [ ] `AT_USERNAME` - (Optional) Africa's Talking username
- [ ] `ADMIN_PHONE` - +254792369700
- [ ] `ADMIN_EMAIL` - permicwear@gmail.com
- [ ] `DEFAULT_COMMISSION_RATE` - 10
- [ ] `LOW_STOCK_THRESHOLD` - 5

### Step 3: Wait for Deployment
- [ ] Monitor **Logs** tab for build progress
- [ ] Wait for "Successfully deployed" message (2-5 minutes)

### Step 4: Run Database Migrations
- [ ] Go to **Shell** tab
- [ ] Click **Connect**
- [ ] Run: `npm run migrate`
- [ ] Run: `npm run seed`
- [ ] Verify no errors

### Step 5: Update TUMA Callback URL
- [ ] Log in to TUMA merchant portal
- [ ] Update callback URL to: `https://<your-app>.onrender.com/api/tuma/callback`
- [ ] Save changes

## Post-Deployment Testing

### Health Check
```bash
curl https://<your-app>.onrender.com/health
```
- [ ] Returns `{"status":"ok","service":"Permic Wear API","payment":"tuma"}`

### Setup Status
```bash
curl https://<your-app>.onrender.com/api/auth/setup-status
```
- [ ] Returns `{"needs_setup":true}` or similar

### Test Login
```bash
curl -X POST https://<your-app>.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"david@permicwear.co.ke","password":"superadmin123"}'
```
- [ ] Returns JWT token and user data

### Test Products Endpoint
```bash
curl https://<your-app>.onrender.com/api/products
```
- [ ] Returns product list (may be empty if not seeded)

## Frontend Integration

- [ ] Update frontend `.env` or `.env.production`:
  ```
  VITE_API_URL=https://<your-app>.onrender.com/api
  ```
- [ ] Redeploy frontend to Vercel (if using Vercel)
- [ ] Test login from frontend
- [ ] Test creating a sale
- [ ] Test TUMA payment flow

## Security & Monitoring

- [ ] Change all default passwords from seeding
- [ ] Verify HTTPS is working (Render does this automatically)
- [ ] Set up uptime monitoring (e.g., UptimeRobot)
- [ ] Enable Render health check notifications
- [ ] Configure Supabase database backups

## Troubleshooting

If you encounter issues:

1. **Check Logs**: Go to Render service → Logs tab
2. **Common Issues**:
   - Database connection errors → Verify DATABASE_URL
   - Port binding errors → Ensure PORT=10000
   - CORS errors → Update FRONTEND_URL
   - Health check failures → Check all required env vars

3. **Need Help?**
   - Review `RENDER_DEPLOYMENT_GUIDE.md` for detailed instructions
   - Check Render logs for specific error messages
   - Verify environment variables are set correctly

## Deployment Complete! 🎉

Once all items are checked, your Permic Wear API is live on Render.com!

**Your API URL**: `https://<your-app>.onrender.com`

**Next Steps**:
- Monitor your first few days of production usage
- Set up proper logging and alerting
- Consider upgrading to a paid Render plan for better performance (no sleep)