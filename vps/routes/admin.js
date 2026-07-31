import { Router } from 'express';
import { getAllUsers, createUser, updateUser, deleteUser, resetUserPassword, getDashboardStats } from '../db.js';

const router = Router();

/**
 * GET /api/admin/stats
 * Returns dashboard statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = getDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('[Admin Stats Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to fetch stats.' } });
  }
});

/**
 * GET /api/admin/users
 * Returns all users
 */
router.get('/users', (req, res) => {
  try {
    const users = getAllUsers();
    res.json({ users });
  } catch (err) {
    console.error('[Admin Users Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to fetch users.' } });
  }
});

/**
 * POST /api/admin/users
 * Body: { username, password, displayName?, role?, maxRequestsPerDay? }
 * Creates a new user
 */
router.post('/users', (req, res) => {
  try {
    const { username, password, displayName, role, maxRequestsPerDay } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'Username and password are required.' }
      });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'Username must be 3-30 characters.' }
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'Password must be at least 6 characters.' }
      });
    }

    const user = createUser({ username, password, displayName, role, maxRequestsPerDay });
    res.status(201).json({ user });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({
        error: { type: 'conflict', message: 'Username already exists.' }
      });
    }
    console.error('[Admin Create User Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to create user.' } });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Body: { displayName?, role?, isActive?, maxRequestsPerDay? }
 * Updates a user
 */
router.patch('/users/:id', (req, res) => {
  try {
    const user = updateUser(req.params.id, req.body);
    if (!user) {
      return res.status(404).json({ error: { type: 'not_found', message: 'User not found.' } });
    }
    res.json({ user });
  } catch (err) {
    console.error('[Admin Update User Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to update user.' } });
  }
});

/**
 * POST /api/admin/users/:id/reset-password
 * Body: { password }
 * Resets user password
 */
router.post('/users/:id/reset-password', (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'Password must be at least 6 characters.' }
      });
    }
    resetUserPassword(req.params.id, password);
    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    console.error('[Admin Reset Password Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to reset password.' } });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Deletes a user
 */
router.delete('/users/:id', (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user.id) {
      return res.status(400).json({
        error: { type: 'validation_error', message: 'You cannot delete your own account.' }
      });
    }

    const deleted = deleteUser(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: { type: 'not_found', message: 'User not found.' } });
    }
    res.json({ message: 'User deleted successfully.' });
  } catch (err) {
    console.error('[Admin Delete User Error]', err);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to delete user.' } });
  }
});

export default router;
