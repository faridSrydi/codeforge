import { Router } from 'express';
import { verifyUser, getUserById } from '../db.js';
import { generateToken } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { token, user }
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'Username and password are required.' }
      });
    }

    const user = verifyUser(username, password);

    if (!user) {
      return res.status(401).json({
        error: { type: 'authentication_error', message: 'Invalid username or password.' }
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: { type: 'permission_error', message: 'Your account has been deactivated. Contact admin.' }
      });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[Auth Login Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Internal server error.' } });
  }
});

/**
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 * Returns: { user }
 */
router.get('/me', (req, res) => {
  try {
    const user = getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: { type: 'not_found', message: 'User not found.' } });
    }
    res.json({ user });
  } catch (err) {
    console.error('[Auth Me Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Internal server error.' } });
  }
});

export default router;
