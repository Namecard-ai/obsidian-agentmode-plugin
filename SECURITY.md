# Security Policy for Agentmode Obsidian Plugin

> This document provides a transparent overview of how the Agentmode plugin handles data transmission, backend services, and code transparency. As an AI-powered assistant plugin for Obsidian, network connectivity is required for core functionality.

## Table of Contents

- [Data Transmission and Privacy](#data-transmission-and-privacy)
- [Backend Service and Endpoints](#backend-service-and-endpoints)
- [Code Transparency](#code-transparency)
- [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities)

---

## Data Transmission and Privacy

### What Data is Transmitted?

The plugin transmits the following types of data to external servers:

| Data Type | Description | When Transmitted | Destination |
|-----------|-------------|------------------|-------------|
| **Chat Messages** | Full content of user messages and AI responses | When user sends a message | Backend API |
| **Note Content** | Text content of vault files added to context or read via AI tools | When files are attached to chat context or accessed by AI | Backend API |
| **File Metadata** | File names and paths (relative to vault root) | During embedding generation | Backend API |
| **Document Files** | Base64-encoded content of PDFs, Office documents, etc. | When reading convertible file types | Backend API |
| **Web Search Queries** | User's search queries | When AI uses web search tool | Backend API → Firecrawl |
| **URLs for Scraping** | Target URLs | When AI uses web scrape tool | Backend API → Firecrawl |
| **User Authentication** | OAuth tokens, email, name, user ID | During login/authentication | Auth0 |

### What Data is NOT Transmitted?

- **Vault Structure**: Full directory listing is not transmitted
- **Unselected Files**: Only files explicitly added to context or accessed by AI tools are transmitted
- **Local Settings**: Plugin settings remain local (except API keys for authenticated requests)
- **Embedding Vectors**: Generated embeddings are stored locally and not sent to servers

### How is Data Protected?

1. **Transport Encryption**: All network requests use HTTPS/TLS encryption
2. **Authentication**: Bearer token authentication required for all API requests
3. **Token Security**: Access tokens have expiration and automatic refresh mechanisms
4. **Local Storage**: Sensitive data (tokens, API keys) stored in Obsidian's plugin data folder
5. **BYOK Option**: Free tier users can use their own OpenAI/Firecrawl API keys (data goes directly to those providers)

### User Control Over Data

- Users must explicitly log in to enable network features
- Files must be manually added to chat context or explicitly accessed by AI tools
- Web search/scrape features require user-initiated AI tool calls
- Users can log out to stop all data transmission
- BYOK users' data flows directly to OpenAI/Firecrawl, bypassing our backend for LLM/search operations

---

## Backend Service and Endpoints

### Authentication Service (Auth0)

The plugin uses Auth0 for secure authentication via the OAuth 2.0 Device Authorization flow.

| Endpoint | Method | Purpose | Data Sent |
|----------|--------|---------|-----------|
| `https://{AUTH0_DOMAIN}/oauth/device/code` | POST | Initiate device auth flow | Client ID, scope |
| `https://{AUTH0_DOMAIN}/oauth/token` | POST | Exchange codes for tokens | Device code, client ID, grant type |
| `https://{AUTH0_DOMAIN}/userinfo` | GET | Retrieve user profile | Bearer token (header) |

**Trigger Conditions:**
- User clicks "Log in" button in plugin settings or status bar
- Automatic token refresh when token is expiring (checked every 5 minutes)

### Backend API Service

All backend API calls are made to a server configured via `BACKEND_BASE_URL` environment variable at build time.

#### Chat Completions

```
POST /v1/chat/completions
```

| Field | Description |
|-------|-------------|
| **Data Sent** | Model name, chat messages (including system prompt with context file contents), tool definitions, streaming flag |
| **Auth Required** | Yes (Bearer token + optional X-BYOK header) |
| **Trigger** | User sends a message in chat interface |

#### Text Embeddings

```
POST /v1/embeddings
```

| Field | Description |
|-------|-------------|
| **Data Sent** | Text content chunks with file metadata (file name, path, chunk position) |
| **Auth Required** | Yes (Bearer token + optional X-BYOK header) |
| **Trigger** | File modification, vault batch indexing, manual reindex |

#### Document Conversion

```
POST /v1/convert
```

| Field | Description |
|-------|-------------|
| **Data Sent** | Base64-encoded file as data URI (PDF, PPTX, DOCX, XLSX, etc.) |
| **Auth Required** | Yes (Bearer token) |
| **Trigger** | AI reads a convertible file type (PDF, Office documents, HTML) |

#### Web Search

```
POST /v1/search
```

| Field | Description |
|-------|-------------|
| **Data Sent** | Search query string |
| **Auth Required** | Yes (Bearer token + optional X-BYOK for Firecrawl) |
| **Trigger** | AI agent invokes `web_search` tool |

#### Web Scraping

```
POST /v1/scrape
```

| Field | Description |
|-------|-------------|
| **Data Sent** | Target URL, format options |
| **Auth Required** | Yes (Bearer token + optional X-BYOK for Firecrawl) |
| **Trigger** | AI agent invokes `web_scrape` tool |

#### User Profile

```
GET /v1/user/profile
```

| Field | Description |
|-------|-------------|
| **Data Sent** | None (read-only) |
| **Auth Required** | Yes (Bearer token) |
| **Trigger** | Opening plugin settings page |

#### Billing Portal Session

```
POST /v1/user/billing-session
```

| Field | Description |
|-------|-------------|
| **Data Sent** | None |
| **Auth Required** | Yes (Bearer token) |
| **Trigger** | User clicks "Manage Billing" button |

### Third-Party Services

| Service | Purpose | Data Shared | When Used |
|---------|---------|-------------|-----------|
| **OpenAI API** | LLM inference, embeddings | Chat messages, file content | BYOK mode or via backend proxy |
| **Azure OpenAI** | LLM inference (Pro tier) | Chat messages, file content | Pro tier via backend |
| **Firecrawl** | Web search and scraping | Search queries, URLs | Web tools via backend |
| **Auth0** | User authentication | OAuth data | Login/authentication |
| **Stripe** | Subscription billing | Handled via Auth0/backend | Billing portal |

---

## Code Transparency

### Open Source Components

The plugin is built using the following key dependencies (see `package.json`):

- **Obsidian API** - Official plugin SDK
- **React** - UI framework
- **OpenAI SDK** - API client for OpenAI-compatible endpoints
- **Tiptap** - Rich text editor
- **js-tiktoken** - Token counting for context management
- **crypto-js** - MD5 hashing for local caching

### Configuration Transparency

**Environment Variables (Build-Time)**

These values are injected at build time and not configurable by end users:

| Variable | Purpose |
|----------|---------|
| `BACKEND_BASE_URL` | Backend API server URL |
| `AUTH0_DOMAIN` | Auth0 tenant domain |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `AUTH0_AUDIENCE` | Auth0 API audience |

**User-Configurable Settings**

Stored locally in `.obsidian/plugins/obsidian-agentmode-plugin/data.json`:

| Setting | Description | Sensitive |
|---------|-------------|-----------|
| `openaiApiKey` | User's OpenAI API key (BYOK) | Yes |
| `firecrawlApiKey` | User's Firecrawl API key (BYOK) | Yes |
| `accessToken` | Auth0 access token | Yes |
| `refreshToken` | Auth0 refresh token | Yes |
| `tokenExpiry` | Token expiration timestamp | No |
| `userInfo` | Cached user profile (email, name, sub) | Partial |
| `isLoggedIn` | Login state flag | No |

### Network Request Implementation

All network requests in the plugin use Obsidian's built-in `requestUrl` API, which:
- Ensures proper CORS handling in the desktop app
- Provides consistent error handling
- Supports all HTTP methods needed for the API

The OpenAI SDK is configured with a custom `baseURL` pointing to our backend, enabling:
- Unified authentication via Bearer tokens
- BYOK key forwarding via `X-BYOK` header
- Streaming support for real-time chat responses

### Local Data Storage

| Data | Location | Purpose |
|------|----------|---------|
| Plugin Settings | `.obsidian/plugins/obsidian-agentmode-plugin/data.json` | User preferences, API keys, auth tokens |
| Embedding Vectors | `.obsidian/plugins/obsidian-agentmode-plugin/vectors/` | Local semantic search index |
| Chat History | `.obsidian/plugins/obsidian-agentmode-plugin/chat-history/` | Conversation logs (max 30 entries) |

### Code Audit Information

- **Primary Source Files**: `main.ts`, `AgentChatView.tsx`, `LoginComponent.tsx`
- **Network Code Locations**: 
  - Auth0 service: `main.ts` (Auth0Service class, lines ~263-600)
  - Chat API: `main.ts` (streamAgentChat method, lines ~1173-1630)
  - Backend tools: `main.ts` (toolWebSearch, toolWebScrape, toolConvert methods)
- **No Obfuscation**: Source code is compiled TypeScript, not obfuscated

---

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this plugin, please report it responsibly:

1. **Do NOT** create a public GitHub issue for security vulnerabilities
2. **Email**: Contact the maintainers directly (see plugin manifest for contact info)
3. **Include**: 
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond to security reports within 48 hours and will work with reporters to understand and address the issue promptly.



