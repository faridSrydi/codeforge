import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DIST_DIR = path.join(process.cwd(), 'dist');

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

console.log('\n  ⚡ CodeForge Binary Builder');
console.log('  =========================================\n');

// Only externalize dynamic optional modules that are not installed
const externals = [
  '@aws-sdk/client-sts',
  '@aws-sdk/client-bedrock',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
  'modifiers-napi',
  'turndown',
  'sharp',
  'fflate',
  'yaml'
].map(e => `--external "${e}"`).join(' ');

const targets = [
  { name: 'Windows x64', target: 'bun-windows-x64', outfile: 'dist/codeforge.exe' },
  { name: 'Mac ARM64 (Apple Silicon)', target: 'bun-darwin-arm64', outfile: 'dist/codeforge-mac-arm64' },
  { name: 'Mac x64 (Intel)', target: 'bun-darwin-x64', outfile: 'dist/codeforge-mac-x64' },
];

for (const t of targets) {
  try {
    console.log(`📦 Building for ${t.name}...`);
    const cmd = `bun build src/entrypoints/cli.tsx --compile --target=${t.target} --outfile=${t.outfile} ${externals}`;
    execSync(cmd, { stdio: 'inherit' });
    console.log(`   ✅ Built: ${t.outfile}\n`);
  } catch (err: any) {
    console.error(`   ❌ Failed to build for ${t.name}:`, err.message || err);
  }
}

console.log('🎉 Binary build process finished! Check ./dist/ folder.\n');
