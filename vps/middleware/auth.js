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
 * Middleware: Require valid JWT token
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { type: 'authentication_error', message: 'Missing or invalid authorization header. Use: Bearer <token>' }
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
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
      error: { type: 'permission_error', message: 'Admin access required.' }
    });
  }
  next();
}
