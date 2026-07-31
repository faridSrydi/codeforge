import { createUser } from './db.js';

/**
 * Seed the database with a default admin user.
 * Run: node seed.js
 */

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

try {
  const user = createUser({
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    displayName: 'Administrator',
    role: 'admin',
    maxRequestsPerDay: 9999
  });

  console.log('');
  console.log('  ✅ Admin user created successfully!');
  console.log('');
  console.log(`  👤 Username: ${ADMIN_USERNAME}`);
  console.log(`  🔑 Password: ${ADMIN_PASSWORD}`);
  console.log(`  🛡️  Role:     admin`);
  console.log('');
  console.log('  ⚠️  Please change the default password after first login!');
  console.log('');
} catch (err) {
  if (err.message?.includes('UNIQUE constraint')) {
    console.log('');
    console.log('  ⚠️  Admin user already exists. Skipping seed.');
    console.log('');
  } else {
    console.error('  ❌ Failed to create admin user:', err.message);
  }
}

process.exit(0);
