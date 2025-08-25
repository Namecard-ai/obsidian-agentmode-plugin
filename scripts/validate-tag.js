#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Validate if git tag matches the version in manifest.json
 * @param {string} tagName - git tag name
 * @returns {boolean} - whether they match
 */
function validateTag(tagName) {
    try {
        // Read manifest.json
        const manifestPath = path.join(__dirname, '..', 'manifest.json');
        const manifestContent = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent);
        
        const manifestVersion = manifest.version;
        
        // Remove 'v' prefix from tag (if exists)
        const cleanTag = tagName.startsWith('v') ? tagName.slice(1) : tagName;
        
        console.log(`Checking tag: ${tagName} (cleaned: ${cleanTag})`);
        console.log(`manifest.json version: ${manifestVersion}`);
        
        if (cleanTag === manifestVersion) {
            console.log('✅ Tag version matches manifest.json version');
            return true;
        } else {
            console.error('❌ Tag version does not match manifest.json version');
            console.error(`Tag: ${cleanTag}`);
            console.error(`Manifest: ${manifestVersion}`);
            console.error('Please ensure tag version matches the version field in manifest.json');
            return false;
        }
    } catch (error) {
        console.error('❌ Error occurred during validation:', error.message);
        return false;
    }
}

// If this script is executed directly
if (require.main === module) {
    const tagName = process.argv[2];
    
    if (!tagName) {
        console.error('Usage: node validate-tag.js <tag-name>');
        console.error('Example: node validate-tag.js v1.0.11-beta');
        process.exit(1);
    }
    
    const isValid = validateTag(tagName);
    process.exit(isValid ? 0 : 1);
}

module.exports = { validateTag };
