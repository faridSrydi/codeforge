import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'codeforge-super-secret-change-me';

/**
 * Generate JWT token for a user
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/**
 * Middleware: Require valid JWT token (supports Bearer token or x-api-key header)
 */
export function requireAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (apiKeyHeader) {
    token = apiKeyHeader.startsWith('Bearer ') ? apiKeyHeader.slice(7) : apiKeyHeader;
  }

  if (!token) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing or invalid authorization header.' }
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid or expired token. Please login again.' }
    });
  }
}

/**
 * Middleware: Require admin role
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      type: 'error',
      error: { type: 'permission_error', message: 'Admin access required.' }
    });
  }
  next();
}
