require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const productRoutes  = require('./routes/products');
const salesRoutes    = require('./routes/sales');
const mpesaRoutes    = require('./routes/mpesa');
const reportsRoutes  = require('./routes/reports');
const logsRoutes     = require('./routes/logs');
const settingsRoutes = require('./routes/settings');
const categoryRoutes = require('./routes/categories');

// Give mpesa service access to DB so it can read credentials saved via Settings UI
const db = require('./db/connection');
require('./services/mpesa').init(db);

// Scheduled backup (only when not on Render — Render has ephemeral filesystem)
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_BACKUP === 'true') {
  try { require('../scripts/backup'); } catch (e) { console.warn('[BACKUP] Scheduler not loaded:', e.message); }
}

const app    = express();
const PORT   = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === 'production';

// ── Security ──────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

// ── CORS — allow Vercel frontend + local dev ──────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,           // https://your-app.vercel.app
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                        // mobile/Postman/curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (!isProd) return cb(null, true);                        // allow all in dev
    // In production also allow any *.vercel.app subdomain (preview deploys)
    if (/\.vercel\.app$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// ── Rate limiting ─────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 60_000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
}));
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60_000, max: 20,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
}));

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:  'ok',
  service: 'Permic Wear API',
  env:     process.env.NODE_ENV || 'development',
  db:      process.env.DATABASE_URL ? 'postgresql' : 'mysql',
  time:    new Date().toISOString(),
}));

// Root route so Render health checks don't 404
app.get('/', (_req, res) => res.json({ service: 'Permic Wear API', status: 'running' }));

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/products',   productRoutes);
app.use('/api/sales',      salesRoutes);
app.use('/api/mpesa',      mpesaRoutes);
app.use('/api/reports',    reportsRoutes);
app.use('/api/logs',       logsRoutes);
app.use('/api/settings',   settingsRoutes);
app.use('/api/categories', categoryRoutes);

app.use('/api/auth', authRouter);

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));

// ── Global error handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (err.message?.startsWith('CORS')) return res.status(403).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Permic Wear API`);
  console.log(`   Port:     ${PORT}`);
  console.log(`   Mode:     ${process.env.NODE_ENV || 'development'}`);
  console.log(`   DB:       ${process.env.DATABASE_URL ? 'PostgreSQL/Supabase' : 'MySQL'}`);
  console.log(`   Frontend: ${process.env.FRONTEND_URL || '(not set)'}`);
  console.log(`   M-Pesa:   ${process.env.MPESA_ENV || 'production'}\n`);
});

module.exports = app;
