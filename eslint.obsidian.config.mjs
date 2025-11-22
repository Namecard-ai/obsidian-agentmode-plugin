// ESLint 9 配置文件，專門用於 Obsidian 插件規則檢查
// 使用方式：ESLINT_USE_FLAT_CONFIG=true npx eslint@9 -c eslint.obsidian.config.mjs .

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['node_modules/**', 'main.js', '**/*.d.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest',
        project: './tsconfig.json'
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        module: 'readonly',
        require: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      obsidianmd: obsidianmd
    },
    rules: {
      // 基本規則
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-prototype-builtins': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      
      // Obsidian 插件推薦規則
      ...obsidianmd.configs.recommended,
      
      // 自定義 sentence-case 規則配置
      'obsidianmd/ui/sentence-case': [
        'warn',  // 改為警告而非錯誤
        {
          brands: ['Agentmode', 'OpenAI', 'Auth0', 'Firecrawl'],
          acronyms: ['API', 'JSON', 'BYOK', 'AI'],
          enforceCamelCaseLower: false  // 允許 CamelCase 命名
        }
      ]
    }
  }
];

