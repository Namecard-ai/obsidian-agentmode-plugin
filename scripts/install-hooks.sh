#!/bin/bash

# Install git hooks script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"

echo "🔧 Installing git hooks..."

# Check if .git/hooks directory exists
if [ ! -d "$HOOKS_DIR" ]; then
    echo "❌ Error: .git/hooks directory does not exist"
    echo "Please ensure you are running this script in the git project root directory"
    exit 1
fi

# Copy pre-push hook
cp "$SCRIPT_DIR/pre-push-hook.sh" "$HOOKS_DIR/pre-push"
chmod +x "$HOOKS_DIR/pre-push"

echo "✅ pre-push hook installed"

# Give execute permission to validate-tag.js
chmod +x "$SCRIPT_DIR/validate-tag.js"

echo "✅ Git hooks installation completed!"
echo ""
echo "Now when you push commits containing tags, the system will automatically validate if the tag version matches manifest.json"
echo ""
echo "To manually validate a tag, use:"
echo "  node scripts/validate-tag.js <tag-name>"
