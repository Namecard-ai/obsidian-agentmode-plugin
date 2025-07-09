# 環境變數配置說明

## 概述

前端 plugin 現在支援透過環境變數來配置後端 URL，而不需要使用者手動設定。這樣可以在開發和生產環境中使用不同的配置。

## 環境變數文件

### `.env.development` - 開發環境
```bash
# Development environment configuration
# Backend URL for local development
BACKEND_BASE_URL=http://localhost:8080/v1
```

### `.env.production` - 生產環境  
```bash
# Production environment configuration
# Backend URL for production (can be empty to use OpenAI directly)
BACKEND_BASE_URL=
```

### `.env.example` - 範例文件
這是一個範例文件，可以複製並修改為 `.env.development` 或 `.env.production`。

## 構建命令

### 開發模式
```bash
npm run dev
```
使用 `.env.development` 配置，啟動開發伺服器

### 生產構建  
```bash
npm run build
# 或明確指定
npm run build:prod
```
使用 `.env.production` 配置進行生產構建

### 開發構建
```bash
npm run build:dev  
```
使用 `.env.development` 配置進行構建（用於測試開發配置的構建結果）

## 使用方式

1. **複製範例文件**
   ```bash
   cp .env.example .env.development
   cp .env.example .env.production
   ```

2. **修改配置**
   - 在 `.env.development` 中設定本地後端 URL: `http://localhost:8080/v1`
   - 在 `.env.production` 中可以留空（直接使用 OpenAI API）或設定生產後端 URL

3. **構建**
   - 開發: `npm run dev` 或 `npm run build:dev`
   - 生產: `npm run build` 或 `npm run build:prod`

## 注意事項

- `.env.development` 和 `.env.production` 已添加到 `.gitignore`，不會被提交到版本控制
- 只有 `.env.example` 會被提交，作為配置範例
- 如果 `BACKEND_BASE_URL` 為空，plugin 會直接使用 OpenAI API
- 如果設定了 `BACKEND_BASE_URL`，plugin 會使用指定的後端服務 