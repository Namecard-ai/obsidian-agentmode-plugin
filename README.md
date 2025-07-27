# Obsidian Agent Plugin

An AI-powered assistant plugin for Obsidian (https://obsidian.md) that provides intelligent chat functionality with context-aware file integration.

This project uses TypeScript and React to provide a modern, responsive chat interface that integrates seamlessly with your Obsidian vault. The plugin leverages the latest Obsidian API and includes comprehensive AI agent capabilities.

## Key Features
- **Context-Aware Conversations**: Seamlessly integrate vault files into your chat context
- **Agent Mode**: Execute tasks and automation through AI assistance
- **File Integration**: Advanced drag-and-drop and file picker functionality
- **Upload Image**: Upload image to the chat

## Chat Interface Features

The plugin now includes a modern chat interface with the following features:

### Context File Selection
- **Button Method**: Click the "🔗 Add Context" button to open Obsidian's native file picker
  - Search and select markdown files from your vault using fuzzy search
  - Navigate with arrow keys and select with Enter
- **Drag & Drop Method**: Drag files directly from Obsidian's file explorer into the chat area
  - Visual feedback with blue overlay when dragging files over the chat
  - Supports multiple file selection and dropping
  - Only accepts markdown (.md) files
- Selected files appear as tags below the input area
- Remove files by clicking the × button on each tag
- Context files are automatically included in your messages to provide relevant information

### Chat Modes
- **Ask Mode**: For general questions and inquiries
- **Agent Mode**: For task execution and automation

### Additional Features
- Multiple AI model selection (Claude, GPT, Gemini)
- Chat history management
- File upload support
- Responsive dark theme UI

## Development Setup

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn package manager
- Obsidian app installed

### Installation & Development

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd obsidian-agent-plugin
   npm install
   ```

2. **Environment Configuration**
   
   The plugin supports configuring the backend URL through environment variables for different environments.

   **Copy Example Files**
   ```bash
   cp .env.example .env.development
   cp .env.example .env.production
   ```

   **Environment Variable Files:**
   
   - **`.env.development`** - Development Environment
     ```bash
     # Development environment configuration
     # Backend URL for local development
     BACKEND_BASE_URL=http://localhost:8080/v1
     ```

   - **`.env.production`** - Production Environment  
     ```bash
     # Production environment configuration
     # Backend URL for production (can be empty to use OpenAI directly)
     BACKEND_BASE_URL=
     ```

   **Configuration Notes:**
   - `.env.development` and `.env.production` are added to `.gitignore` and will not be committed to version control
   - Only `.env.example` will be committed as a configuration example

3. **Development & Build Commands**

   **Development Mode**
   ```bash
   npm run dev
   ```
   Uses `.env.development` configuration and starts compilation in watch mode with automatic rebuilds.

   **Production Build**
   ```bash
   npm run build
   # or explicitly specify
   npm run build:prod
   ```
   Uses `.env.production` configuration for production build.

   **Development Build**
   ```bash
   npm run build:dev  
   ```
   Uses `.env.development` configuration for building (for testing the build result of development configuration).

4. **Plugin Installation**
   - Copy the built files (`main.js`, `styles.css`, `manifest.json`) to your vault's plugin folder:
     `VaultFolder/.obsidian/plugins/obsidian-agent-plugin/`
   - Or for development, place the entire project folder in your vault's plugins directory
   - Enable the plugin in Obsidian's settings

5. **Testing Changes**
   - After making changes, reload Obsidian (Ctrl/Cmd + R)
   - The plugin will use the newly compiled code

### Project Structure
- `main.ts` - Main plugin entry point
- `ObsidianAgentChatView.tsx` - React chat interface component
- `ReactView.tsx` - React view wrapper
- `MarkdownRenderer.tsx` - Markdown rendering utilities
- `styles.css` - Plugin styling

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to Use the Plugin

Once installed and enabled, the Obsidian Agent Plugin provides:

1. **Access the Chat Interface**
   - Click the plugin icon in the ribbon
   - Or use the command palette: "Open Agent Chat"

2. **Add Context Files**
   - Use the "🔗 Add Context" button to browse and select files
   - Or drag files directly from the file explorer into the chat area
   - Selected files will be included in your conversation context

3. **Choose Your Mode**
   - **Ask Mode**: For questions, research, and general inquiries
   - **Agent Mode**: For task execution and automation

4. **Select AI Model**
   - Choose from available models (Claude, GPT, Gemini)
   - Each model has different strengths and capabilities

## Manual Installation

If you prefer to install manually:

1. Download the latest release files: `main.js`, `styles.css`, `manifest.json`
2. Create a folder named `obsidian-agent-plugin` in your vault's plugins directory:
   `VaultFolder/.obsidian/plugins/obsidian-agent-plugin/`
3. Copy the downloaded files into this folder
4. Restart Obsidian and enable the plugin in settings

## Code Quality & Linting

This project uses ESLint for code quality analysis:

```bash
# Install ESLint globally (if not already installed)
npm install -g eslint

# Analyze the main TypeScript files
eslint main.ts *.tsx

# Or analyze all TypeScript files
eslint ./*.ts ./*.tsx
```

ESLint will provide suggestions for code improvements, help catch common bugs, and ensure consistent code style across the project.

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
```


## API Documentation

See https://github.com/obsidianmd/obsidian-api
