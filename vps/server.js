import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import proxyRoutes from './routes/proxy.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Middleware ───────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for dashboard
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

app.use(morgan('short'));
app.use(express.json({ limit: '10mb' }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { type: 'rate_limit_error', message: 'Too many requests. Please slow down.' } }
});
app.use(globalLimiter);

// ─── Static Files (Admin Dashboard) ─────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ──────────────────────────────────────────

// Auth (public: login; protected: /me)
app.use('/api/auth', (req, res, next) => {
  // Login is public, /me requires auth
  if (req.path === '/login' && req.method === 'POST') {
    return next();
  }
  return requireAuth(req, res, next);
}, authRoutes);

// Admin API (requires auth + admin role)
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

// AI Proxy (requires auth)
app.use('/v1', requireAuth, proxyRoutes);

// ─── Health Check ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ─── SPA Fallback (Admin Dashboard) ─────────────────────
app.get('*', (req, res) => {
  // Only serve index.html for non-API routes
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return res.status(404).json({ error: { type: 'not_found', message: 'Endpoint not found.' } });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error Handler ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({
    error: { type: 'server_error', message: 'Internal server error.' }
  });
});

// ─── Start Server ────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║                                          ║');
  console.log('  ║   ⚡ CodeForge VPS Backend               ║');
  console.log('  ║                                          ║');
  console.log(`  ║   🌐 Dashboard:  http://localhost:${PORT}    ║`);
  console.log(`  ║   🔌 API:        http://localhost:${PORT}/v1 ║`);
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
