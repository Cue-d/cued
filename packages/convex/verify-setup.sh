#!/bin/bash
# Verification script for Convex setup

set -e

echo "🔍 Verifying Convex setup..."
echo ""

# Check if in correct directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: Run this script from packages/convex directory"
  exit 1
fi

# Check _generated directory
if [ ! -d "convex/_generated" ]; then
  echo "❌ convex/_generated/ directory not found"
  echo "   Run: pnpm dev (and complete interactive setup)"
  exit 1
fi
echo "✅ convex/_generated/ directory exists"

# Check .env.local
if [ ! -f ".env.local" ]; then
  echo "❌ .env.local not found"
  echo "   Run: pnpm dev (and complete interactive setup)"
  exit 1
fi
echo "✅ .env.local exists"

# Check CONVEX_DEPLOYMENT
if grep -q "CONVEX_DEPLOYMENT" .env.local; then
  DEPLOYMENT=$(grep "CONVEX_DEPLOYMENT" .env.local | cut -d '=' -f2)
  echo "✅ CONVEX_DEPLOYMENT found: $DEPLOYMENT"
else
  echo "❌ CONVEX_DEPLOYMENT not found in .env.local"
  exit 1
fi

# Check if convex dev can connect (non-blocking)
echo ""
echo "🔄 Testing Convex connection..."
echo "   (This will timeout after 5 seconds if connection fails)"
timeout 5s npx convex dev --once 2>&1 | grep -q "Connected to Convex" && echo "✅ Connected to Convex successfully" || echo "⚠️  Could not verify connection (this may be normal if dev server is already running)"

echo ""
echo "✨ Convex setup verification complete!"
echo ""
echo "Next steps:"
echo "1. Copy deployment URL to apps/web/.env.local as NEXT_PUBLIC_CONVEX_URL"
echo "2. See SETUP.md for detailed instructions"
