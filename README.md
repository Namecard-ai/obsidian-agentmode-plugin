# Agentmode

An AI-powered assistant plugin for Obsidian (https://obsidian.md) that provides intelligent chat functionality with context-aware file integration.

> **Important Notice**: This plugin connects to a proprietary backend API service to process requests and deliver AI-powered features. All chat messages and file contexts are transmitted to our backend servers for processing.

## Key Features
- **Context-Aware Conversations**: Seamlessly integrate vault files into your chat context
- **Agent Mode**: Execute tasks and automation through AI assistance
- **Vault File Integration**: Advanced drag-and-drop and file picker functionality
- **Upload External Files**: Upload images and PDFs out side of the vault
- **Custom Agent Rules**: Personalize agent behavior with `AGENTMODE.md` configuration file

## Custom Agent Rules (AGENTMODE.md)

You can customize how the AI agent works with your vault by creating an `AGENTMODE.md` file in your vault's root directory. This feature is inspired by [Claude Code's CLAUDE.md](https://www.anthropic.com/engineering/claude-code-best-practices) but adapted specifically for note-taking workflows.

### How It Works

When you chat with the agent, it automatically looks for `AGENTMODE.md` in your vault's root directory. If found, the rules you define in that file will be followed with **HIGH PRIORITY** throughout all interactions.

### What You Can Configure

- **Note Organization**: Default folders, naming conventions, YAML frontmatter standards
- **Content Structure**: Preferred heading hierarchy, section templates, formatting rules
- **Linking Patterns**: How to create links, when to add tags, MOC (Map of Content) guidelines
- **Markdown Style**: List formatting, emphasis preferences, code block standards
- **Workflows**: Templates for specific note types (meetings, books, projects, etc.)
- **Language Preferences**: Content language, tone, and style guidelines

### Example Rules

```markdown
# My Vault Rules

## Note Organization
- Daily notes go in `Journal/Daily/` with YYYY-MM-DD format
- All notes must have YAML frontmatter with `created`, `updated`, and `tags` fields

## Linking
- Always use WikiLinks format: `[[Note Name]]`
- Link new concepts to the Main MOC if it exists

## Content Style
- Use `-` for bullet points (not `*`)
- Code blocks must specify language
- Include a "## Summary" section for notes over 500 words
```

The more specific your rules, the better the agent can adapt to your workflow!

## Pricing Plans

This plugin offers two plans: **FREE** and **PRO**. PRO users can access all features directly without needing to configure an OpenAI API key. FREE users can still enjoy the complete functionality by bringing their own OpenAI API key (Bring Your Own Key).

To help you experience our full service, all new users receive a **7-day free PRO trial** upon first login, with no credit card required. Please note that all plugin features require registration and login with an Agentmode account.

## Chat Interface Features

### Context File Selection

- **Button Method**: Click the "🔗" (Add Context) button to open Obsidian's native file picker
- **Drag & Drop Method**: Drag files directly from Obsidian's file explorer into the chat area
- **Mention Method**: Mention a file in the chat by typing `[[` and selecting the file from the file picker


### Chat Modes

- **Agent Mode**: For task execution and automation such as editing notes, drawing diagrams, etc.
- **Ask Mode**: For general questions and inquiries

### Additional Features

- Multiple AI model selection
- Chat history management
- External file upload support (images and PDFs)


## How to Use the Plugin

1. **Login to Agentmode Account**
   - Click the plugin icon (Open chat) in the ribbon
   - If not logged in, you'll be guided through the login process
   - Create an account or login with existing credentials
   - New users get 7-day free PRO trial

2. **Access the Chat Interface**
   - After successful login, the chat interface will appear
   - You can also use command palette: "Open Agent Chat"

3. **Add Context Files (Optional)**
   - Use the "🔗" button to browse and select files
      - Or drag files directly from the file explorer into the chat area
      - Or mention a file in the chat by typing `[[` and selecting the file from the file picker
   - Selected files will be included in your conversation context
   - Even if you don't add context files, the plugin will still work by searching the vault for relevant files

4. **Choose Your Mode**
   - **Agent Mode**: For task execution and automation such as editing notes, drawing diagrams, etc.
   - **Ask Mode**: For questions, research, and general inquiries

5. **Select AI Model**
   - Choose from available models
   - Each model has different strengths and capabilities

6. **Start Chatting**
   - Type your message in the input field
   - Click the "Send" button or press Enter
   - The plugin will process your message and display the response

> Network use: Since the plugin use backend service to process your messages, it cannot be used in offline mode.