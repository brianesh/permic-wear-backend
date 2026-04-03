/**
 * sms.js — Africa's Talking SMS + Gmail email alerts
 *
 * Credential priority (highest → lowest):
 *   1. DB settings table (saved via Settings → SMS tab)
 *   2. .env file
 *
 * AT 401 errors usually mean wrong username or invalid API key.
 * The username must be your EXACT AT registered username (not email, not 'sandbox').
 */

const AfricasTalking = require('africastalking');

// ── Fetch SMS settings from DB (overrides .env) ───────────────────
async function getSMSSettings(db) {
  const defaults = {
    apiKey:       process.env.AT_API_KEY          || '',
    username:     process.env.AT_USERNAME         || '',
    senderId:     process.env.AT_SENDER_ID        || '',
    adminPhone:   process.env.ADMIN_PHONE         || '',
    adminEmail:   process.env.ADMIN_EMAIL         || '',
    gmailUser:    process.env.GMAIL_USER          || '',
    gmailPass:    process.env.GMAIL_APP_PASSWORD  || '',
    smsEnabled:   true,
    emailEnabled: true,
  };

  if (!db) return defaults;

  try {
    const keys = [
      'at_api_key', 'at_username', 'at_sender_id',
      'admin_phone', 'admin_email', 'sms_alerts', 'email_alerts',
      'gmail_user', 'gmail_app_password',
    ];
    const [rows] = await db.query(
      `SELECT key_name, key_value FROM settings WHERE key_name IN (${keys.map(() => '?').join(',')})`,
      keys
    );
    const map = {};
    rows.forEach(r => { if (r.key_value) map[r.key_name] = r.key_value; });

    return {
      apiKey:       map.at_api_key          || defaults.apiKey,
      username:     map.at_username         || defaults.username,
      senderId:     map.at_sender_id        || defaults.senderId,
      adminPhone:   map.admin_phone         || defaults.adminPhone,
      adminEmail:   map.admin_email         || defaults.adminEmail,
      gmailUser:    map.gmail_user          || defaults.gmailUser,
      gmailPass:    map.gmail_app_password  || defaults.gmailPass,
      smsEnabled:   map.sms_alerts   !== 'false',
      emailEnabled: map.email_alerts !== 'false',
    };
  } catch (e) {
    console.warn('[SMS] Could not read DB settings, using .env:', e.message);
    return defaults;
  }
}

// ── Send SMS via Africa's Talking ─────────────────────────────────
async function sendSMS(to, message, opts = {}) {
  const apiKey   = (opts.apiKey   || '').trim();
  const username = (opts.username || '').trim();
  const senderId = (opts.senderId || '').trim() || undefined;

  // No API key → mock mode (logs only, no crash)
  if (!apiKey) {
    console.log(`[SMS MOCK — no AT_API_KEY set] To: ${to}\n${message}`);
    return { status: 'mock_no_key' };
  }

  // Username is required
  if (!username) {
    console.error('[SMS] AT username not set. Go to Settings → SMS and enter your Africa\'s Talking username.');
    return { status: 'failed', error: 'AT username not configured' };
  }

  try {
    // Always create a fresh client with current credentials (never cache)
    const at  = AfricasTalking({ apiKey, username });
    const sms = at.SMS;
    const params = { to: Array.isArray(to) ? to : [to], message };
    if (senderId) params.from = senderId;

    console.log(`[SMS] Sending to ${to} via AT username="${username}" senderId="${senderId || 'none'}"`);
    const result = await sms.send(params);
    console.log('[SMS] Sent:', JSON.stringify(result));
    return result;
  } catch (err) {
    const status = err.response?.status || err.status;
    if (status === 401) {
      console.error(
        '[SMS] 401 Unauthorized — AT credentials rejected.\n' +
        `  API Key: ${apiKey.slice(0,8)}...\n` +
        `  Username: "${username}"\n` +
        '  Fix: Go to Settings → SMS. Username must match EXACTLY what you registered at account.africastalking.com\n' +
        '  It is NOT your email address. Check under "Settings" on the AT dashboard.'
      );
    } else {
      console.error('[SMS] Failed:', err.message);
    }
    return { status: 'failed', error: err.message };
  }
}

