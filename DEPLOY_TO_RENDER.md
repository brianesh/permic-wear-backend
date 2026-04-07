# 🚀 Deploy to Render.com - Environment Variables Setup

## ⚠️ Important: Render.com Doesn't Use .env File

Your application is deployed on Render.com, but the `.env` file in your repository is **NOT automatically used** by Render. You must manually set environment variables in the Render.com dashboard.

## 📋 Required Environment Variables

Log in to https://render.com/dashboard and set these environment variables for your backend service:

### Database
```
DATABASE_URL=postgresql://postgres.vxzjyxvehpeblbqcljvf:brianesh1308n@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

### Authentication
```
JWT_SECRET=your_secure_random_64_character_string_here
JWT_EXPIRES_IN=8h
```

### TUMA Payment
```
TUMA_ENV=production
TUMA_EMAIL=permicwear@gmail.com
TUMA_API_KEY=tuma_3f82a5064b3157e4b24b51528a71e3ab9f7a3af3b6e65bdc2b3f51f88a4567aa_1775478305
TUMA_PAYBILL=880100
TUMA_ACCOUNT=505008
TUMA_CALLBACK_URL=https://your-app-name.onrender.com/api/tuma/callback
```

### Server
```
NODE_ENV=production
PORT=5000
FRONTEND_URL=https://your-frontend-domain.com
```

### Optional (SMS, etc.)
```
AT_API_KEY=your_africa_talking_key
AT_USERNAME=your_africa_talking_username
AT_SENDER_ID=PERMICWEAR
ADMIN_PHONE=+254792369700
```

## 🔧 Steps to Update Render.com

1. **Log in to Render.com**
   - Go to https://render.com/dashboard
   - Select your backend service

2. **Go to Environment Tab**
   - Click on "Environment" in the left sidebar
   - Click "Edit"

3. **Add/Update Environment Variables**
   - Add all the variables listed above
   - Make sure `DATABASE_URL` matches your local `.env` file
   - Generate a strong `JWT_SECRET` (64 characters)

4. **Save and Redeploy**
   - Click "Save Changes"
   - Render will automatically redeploy your application

5. **Verify Deployment**
   - Wait for the deployment to complete
   - Test the `/api/auth/setup` endpoint
   - Check logs for any errors

## 🧪 Test After Deployment

Once deployed, test these endpoints:

```bash
# Check if setup is needed
curl https://your-app.onrender.com/api/auth/setup-status

# Should return: {"needs_setup": true}
```

If you still get 500 errors, check the Render logs:
- Go to your service in Render dashboard
- Click "Logs"
- Look for error messages

## 🐛 Troubleshooting

### 500 Error on /api/auth/setup
- **Cause**: Database connection issue or missing environment variables
- **Fix**: Ensure `DATABASE_URL` is correct in Render environment variables

### Database Connection Failed
- **Cause**: Wrong credentials or database paused
- **Fix**: Verify credentials in Supabase dashboard, wake up database if paused

### JWT_SECRET Not Set
- **Cause**: Missing JWT_SECRET environment variable
- **Fix**: Add a 64-character random string as JWT_SECRET

## 📝 Generate JWT_SECRET

Run this command to generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copy the output and use it as your `JWT_SECRET`.

## ✅ Checklist

- [ ] Log in to Render.com dashboard
- [ ] Go to backend service → Environment
- [ ] Add DATABASE_URL with correct credentials
- [ ] Add JWT_SECRET (64 characters)
- [ ] Add TUMA payment variables
- [ ] Add other required variables
- [ ] Save changes
- [ ] Wait for redeployment
- [ ] Test /api/auth/setup-status endpoint
- [ ] Verify no 500 errors

Once these environment variables are set on Render.com, your backend will work correctly! 🎉