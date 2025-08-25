#!/bin/bash

# Git pre-push hook for validating tag version consistency with manifest.json
# This script executes when git push contains tags

# Get tags that are about to be pushed
while read local_ref local_sha remote_ref remote_sha; do
    # Check if it's a tag
    if [[ $local_ref == refs/tags/* ]]; then
        tag_name=${local_ref#refs/tags/}
        echo "🔍 Detected tag: $tag_name"
        
        # Execute tag validation script
        # Get the project root directory (two levels up from .git/hooks/)
        PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
        if ! node "$PROJECT_ROOT/scripts/validate-tag.js" "$tag_name"; then
            echo "❌ Tag validation failed, push blocked"
            echo "Please ensure tag version matches the version field in manifest.json"
            exit 1
        fi
    fi
done

echo "✅ All tag validations passed"
exit 0