// ── Send Email via Gmail SMTP ─────────────────────────────────────
// opts can contain gmailUser/gmailPass from DB (via getSMSSettings)
// Falls back to .env if not in opts
async function sendEmail(to, subject, text, opts = {}) {
  const gmailUser = (opts.gmailUser || process.env.GMAIL_USER         || '').trim();
  const gmailPass = (opts.gmailPass || process.env.GMAIL_APP_PASSWORD || '').trim();

  if (!gmailUser || !gmailPass) {
    console.log(
      `[EMAIL MOCK — Gmail not configured. Go to Settings > Email (Gmail) to set up.]\n` +
      `To: ${to}\nSubject: ${subject}\n${text}`
    );
    return { status: 'mock_no_config' };
  }

  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
    const result = await transporter.sendMail({
      from:    `"Permic Men's Wear Alerts" <${gmailUser}>`,
      to,
      subject,
      text,
    });
    console.log('[EMAIL] Sent:', result.messageId);
    return result;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
    if (err.message.includes('Invalid login') || err.message.includes('Username and Password')) {
      console.error('[EMAIL] App Password rejected. Make sure you generated an App Password at myaccount.google.com (not your real Gmail password).');
    }
    return { status: 'failed', error: err.message };
  }
}

// ── Check stock and send alerts ───────────────────────────────────
async function checkAndAlertStock(db, lowThreshold, agingDays, adminPhone) {
  const opts = await getSMSSettings(db);

  const phone = (adminPhone || opts.adminPhone || '').trim();

  // Low stock items
  const [lowStock] = await db.query(
    `SELECT name, size, sku, stock FROM products
     WHERE stock <= ? AND stock > 0 AND is_active = 1
     ORDER BY stock ASC LIMIT 10`,
    [lowThreshold]
  ).catch(() => [[]]);

  // Aging stock
  const [agingStock] = await db.query(
    `SELECT name, size, sku, days_in_stock FROM products
     WHERE days_in_stock >= ? AND is_active = 1
     ORDER BY days_in_stock DESC LIMIT 5`,
    [agingDays]
  ).catch(() => [[]]);

  const lines = [];
  if (lowStock.length) {
    lines.push(`\u26a0 LOW STOCK (${lowStock.length} items):`);
    lowStock.forEach(p => lines.push(`  ${p.name} Sz${p.size} \u2192 ${p.stock} left`));
  }
  if (agingStock.length) {
    lines.push(`\u23f3 AGING STOCK (${agingStock.length} items):`);
    agingStock.forEach(p => lines.push(`  ${p.name} Sz${p.size} \u2192 ${p.days_in_stock} days`));
  }

  if (!lines.length) return; // nothing to alert

  const message = `Permic Men's Wear Alert\n${lines.join('\n')}`;

  // Send SMS
  if (opts.smsEnabled && phone) {
    await sendSMS(phone, message, opts).catch(e => console.error('[SMS Alert] Error:', e.message));
  } else if (!phone) {
    console.log('[SMS] Skipped — admin_phone not set. Set it in Settings → Stock Alerts.');
  }

  // Send email
  if (opts.emailEnabled && opts.adminEmail) {
    await sendEmail(opts.adminEmail, "⚠ Permic Men's Wear Stock Alert", message)
      .catch(e => console.error('[EMAIL Alert] Error:', e.message));
  }
}

module.exports = { sendSMS, sendEmail, getSMSSettings, checkAndAlertStock };

// ── Send sale confirmation SMS to customer ────────────────────────
// Called after M-Pesa payment confirmed so customer gets a receipt via SMS
async function sendSaleConfirmationSMS(db, { customerPhone, txnId, total, items, storeName, mpesaRef }) {
  if (!customerPhone) return;
  const opts = await getSMSSettings(db);
  if (!opts.smsEnabled) return;

  const itemLines = (items || [])
    .slice(0, 3)
    .map(i => `  ${i.product_name} Sz${i.size} x${i.qty}`)
    .join('\n');
  const moreItems = (items || []).length > 3 ? `\n  +${(items||[]).length - 3} more` : '';

  const message = [
    `✅ Permic Men's Wear`,
    `TXN: ${txnId}`,
    mpesaRef ? `M-Pesa Ref: ${mpesaRef}` : '',
    `Items:\n${itemLines}${moreItems}`,
    `Total: KES ${Number(total||0).toLocaleString()}`,
    `Thank you for shopping with us! 👗`,
  ].filter(Boolean).join('\n');

  await sendSMS(customerPhone, message, opts)
    .catch(e => console.error('[SMS Sale Confirm] Error:', e.message));
}

module.exports = { sendSMS, sendEmail, getSMSSettings, checkAndAlertStock, sendSaleConfirmationSMS };
