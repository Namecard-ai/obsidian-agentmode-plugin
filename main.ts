import { StrictMode } from 'react';
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ReactView } from './ReactView';
import { ExampleView, VIEW_TYPE_EXAMPLE } from './ExampleView';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Remember to rename these classes and interfaces!

interface HelloWorldPluginSettings {
	mySetting: string;
	openaiApiKey: string;
}

const DEFAULT_SETTINGS: HelloWorldPluginSettings = {
	mySetting: 'default',
	openaiApiKey: ''
}

interface EmbeddingRecord {
	id: string;
	vector: number[];
	content: string;
	file_path: string;
	file_name: string;
	last_modified: string;
	[key: string]: any; // Add index signature for compatibility
}

interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: any[];
	tool_call_id?: string;
	name?: string;
}

export default class HelloWorldPlugin extends Plugin {
	settings: HelloWorldPluginSettings;
	vectorDbPath: string = '';
	// Add debouncing for file processing
	private fileProcessingTimeouts: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_DELAY = 3000; // 3 seconds delay
	private openaiClient: OpenAI | null = null;

	async onload() {
		await this.loadSettings();
		await this.initializeVectorDB();
		this.initializeOpenAI();

		// Listen for note changes and saves
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				// Check if the modified file is a TFile and is a markdown file (note)
				if (file instanceof TFile && file.extension === 'md') {
					console.log(`Note modified: ${file.path}`);
					console.log(`File name: ${file.name}`);
					console.log(`Last modified: ${new Date(file.stat.mtime).toISOString()}`);
					
					// Use debouncing to avoid frequent API calls
					this.debouncedProcessFileForEmbedding(file);
				}
			})
		);

		// Register a new view
		this.registerView(
			VIEW_TYPE_EXAMPLE,
			(leaf) => new ExampleView(leaf, this)
		);

		this.addRibbonIcon('dice', 'Activate example view', () => {
			this.activateExampleView();
		});

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text1');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	initializeOpenAI() {
		if (this.settings.openaiApiKey) {
			this.openaiClient = new OpenAI({
				apiKey: this.settings.openaiApiKey,
				dangerouslyAllowBrowser: true
			});
		}
	}

	async initializeVectorDB() {
		try {
			// Create vector database directory in the vault's .obsidian folder
			this.vectorDbPath = '.obsidian/vectors';
			
			// Ensure the directory exists
			await this.ensureDirectoryExists(this.vectorDbPath);
			
			console.log('Vector database initialized successfully');
		} catch (error) {
			console.error('Error initializing vector database:', error);
			new Notice('Failed to initialize vector database');
		}
	}

	async ensureDirectoryExists(dirPath: string) {
		try {
			// Use Obsidian's vault adapter to create directory
			await this.app.vault.adapter.mkdir(dirPath);
		} catch (error) {
			// Directory might already exist, which is fine
			console.log('Directory creation info:', error);
		}
	}

	// Agent chat completion with streaming and tool use
	async streamAgentChat(
		messages: ChatMessage[], 
		contextFiles: TFile[],
		onChunk: (chunk: string) => void,
		onToolCall: (toolCall: any) => void,
		onComplete: () => void,
		onError: (error: string) => void
	): Promise<void> {
		if (!this.openaiClient) {
			onError('OpenAI API key not configured');
			return;
		}

		try {
			// Get system prompt
			const systemPrompt = this.getSystemPrompt();
			
			// Convert messages to OpenAI format and build conversation
			const chatMessages: ChatCompletionMessageParam[] = [
				{ role: 'system', content: systemPrompt },
				...messages.map(msg => ({
					role: msg.role,
					content: msg.content,
					...(msg.tool_calls && { tool_calls: msg.tool_calls }),
					...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
					...(msg.name && { name: msg.name })
				}) as ChatCompletionMessageParam)
			];

			// Add context files information if any
			if (contextFiles.length > 0) {
				const contextContent = await this.buildContextContent(contextFiles);
				chatMessages.push({
					role: 'user',
					content: `Context from attached files:\n\n${contextContent}`
				});
			}

			// Define available tools in OpenAI format
			const tools = [
				{
					type: 'function' as const,
					function: {
						name: 'vault_search',
						description: 'Perform a semantic search across the vault to find notes or blocks most relevant to the user\'s query.',
						parameters: {
							type: 'object',
							properties: {
								query: {
									type: 'string',
									description: 'The exact search query from the user, reused verbatim unless you have strong reason to rephrase.'
								},
								explanation: {
									type: 'string',
									description: 'One sentence explanation of why this semantic search is necessary for the user\'s task.'
								},
								target_subpaths: {
									type: 'array',
									items: { type: 'string' },
									description: 'Optional list of folders to scope the search.'
								}
							},
							required: ['query', 'explanation']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'read_note',
						description: 'Read the contents of a note or a range of lines within a note.',
						parameters: {
							type: 'object',
							properties: {
								note_path: {
									type: 'string',
									description: 'The relative path to the note within the vault.'
								},
								start_line: {
									type: 'integer',
									description: 'The one-indexed line number to start reading from.'
								},
								end_line: {
									type: 'integer',
									description: 'The one-indexed line number to end reading at (inclusive).'
								},
								read_entire_note: {
									type: 'boolean',
									description: 'Set to true only if full content is needed.'
								},
								explanation: {
									type: 'string',
									description: 'Why this note or section needs to be read for the task.'
								}
							},
							required: ['note_path', 'explanation']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'edit_note',
						description: 'Edit or insert content into an existing note.',
						parameters: {
							type: 'object',
							properties: {
								note_path: {
									type: 'string',
									description: 'The path of the note to modify.'
								},
								instructions: {
									type: 'string',
									description: 'A single sentence describing the intention of the edit.'
								},
								markdown_edit: {
									type: 'string',
									description: 'ONLY the changed lines or content. Use <!-- ... existing content ... --> to indicate unchanged regions.'
								}
							},
							required: ['note_path', 'instructions', 'markdown_edit']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'create_note',
						description: 'Create a new note in the vault.',
						parameters: {
							type: 'object',
							properties: {
								note_path: {
									type: 'string',
									description: 'Path for the new note (e.g., \'zettel/20240608-mycognition.md\').'
								},
								content: {
									type: 'string',
									description: 'Initial Markdown content of the note.'
								},
								explanation: {
									type: 'string',
									description: 'Why this new note is needed for the task.'
								}
							},
							required: ['note_path', 'content', 'explanation']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'list_vault',
						description: 'List files and folders in a given vault path. Use relative paths from vault root, or empty string/\".\" for root directory.',
						parameters: {
							type: 'object',
							properties: {
								vault_path: {
									type: 'string',
									description: 'Relative folder path from vault root to list contents of. Use empty string, ".", or "/" for vault root. Examples: "", "folder1", "folder1/subfolder".'
								},
								explanation: {
									type: 'string',
									description: 'Why the contents of this path need to be explored.'
								}
							},
							required: ['vault_path', 'explanation']
						}
					}
				}
			];

			// Main conversation loop - continue until no more tool calls
			while (true) {
				// Start streaming chat completion
				const stream = await this.openaiClient.chat.completions.create({
					model: 'gpt-4o',
					messages: chatMessages,
					tools: tools,
					stream: true,
					temperature: 0.7
				});

				// Build up the message from streaming chunks
				let currentMessage: any = {};
				
				for await (const chunk of stream) {
					currentMessage = this.messageReducer(currentMessage, chunk);
					
					// Stream content to UI
					const delta = chunk.choices[0]?.delta;
					if (delta?.content) {
						onChunk(delta.content);
					}
					
					// Handle tool call deltas
					if (delta?.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							if (toolCall.function?.name) {
								onToolCall(toolCall);
							}
						}
					}
				}

				// Add the completed assistant message to conversation
				chatMessages.push(currentMessage);

				// If there are no tool calls, we're done
				if (!currentMessage.tool_calls) {
					break;
				}

				// Execute tool calls and add results to conversation
				for (const toolCall of currentMessage.tool_calls) {
					try {
						onChunk(`\n\n*🔧 Using tool: ${toolCall.function.name}*\n`);
						
						const args = JSON.parse(toolCall.function.arguments || '{}');
						
						// Debug: Log tool call input payload
						console.log(`🔧 [TOOL CALL] ${toolCall.function.name}`);
						console.log('📥 Input Payload:', {
							tool_call_id: toolCall.id,
							function_name: toolCall.function.name,
							arguments: args
						});
						
						let result = '';
						
						switch (toolCall.function.name) {
							case 'vault_search':
								result = await this.toolVaultSearch(args);
								break;
							case 'read_note':
								result = await this.toolReadNote(args);
								break;
							case 'edit_note':
								result = await this.toolEditNote(args);
								break;
							case 'create_note':
								result = await this.toolCreateNote(args);
								break;
							case 'list_vault':
								result = await this.toolListVault(args);
								break;
							default:
								result = 'Unknown tool call';
						}
						
						// Debug: Log tool call output payload
						console.log(`✅ [TOOL RESULT] ${toolCall.function.name}`);
						console.log('📤 Output Payload:', {
							tool_call_id: toolCall.id,
							result_length: result.length,
							result_preview: result.slice(0, 200),
							full_result: result
						});
						
						// Add tool result to conversation
						const toolMessage: ChatCompletionMessageParam = {
							tool_call_id: toolCall.id,
							role: 'tool',
							content: result
						};
						
						chatMessages.push(toolMessage);
						onChunk(`*✅ Tool result:* ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}\n\n`);
						
					} catch (error: any) {
						// Debug: Log tool call error
						console.error(`❌ [TOOL ERROR] ${toolCall.function.name}:`, {
							tool_call_id: toolCall.id,
							error_message: error.message,
							error_stack: error.stack,
							full_error: error
						});
						
						// Handle tool execution error
						const errorMessage: ChatCompletionMessageParam = {
							tool_call_id: toolCall.id,
							role: 'tool',
							content: `Error: ${error.message || 'Unknown error'}`
						};
						
						chatMessages.push(errorMessage);
						onChunk(`*❌ Tool error:* ${error.message || 'Unknown error'}\n\n`);
					}
				}
				
				// Continue the loop for next round of chat completion
			}

			onComplete();

		} catch (error: any) {
			console.error('Error in agent chat:', error);
			onError(error.message || 'Unknown error occurred');
		}
	}

	// Message reducer to build up messages from streaming chunks
	private messageReducer(previous: any, item: any): any {
		const reduce = (acc: any, delta: any): any => {
			acc = { ...acc };
			for (const [key, value] of Object.entries(delta)) {
				if (acc[key] === undefined || acc[key] === null) {
					acc[key] = value;
					// Remove index from tool calls array items
					if (Array.isArray(acc[key])) {
						for (const arr of acc[key]) {
							delete arr.index;
						}
					}
				} else if (typeof acc[key] === 'string' && typeof value === 'string') {
					acc[key] += value;
				} else if (typeof acc[key] === 'number' && typeof value === 'number') {
					acc[key] = value;
				} else if (Array.isArray(acc[key]) && Array.isArray(value)) {
					const accArray = acc[key];
					for (let i = 0; i < value.length; i++) {
						const { index, ...chunkTool } = value[i];
						if (index - accArray.length > 1) {
							throw new Error(
								`Error: An array has an empty value when tool_calls are constructed. tool_calls: ${accArray}; tool: ${value}`,
							);
						}
						accArray[index] = reduce(accArray[index], chunkTool);
					}
				} else if (typeof acc[key] === 'object' && typeof value === 'object') {
					acc[key] = reduce(acc[key], value);
				}
			}
			return acc;
		};

		const choice = item.choices?.[0];
		if (!choice) {
			// chunk contains information about usage and token counts
			return previous;
		}
		return reduce(previous, choice.delta);
	}

	private getSystemPrompt(): string {
		// Get vault path correctly - try multiple methods
		let vaultPath = '/Users/vault'; // fallback
		
		try {
			// Method 1: Try to get the actual vault path from adapter
			if (this.app.vault.adapter && (this.app.vault.adapter as any).fs && (this.app.vault.adapter as any).fs.getBasePath) {
				vaultPath = (this.app.vault.adapter as any).fs.getBasePath();
			}
			// Method 2: Try to get from vault adapter basePath property
			else if (this.app.vault.adapter && (this.app.vault.adapter as any).basePath) {
				vaultPath = (this.app.vault.adapter as any).basePath;
			}
			// Method 3: Try using the app's vault configDir
			else if (this.app.vault.configDir) {
				// configDir is usually .obsidian, so parent is vault path
				const configPath = this.app.vault.configDir;
				if (typeof configPath === 'string') {
					vaultPath = configPath.replace('/.obsidian', '');
				}
			}
			// Method 4: Use vault name (fallback)
			else if (this.app.vault.getName) {
				const vaultName = this.app.vault.getName();
				vaultPath = `Vault: ${vaultName}`;
			}
			
			// Additional debugging
			console.log('🔍 [SYSTEM] Vault adapter properties:', Object.keys(this.app.vault.adapter || {}));
			console.log('🔍 [SYSTEM] Vault getName():', this.app.vault.getName?.());
			console.log('🔍 [SYSTEM] Vault configDir:', this.app.vault.configDir);
		} catch (error) {
			console.warn('🔍 [SYSTEM] Could not determine vault path, using fallback:', error);
		}
		
		console.log('🔍 [SYSTEM] Vault path:', vaultPath);
		console.log('🔍 [SYSTEM] Vault path type:', typeof vaultPath);
		const osInfo = navigator.platform;
		
		return `You are a powerful agentic AI note-taking assistant, powered by LLM model. You operate exclusively within Obsidian, the world's best knowledge management and PKM tool.

You are collaborating with a USER to help them organize, write, and enhance their notes.
The task may involve summarizing content, refactoring or restructuring notes, linking concepts together, formatting with Markdown, performing semantic searches across notes, or answering specific questions based on the content.
Each time the USER sends a message, we may automatically attach information about their current context, such as the active note, cursor position, open backlinks, linked/unlinked mentions, and edit history within the vault.
This context may or may not be relevant — you must decide how it impacts the task.
Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.

<tool_calling>
You have tools at your disposal to help manage and reason over the user's vault. Follow these rules:
1. ALWAYS follow the tool schema exactly, and provide all required parameters.
2. Do not call tools that are not explicitly available to you.
3. **NEVER mention tool names in your conversation with the USER.** For example, instead of saying "I'll use the link_note tool to add a link", just say "I'll add a link between your notes".
4. Only use tools when needed. If the task can be handled directly, just respond without tools.
5. When using a tool, explain to the USER why it's needed and how it supports the task.
</tool_calling>

<editing_notes>
When making changes to a note, DO NOT output the entire Markdown content unless explicitly requested. Instead, use the note editing tools.
Only make one note edit per turn unless the USER gives you a batch instruction.
Ensure your edits respect the following:
1. Do not overwrite user content unless clearly requested or safe to do so.
2. Preserve YAML frontmatter, metadata, and tags unless explicitly directed to change them.
3. Use clear section headers, semantic structure, and proper Markdown formatting.
4. When inserting content (e.g. summaries, backlinks, tables), place it in the correct context — don't guess.
5. When refactoring or reorganizing content, preserve original meaning and ordering unless improved otherwise.
6. Fix formatting or syntax issues if they are obvious, but do not make stylistic assumptions without instruction.
</editing_notes>

<searching_and_reading>
You can search across the vault or read from specific notes. Follow these principles:
1. Prefer semantic search over raw grep/text search when possible.
2. When reading notes, retrieve the full content only if needed. Use sections or block references when appropriate.
3. Avoid redundant reads — once you have enough context to answer or make a change, proceed without further searching.
</searching_and_reading>

You MUST use the following format when citing note sections:
\`\`\`
startLine:endLine:note_path
// ... existing content ...
\`\`\`
This is the ONLY acceptable format for note citations.

<user_info>
The USER is working in Obsidian with Markdown files under a single vault directory. 
The user's OS version is: \`${osInfo}\`
The absolute path to the vault is: \`${vaultPath}\`
</user_info>

Answer the USER's request using available context and tools. If a required parameter is missing, ask for it. Otherwise, proceed with the tool call or provide the response directly.
If citing notes or inserting content, ensure Markdown compatibility and coherence with existing structure.`;
	}

	// Tool implementations
	private async toolVaultSearch(args: { query: string; explanation: string; target_subpaths?: string[] }) {
		console.log('🔍 [TOOL] vault_search starting with args:', args);
		
		try {
			// Use existing vector search functionality
			const embedding = await this.getOpenAIEmbedding(args.query);
			if (!embedding) {
				console.log('🔍 [TOOL] vault_search: Failed to generate embedding');
				return 'Failed to generate embedding for search query.';
			}

			console.log('🔍 [TOOL] vault_search: Generated embedding, length:', embedding.length);
			const similarFiles = await this.searchSimilarFiles(embedding, 5);
			
			console.log('🔍 [TOOL] vault_search: Found similar files:', similarFiles.length);
			
			if (similarFiles.length === 0) {
				console.log('🔍 [TOOL] vault_search: No relevant notes found');
				return 'No relevant notes found for your query.';
			}

			const results = similarFiles.map(file => ({
				path: file.file_path,
				name: file.file_name,
				relevance: 'High' // You could calculate actual similarity scores here
			}));

			const resultText = `Found ${results.length} relevant notes:\n${results.map(r => `- ${r.name} (${r.path})`).join('\n')}`;
			console.log('🔍 [TOOL] vault_search: Returning result:', resultText);
			
			return resultText;
		} catch (error: any) {
			console.error('🔍 [TOOL] vault_search error:', error);
			return `Error searching vault: ${error.message}`;
		}
	}

	private async toolReadNote(args: { note_path: string; start_line?: number; end_line?: number; read_entire_note?: boolean; explanation: string }) {
		console.log('📖 [TOOL] read_note starting with args:', args);
		
		try {
			const file = this.app.vault.getAbstractFileByPath(args.note_path) as TFile;
			if (!file) {
				console.log('📖 [TOOL] read_note: Note not found:', args.note_path);
				return `Note not found: ${args.note_path}`;
			}

			console.log('📖 [TOOL] read_note: Found file, reading content...');
			const content = await this.app.vault.read(file);
			
			if (args.read_entire_note || (!args.start_line && !args.end_line)) {
				console.log('📖 [TOOL] read_note: Returning entire note, length:', content.length);
				return content;
			}

			const lines = content.split('\n');
			const startIdx = (args.start_line || 1) - 1;
			const endIdx = (args.end_line || lines.length) - 1;
			
			console.log(`📖 [TOOL] read_note: Returning lines ${startIdx + 1} to ${endIdx + 1} of ${lines.length} total lines`);
			
			const result = lines.slice(startIdx, endIdx + 1).join('\n');
			console.log('📖 [TOOL] read_note: Result length:', result.length);
			
			return result;
		} catch (error: any) {
			console.error('📖 [TOOL] read_note error:', error);
			return `Error reading note: ${error.message}`;
		}
	}

	private async toolEditNote(args: { note_path: string; instructions: string; markdown_edit: string }) {
		try {
			const file = this.app.vault.getAbstractFileByPath(args.note_path) as TFile;
			if (!file) {
				return `Note not found: ${args.note_path}`;
			}

			// For now, append the edit to the end of the file
			// In a more sophisticated implementation, you'd parse the markdown_edit 
			// and apply it at the appropriate location
			const existingContent = await this.app.vault.read(file);
			const newContent = existingContent + '\n\n' + args.markdown_edit;
			
			await this.app.vault.modify(file, newContent);
			return `Successfully edited note: ${args.note_path}`;
		} catch (error: any) {
			return `Error editing note: ${error.message}`;
		}
	}

	private async toolCreateNote(args: { note_path: string; content: string; explanation: string }) {
		try {
			await this.app.vault.create(args.note_path, args.content);
			return `Successfully created note: ${args.note_path}`;
		} catch (error: any) {
			return `Error creating note: ${error.message}`;
		}
	}

	private async toolListVault(args: { vault_path: string; explanation: string }) {
		console.log('📂 [TOOL] list_vault starting with args:', args);
		
		try {
			// Convert absolute path to relative path if needed
			let relativePath = args.vault_path;
			
			// If it's an absolute path, try to convert it to relative
			if (relativePath.startsWith('/')) {
				console.log('📂 [TOOL] list_vault: Absolute path detected, attempting conversion');
				
				// Try to extract vault name and make relative path
				const pathParts = relativePath.split('/');
				const vaultName = this.app.vault.getName();
				const vaultIndex = pathParts.findIndex(part => part === vaultName);
				
				if (vaultIndex !== -1 && vaultIndex < pathParts.length - 1) {
					// Found vault name in path, use everything after it
					relativePath = pathParts.slice(vaultIndex + 1).join('/');
					console.log('📂 [TOOL] list_vault: Converted to relative path:', relativePath);
				} else {
					// Can't convert, assume root
					relativePath = '';
					console.log('📂 [TOOL] list_vault: Cannot convert absolute path, using root');
				}
			}
			
			// Handle root directory cases
			if (!relativePath || relativePath === '/' || relativePath === '.') {
				console.log('📂 [TOOL] list_vault: Listing root vault directory');
				const files = this.app.vault.getAllLoadedFiles();
				
				// Filter to only show top-level items
				const topLevelItems = files.filter(file => {
					const pathDepth = file.path.split('/').length;
					return pathDepth === 1; // Only files/folders directly in root
				});
				
				const result = topLevelItems.map(f => {
					if (f.path.endsWith('.md')) {
						return `📄 ${f.path}`;
					} else {
						return `📁 ${f.path}`;
					}
				}).slice(0, 20).join('\n');
				
				console.log('📂 [TOOL] list_vault: Root vault files count:', topLevelItems.length, 'returning first 20');
				return result || 'No files found in vault root';
			}
			
			// Check if the relative path exists as a folder
			const folder = this.app.vault.getAbstractFileByPath(relativePath);
			console.log('📂 [TOOL] list_vault: Checking folder:', relativePath, 'exists:', !!folder);
			
			if (folder && (folder as any).children) {
				// It's a folder with children
				const children = (folder as any).children;
				console.log('📂 [TOOL] list_vault: Found folder with', children.length, 'children');
				
				const listing = children.map((child: any) => {
					if (child.children) {
						return `📁 ${child.name}/`;
					} else {
						return `📄 ${child.name}`;
					}
				});
				
				const result = listing.slice(0, 20).join('\n');
				console.log('📂 [TOOL] list_vault: Returning folder contents (first 20 items)');
				return result || 'Empty folder';
			}
			
			// Try using adapter.list directly with the path
			console.log('📂 [TOOL] list_vault: Trying adapter.list with path:', relativePath);
			const contents = await this.app.vault.adapter.list(relativePath);
			
			console.log('📂 [TOOL] list_vault: Found', contents.folders.length, 'folders and', contents.files.length, 'files');
			
			const listing = [
				...contents.folders.map(f => `📁 ${f}/`),
				...contents.files.map(f => `📄 ${f}`)
			];
			
			const result = listing.slice(0, 20).join('\n');
			console.log('📂 [TOOL] list_vault: Returning adapter result (first 20 items)');
			return result || 'Empty directory';
			
		} catch (error: any) {
			console.error('📂 [TOOL] list_vault error:', error);
			
			// Fallback: list all files in vault
			console.log('📂 [TOOL] list_vault: Error occurred, falling back to root listing');
			try {
				const files = this.app.vault.getAllLoadedFiles();
				const result = files.map(f => f.path).slice(0, 20).join('\n');
				return result || 'No files found in vault';
			} catch (fallbackError: any) {
				return `Error listing vault: ${error.message}`;
			}
		}
	}

	private async buildContextContent(contextFiles: TFile[]): Promise<string> {
		const contexts = [];
		for (const file of contextFiles) {
			try {
				const content = await this.app.vault.read(file);
				contexts.push(`=== ${file.name} ===\n${content}`);
			} catch (error: any) {
				contexts.push(`=== ${file.name} ===\n[Error reading file: ${error.message}]`);
			}
		}
		return contexts.join('\n\n');
	}

	async processFileForEmbedding(file: TFile) {
		try {
			if (!this.settings.openaiApiKey) {
				console.warn('OpenAI API key not configured');
				return;
			}

			// Read file content
			const content = await this.app.vault.read(file);
			
			// Create content for embedding (include metadata in the text)
			const embeddingContent = `File: ${file.name}\nPath: ${file.path}\nContent:\n${content}`;
			
			// Get embedding from OpenAI
			const embedding = await this.getOpenAIEmbedding(embeddingContent);
			
			if (embedding) {
				// Create record for vector storage
				const record: EmbeddingRecord = {
					id: file.path, // Use file path as unique ID
					vector: embedding,
					content: content,
					file_path: file.path,
					file_name: file.name,
					last_modified: new Date(file.stat.mtime).toISOString()
				};

				// Save the embedding to a JSON file
				await this.saveEmbedding(record);
				
				console.log(`Successfully embedded and stored: ${file.name}`);
				new Notice(`Vector embedding saved for: ${file.name}`);
			}
		} catch (error) {
			console.error('Error processing file for embedding:', error);
			new Notice(`Failed to process embedding for: ${file.name}`);
		}
	}

	async saveEmbedding(record: EmbeddingRecord) {
		try {
			// Create a safe filename from the file path
			const safeFilename = record.file_path.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
			const embeddingFilePath = this.vectorDbPath + '/' + safeFilename;
			
			// Save the embedding record as JSON
			const jsonData = JSON.stringify(record, null, 2);
			await this.app.vault.adapter.write(embeddingFilePath, jsonData);
			
		} catch (error) {
			console.error('Error saving embedding:', error);
			throw error;
		}
	}

	async loadAllEmbeddings(): Promise<EmbeddingRecord[]> {
		try {
			const embeddings: EmbeddingRecord[] = [];
			
			// List all JSON files in the vectors directory
			const files = await this.app.vault.adapter.list(this.vectorDbPath);
			
			for (const file of files.files) {
				if (file.endsWith('.json')) {
					try {
						const content = await this.app.vault.adapter.read(file);
						const record: EmbeddingRecord = JSON.parse(content);
						embeddings.push(record);
					} catch (error) {
						console.error(`Error loading embedding from ${file}:`, error);
					}
				}
			}
			
			return embeddings;
		} catch (error) {
			console.error('Error loading embeddings:', error);
			return [];
		}
	}

	// Helper method to perform vector similarity search
	cosineSimilarity(vecA: number[], vecB: number[]): number {
		const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
		const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
		const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
		return dotProduct / (magnitudeA * magnitudeB);
	}

	async searchSimilarFiles(queryEmbedding: number[], topK: number = 5): Promise<EmbeddingRecord[]> {
		const allEmbeddings = await this.loadAllEmbeddings();
		
		// Calculate similarities and sort
		const similarities = allEmbeddings.map(record => ({
			record,
			similarity: this.cosineSimilarity(queryEmbedding, record.vector)
		}));
		
		// Sort by similarity (highest first) and return top K
		return similarities
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, topK)
			.map(item => item.record);
	}

	async getOpenAIEmbedding(text: string): Promise<number[] | null> {
		try {
			const response = await fetch('https://api.openai.com/v1/embeddings', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.openaiApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'text-embedding-3-small',
					input: text,
				}),
			});

			if (!response.ok) {
				throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			return data.data[0].embedding;
		} catch (error) {
			console.error('Error getting OpenAI embedding:', error);
			return null;
		}
	}

	onunload() {
		// Clear all pending timeouts to prevent memory leaks
		this.fileProcessingTimeouts.forEach((timeout) => {
			clearTimeout(timeout);
		});
		this.fileProcessingTimeouts.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Re-initialize OpenAI client when settings are loaded
		this.initializeOpenAI();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-initialize OpenAI client when settings are saved
		this.initializeOpenAI();
	}

	async activateExampleView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_EXAMPLE, active: true });
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	// Add debouncing for file processing
	private debouncedProcessFileForEmbedding(file: TFile) {
		const fileKey = file.path;
		if (this.fileProcessingTimeouts.has(fileKey)) {
			clearTimeout(this.fileProcessingTimeouts.get(fileKey));
		}
		this.fileProcessingTimeouts.set(fileKey, setTimeout(() => {
			this.processFileForEmbedding(file);
			this.fileProcessingTimeouts.delete(fileKey);
		}, this.DEBOUNCE_DELAY));
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');

	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: HelloWorldPlugin;

	constructor(app: App, plugin: HelloWorldPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc('Enter your OpenAI API key for AI features')
			.addText(text => text
				.setPlaceholder('sk-...')
				.setValue(this.plugin.settings.openaiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openaiApiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
