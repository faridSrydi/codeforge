import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'codeforge.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
    max_requests_per_day INTEGER DEFAULT 100,
    total_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    model TEXT DEFAULT '',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
`);

// ─── User Operations ────────────────────────────────────

/**
 * Create a new user
 */
export function createUser({ username, password, displayName = '', role = 'user', maxRequestsPerDay = 100 }) {
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 12);

  const stmt = db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, role, max_requests_per_day)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, username.toLowerCase().trim(), passwordHash, displayName, role, maxRequestsPerDay);
  return { id, username: username.toLowerCase().trim(), displayName, role, maxRequestsPerDay };
}

/**
 * Verify user credentials and return user if valid
 */
export function verifyUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.toLowerCase().trim());
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;

  // Update last active
  db.prepare(`UPDATE users SET last_active_at = datetime('now') WHERE id = ?`).run(user.id);

  return sanitizeUser(user);
}

/**
 * Get user by ID (without password hash)
 */
export function getUserById(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return user ? sanitizeUser(user) : null;
}

/**
 * Get all users (admin)
 */
export function getAllUsers() {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  return users.map(sanitizeUser);
}

/**
 * Update user
 */
export function updateUser(id, updates) {
  const allowed = ['display_name', 'role', 'is_active', 'max_requests_per_day'];
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    const dbKey = camelToSnake(key);
    if (allowed.includes(dbKey)) {
      setClauses.push(`${dbKey} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return null;

  setClauses.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

/**
 * Reset user password
 */
export function resetUserPassword(id, newPassword) {
  const passwordHash = bcrypt.hashSync(newPassword, 12);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, id);
  return true;
}

/**
 * Delete user
 */
export function deleteUser(id) {
  db.prepare('DELETE FROM request_logs WHERE user_id = ?').run(id);
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check user's daily request count
 */
export function getUserDailyRequestCount(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM request_logs
    WHERE user_id = ? AND created_at >= datetime('now', '-1 day')
  `).get(userId);
  return row.count;
}

/**
 * Log a request
 */
export function logRequest({ userId, model = '', inputTokens = 0, outputTokens = 0, durationMs = 0, status = 'success' }) {
  db.prepare(`
    INSERT INTO request_logs (user_id, model, input_tokens, output_tokens, duration_ms, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, model, inputTokens, outputTokens, durationMs, status);

  // Update user totals
  db.prepare(`
    UPDATE users SET
      total_requests = total_requests + 1,
      total_tokens = total_tokens + ? + ?,
      last_active_at = datetime('now')
    WHERE id = ?
  `).run(inputTokens, outputTokens, userId);
}

/**
 * Get dashboard stats
 */
export function getDashboardStats() {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const activeUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get().count;

  const todayRequests = db.prepare(`
    SELECT COUNT(*) as count FROM request_logs WHERE created_at >= datetime('now', '-1 day')
  `).get().count;

  const totalRequests = db.prepare('SELECT COUNT(*) as count FROM request_logs').get().count;

  const totalTokens = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM request_logs
  `).get().total;

  const todayTokens = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM request_logs
    WHERE created_at >= datetime('now', '-1 day')
  `).get().total;

  // Requests per hour (last 24h)
  const requestsPerHour = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM request_logs
    WHERE created_at >= datetime('now', '-1 day')
    GROUP BY hour ORDER BY hour
  `).all();

  // Top users by requests
  const topUsers = db.prepare(`
    SELECT u.username, u.display_name, COUNT(r.id) as request_count,
           COALESCE(SUM(r.input_tokens + r.output_tokens), 0) as token_count
    FROM users u
    LEFT JOIN request_logs r ON u.id = r.user_id AND r.created_at >= datetime('now', '-7 day')
    GROUP BY u.id ORDER BY request_count DESC LIMIT 10
  `).all();

  return {
    totalUsers,
    activeUsers,
    todayRequests,
    totalRequests,
    totalTokens,
    todayTokens,
    requestsPerHour,
    topUsers
  };
}

// ─── Helpers ─────────────────────────────────────────────

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return {
    id: safe.id,
    username: safe.username,
    displayName: safe.display_name,
    role: safe.role,
    isActive: !!safe.is_active,
    maxRequestsPerDay: safe.max_requests_per_day,
    totalRequests: safe.total_requests,
    totalTokens: safe.total_tokens,
    createdAt: safe.created_at,
    updatedAt: safe.updated_at,
    lastActiveAt: safe.last_active_at
  };
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export default db;
