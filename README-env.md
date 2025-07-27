# Environment Variables Configuration

## Overview

The frontend plugin now supports configuring the backend URL through environment variables instead of requiring manual user configuration. This allows for different configurations in development and production environments.

## Environment Variable Files

### `.env.development` - Development Environment
```bash
# Development environment configuration
# Backend URL for local development
BACKEND_BASE_URL=http://localhost:8080/v1
```

### `.env.production` - Production Environment  
```bash
# Production environment configuration
# Backend URL for production (can be empty to use OpenAI directly)
BACKEND_BASE_URL=
```

### `.env.example` - Example File
This is an example file that can be copied and modified as `.env.development` or `.env.production`.

## Build Commands

### Development Mode
```bash
npm run dev
```
Uses `.env.development` configuration and starts the development server

### Production Build  
```bash
npm run build
# or explicitly specify
npm run build:prod
```
Uses `.env.production` configuration for production build

### Development Build
```bash
npm run build:dev  
```
Uses `.env.development` configuration for building (for testing the build result of development configuration)

## Usage

1. **Copy Example Files**
   ```bash
   cp .env.example .env.development
   cp .env.example .env.production
   ```

2. **Modify Configuration**
   - Set local backend URL in `.env.development`: `http://localhost:8080/v1`
   - In `.env.production`, can be left empty (use OpenAI API directly) or set production backend URL

3. **Build**
   - Development: `npm run dev` or `npm run build:dev`
   - Production: `npm run build` or `npm run build:prod`

## Notes

- `.env.development` and `.env.production` are added to `.gitignore` and will not be committed to version control
- Only `.env.example` will be committed as a configuration example
- If `BACKEND_BASE_URL` is empty, the plugin will use OpenAI API directly
- If `BACKEND_BASE_URL` is set, the plugin will use the specified backend service 