#!/bin/bash

echo ""
echo "  ⚡ CodeForge VPS Auto-Setup"
echo "  ═════════════════════════════════════"
echo ""

# 1. Copy .env if not exists
if [ ! -f .env ]; then
  echo "📋 Creating .env file from .env.example..."
  cp .env.example .env
fi

# 2. Build & Start Docker containers
echo "🐳 Starting Docker containers (Backend + Ollama)..."
docker compose up -d --build

# 3. Pull AI Model
echo ""
echo "🧠 Pulling Qwen2.5-Coder:14b AI Model into GPU..."
echo "   (This may take a few minutes depending on network speed)"
echo ""
docker exec -it codeforge-ollama ollama pull qwen2.5-coder:14b

echo ""
echo "  ✅ SETUP COMPLETE!"
echo "  ═════════════════════════════════════"
echo "  🌐 Dashboard: http://YOUR_VPS_IP:3000"
echo "  👤 Username:  admin"
echo "  🔑 Password:  admin123"
echo ""
