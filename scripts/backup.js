/**
 * backup.js — Auto-scheduled MySQL backup via node-cron
 * Imported by server.js on startup.
 * Runs every day at 02:00 AM Africa/Nairobi.
 */
const path = require('path');
const fs   = require('fs');
const { exec } = require('child_process');

let cron;
try { cron = require('node-cron'); } catch (_) {
  console.warn('[BACKUP] node-cron not installed. Run: npm install node-cron');
  module.exports = { runBackup: () => {} };
  return;
}

const BACKUP_SCRIPT = path.join(__dirname, 'backup.sh');
const LOG_DIR       = path.join(__dirname, '../logs');

function runBackup() {
  const ts = new Date().toISOString();
  console.log(`[BACKUP] Starting scheduled backup — ${ts}`);
  exec(`bash "${BACKUP_SCRIPT}"`, (err, stdout, stderr) => {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(
        path.join(LOG_DIR, 'backup.log'),
        `\n--- ${ts} ---\n${stdout}${stderr ? 'STDERR: ' + stderr : ''}${err ? 'ERR: ' + err.message : ''}\n`
      );
    } catch (_) {}
    if (err) console.error('[BACKUP] Failed:', err.message);
    else     console.log('[BACKUP] Complete');
  });
}

// Daily at 02:00 AM
cron.schedule('0 2 * * *', runBackup, { timezone: 'Africa/Nairobi' });
console.log('[BACKUP] Scheduler active — daily at 02:00 AM Africa/Nairobi');

module.exports = { runBackup };
