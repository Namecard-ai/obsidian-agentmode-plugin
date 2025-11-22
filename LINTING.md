# ESLint 配置說明

本專案使用**雙 ESLint 配置**系統，可以在不影響現有開發流程的情況下，使用 Obsidian 官方的插件檢查規則。

## 📋 配置文件

### 1. `.eslintrc` (ESLint 8 - 主要開發配置)
- **用途**：日常開發的主要 lint 配置
- **版本**：ESLint 8.57.1
- **規則**：基本 TypeScript ESLint 規則

### 2. `eslint.obsidian.config.mjs` (ESLint 9 - Obsidian 專用檢查)
- **用途**：Obsidian 插件特定規則檢查
- **版本**：ESLint 9 (透過 npx 臨時執行)
- **規則**：`eslint-plugin-obsidianmd` 推薦規則集

## 🚀 使用方式

### 日常開發 Linting (使用 ESLint 8)
```bash
# 檢查代碼
npm run lint

# 自動修復
npm run lint:fix
```

### Obsidian 插件規則檢查 (使用 ESLint 9)
```bash
# 執行 Obsidian 專用檢查
npm run lint:obsidian
```

**注意**：首次運行 `lint:obsidian` 時，npx 會自動下載 ESLint 9，可能需要幾秒鐘。

## 📊 Obsidian 檢查項目

`lint:obsidian` 會檢查以下 Obsidian 插件最佳實踐：

- ✅ 命令 ID 和名稱命名規範
- ✅ 避免內存洩漏（view references, component lifecycle）
- ✅ 正確使用 FileManager API
- ✅ UI 文字使用 sentence case
- ✅ 避免硬編碼配置路徑
- ✅ manifest.json 和 LICENSE 驗證
- ✅ 類型安全（TFile/TFolder instanceof 檢查）
- ✅ 移動設備兼容性（正則表達式 lookbehind 等）

## 🔧 技術細節

### 為什麼需要兩套配置？

`eslint-plugin-obsidianmd` 是 ESM 模塊，且要求 ESLint 9+，而本專案使用 ESLint 8 進行日常開發。為了**不侵入改動現有配置**，我們使用以下方案：

1. **保留** ESLint 8 和 `.eslintrc` 作為主要配置
2. **新增** `eslint.obsidian.config.mjs` 作為獨立的 ESLint 9 配置
3. **使用** `npx` 臨時運行 ESLint 9，無需安裝為依賴

### npx 工作原理

```bash
ESLINT_USE_FLAT_CONFIG=true npx --yes --package=eslint@9 -- eslint -c eslint.obsidian.config.mjs .
```

- `ESLINT_USE_FLAT_CONFIG=true`: 啟用 ESLint 9 的 flat config
- `npx --package=eslint@9`: 臨時使用 ESLint 9 (不影響本地安裝的 ESLint 8)
- `-c eslint.obsidian.config.mjs`: 使用 Obsidian 專用配置

## ⚠️ 注意事項

1. **兩個配置互不干擾**：
   - `npm run lint` 使用本地 ESLint 8
   - `npm run lint:obsidian` 使用 npx 的 ESLint 9

2. **CI/CD 整合**：
   如需在 CI/CD 中運行 Obsidian 檢查，確保：
   - 有網絡訪問權限（npx 需要下載）
   - 或在 CI 鏡像中預裝 ESLint 9

3. **可選性**：
   - `lint:obsidian` 是完全可選的
   - 可以只在發布前或 PR 時運行
   - 不影響現有的開發流程

## 📝 修改建議

如果您想調整 Obsidian 規則：

1. 編輯 `eslint.obsidian.config.mjs`
2. 在 `rules` 部分覆蓋或禁用特定規則

例如：
```javascript
rules: {
  // 基本規則
  // ...
  
  // Obsidian 插件推薦規則
  ...obsidianmd.configs.recommended,
  
  // 自定義覆蓋
  'obsidianmd/ui/sentence-case': 'warn',  // 改為警告
  'obsidianmd/sample-names': 'off'        // 關閉此規則
}
```

