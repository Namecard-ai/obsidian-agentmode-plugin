# Agentmode

An AI-powered assistant plugin for Obsidian (https://obsidian.md) that provides intelligent chat functionality with context-aware file integration.

> **Important Notice**: This plugin connects to a proprietary backend API service to process requests and deliver AI-powered features. All chat messages and file contexts are transmitted to our backend servers for processing. For more information about data transmission, privacy practices, and how we protect your information, please refer to our [Security Policy](SECURITY.md).

## Installation

### Manual installation from GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/namecard-ai/obsidian-agentmode-plugin/releases/latest)
2. Navigate to your vault's plugins folder:
   ```
   /path/to/your-vault/.obsidian/plugins/
   ```
3. Create a new folder named `agentmode`
4. Place the downloaded files into the `agentmode` folder
5. Restart Obsidian or reload plugins
6. Go to Settings → Community plugins and enable "Agentmode"

### Using BRAT for beta testing

Install and test the latest development version using [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from the Obsidian community plugins
2. Enable BRAT in Settings → Community plugins
3. Open BRAT settings and select "Add Beta plugin"
4. Paste the repository URL: `https://github.com/namecard-ai/obsidian-agentmode-plugin`
5. Click "Add Plugin" and BRAT will handle the installation
6. Enable Agentmode in Settings → Community plugins

> **Note**: BRAT automatically checks for updates and will notify you when new versions are released.


## Key Features
- **Context-Aware Conversations**: Seamlessly integrate vault files into your chat context
- **Agent Mode**: Execute tasks and automation through AI assistance
- **Vault File Integration**: Advanced drag-and-drop and file picker functionality
- **Upload External Files**: Upload images and PDFs out side of the vault

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