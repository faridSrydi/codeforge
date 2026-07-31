import fs from 'fs';
import path from 'path';
import os from 'os';

export interface VPSCredentials {
  serverUrl: string;
  username: string;
  token: string;
  loginAt?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.codeforge');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/**
 * Ensure ~/.codeforge directory exists
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Save VPS credentials to ~/.codeforge/credentials.json
 */
export function saveVPSCredentials(creds: VPSCredentials): void {
  ensureConfigDir();
  const data: VPSCredentials = {
    ...creds,
    loginAt: new Date().toISOString()
  };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Read stored VPS credentials from ~/.codeforge/credentials.json
 */
export function getVPSCredentials(): VPSCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    const data = JSON.parse(content) as VPSCredentials;
    if (data.serverUrl && data.token) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete stored VPS credentials (logout)
 */
export function clearVPSCredentials(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Get active Authorization header string
 */
export function getVPSAuthHeader(): string | null {
  const creds = getVPSCredentials();
  if (creds && creds.token) {
    return `Bearer ${creds.token}`;
  }
  return null;
}

/**
 * Get active VPS Base API URL (defaults to http://localhost:3000 if not saved)
 */
export function getVPSBaseUrl(): string {
  const creds = getVPSCredentials();
  if (creds && creds.serverUrl) {
    // Ensure no trailing slash
    return creds.serverUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}
