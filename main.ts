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

// New interfaces for precise line-by-line editing
interface EditOperation {
	operation: 'insert' | 'delete' | 'replace';
	start_line: number;      // 1-indexed line number
	end_line?: number;       // For delete/replace operations
	content?: string;        // For insert/replace operations
	description: string;     // Description of this edit operation
}

interface DiffLine {
	type: 'unchanged' | 'deleted' | 'inserted';
	line_number: number;     // Original line number for context
	content: string;
}

// Interface for pending edit confirmation
interface PendingEditConfirmation {
	id: string;
	note_path: string;
	instructions: string;
	edits: EditOperation[];
	originalContent: string;
	modifiedContent: string;
	diff: DiffLine[];
	toolCallId: string;
	timestamp: Date;
}

// Interface for edit confirmation callback
interface EditConfirmationCallbacks {
	onAccept: () => void;
	onReject: (reason?: string) => void;
}

// Interface for pending create note confirmation
interface PendingCreateNoteConfirmation {
	id: string;
	note_path: string;
	content: string;
	explanation: string;
	toolCallId: string;
	timestamp: Date;
}

// Interface for create note confirmation callback
interface CreateNoteConfirmationCallbacks {
	onAccept: () => void;
	onReject: (reason?: string) => void;
}

export default class HelloWorldPlugin extends Plugin {
	settings: HelloWorldPluginSettings;
	vectorDbPath: string = '';
	// Add debouncing for file processing
	private fileProcessingTimeouts: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_DELAY = 3000; // 3 seconds delay
	private openaiClient: OpenAI | null = null;
	
	// Edit confirmation state
	private pendingEditConfirmation: PendingEditConfirmation | null = null;
	private editConfirmationCallbacks: EditConfirmationCallbacks | null = null;
	
	// Create note confirmation state
	private pendingCreateNoteConfirmation: PendingCreateNoteConfirmation | null = null;
	private createNoteConfirmationCallbacks: CreateNoteConfirmationCallbacks | null = null;
	
	// Event emitter for UI updates
	private editConfirmationListeners: ((confirmation: PendingEditConfirmation | null) => void)[] = [];
	private createNoteConfirmationListeners: ((confirmation: PendingCreateNoteConfirmation | null) => void)[] = [];

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
			// Get system prompt with context files
			const systemPrompt = this.getSystemPrompt(contextFiles);
			
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
						description: 'Edit an existing note with precise line-by-line operations. Multiple non-overlapping edit operations can be performed in a single call. Edit operations are applied in reverse order (highest line numbers first) to maintain line number accuracy.',
						parameters: {
							type: 'object',
							properties: {
								note_path: {
									type: 'string',
									description: 'The path of the note to modify.'
								},
								instructions: {
									type: 'string',
									description: 'Overall description of what this edit aims to accomplish.'
								},
								edits: {
									type: 'array',
									description: 'Array of edit operations to perform. Operations must not overlap (no two operations can affect the same line numbers). The system will validate and reject overlapping operations.',
									items: {
										type: 'object',
										properties: {
											operation: {
												type: 'string',
												enum: ['insert', 'delete', 'replace'],
												description: 'Type of operation: insert (add new lines), delete (remove lines), replace (replace existing lines with new content)'
											},
											start_line: {
												type: 'integer',
												minimum: 1,
												description: 'Starting line number (1-indexed). For insert: line number after which to insert. For delete/replace: first line to affect.'
											},
											end_line: {
												type: 'integer',
												minimum: 1,
												description: 'Ending line number (1-indexed), inclusive. Required for delete and replace operations. Must be >= start_line.'
											},
											content: {
												type: 'string',
												description: 'New content to insert or replace with. Required for insert and replace operations. For multiple lines, use \\n to separate lines.'
											},
											description: {
												type: 'string',
												description: 'Brief description of what this specific edit operation does.'
											}
										},
										required: ['operation', 'start_line', 'description']
									}
								}
							},
							required: ['note_path', 'instructions', 'edits']
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

	private getSystemPrompt(contextFiles?: TFile[]): string {
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
		
		// Build context files section if any are provided
		let contextFilesSection = '';
		if (contextFiles && contextFiles.length > 0) {
			const contextFilesList = contextFiles.map(file => {
				const lastModified = new Date(file.stat.mtime).toISOString();
				return `- ${file.path} (${file.name}) - Last modified: ${lastModified}`;
			}).join('\n');
			
			contextFilesSection = `

<context_files>
The user has specifically selected the following files as context for this conversation:
${contextFilesList}

These files represent the user's current focus and are most relevant to their immediate needs. ALWAYS prioritize examining and referencing these files when responding to the user's queries. When the user asks questions or requests actions, first consider how these context files relate to their request and use them as your primary source of information.
</context_files>`;
		}
		
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

IMPORTANT: Both edit_note and create_note tools require user confirmation before applying changes.

For edit_note:
- The system will show the user a detailed preview of the proposed changes
- The user can either accept or reject the edit
- If rejected, the user may provide a reason for the rejection
- If an edit is rejected, DO NOT automatically try the same edit again
- Instead, ask the user what they would prefer or how you should modify the approach
- Use the rejection feedback to better understand the user's preferences for future edits

For create_note:
- The system will show the user a preview of the note content and path before creation
- The user can either accept or reject the note creation
- If rejected, the user may provide a reason for the rejection
- If a note creation is rejected, DO NOT automatically try to create the same note again
- Instead, ask the user what they would prefer for the note path, content, or approach
- Use the rejection feedback to better understand the user's preferences for future note creations
</editing_notes>

<searching_and_reading>
You can search across the vault or read from specific notes. Follow these principles:
1. Prefer semantic search over raw grep/text search when possible.
2. When reading notes, retrieve the full content only if needed. Use sections or block references when appropriate.
3. Avoid redundant reads — once you have enough context to answer or make a change, proceed without further searching.
</searching_and_reading>

<handling_rejections>
When a user rejects an edit or note creation, respond appropriately:

For EDIT rejections:
1. **Acknowledge the rejection gracefully** - Thank the user for their feedback
2. **Ask clarifying questions** to understand their concerns:
   - "What aspect of the proposed changes didn't work for you?"
   - "Would you prefer a different approach to organizing this content?"
   - "Are there specific parts you'd like me to focus on or avoid?"
3. **Offer alternatives** based on their feedback
4. **Learn from the rejection** - Use the feedback to improve future suggestions
5. **Never repeat the same rejected edit** without significant modifications

For CREATE NOTE rejections:
1. **Acknowledge the rejection gracefully** - Thank the user for their feedback
2. **Ask clarifying questions** to understand their concerns:
   - "What didn't work about the proposed note path or content?"
   - "Would you prefer a different location or structure for this note?"
   - "Should I adjust the content, format, or focus differently?"
3. **Offer alternatives** based on their feedback:
   - Different file paths or naming conventions
   - Alternative content structures or formats
   - Different approaches to organizing the information
4. **Learn from the rejection** - Use the feedback to improve future note creation suggestions
5. **Never repeat the same rejected note creation** without significant modifications

Example responses:
- "I understand that approach didn't work for you. Could you help me understand what you'd prefer instead?"
- "Thanks for the feedback! Would you like me to try a different location or content structure?"
- "I see that wasn't quite right. What would be the most helpful way to create or organize this information?"
</handling_rejections>

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
</user_info>${contextFilesSection}

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

	private async toolEditNote(args: { note_path: string; instructions: string; edits: EditOperation[] }): Promise<string> {
		try {
			const file = this.app.vault.getAbstractFileByPath(args.note_path) as TFile;
			if (!file) {
				return `Note not found: ${args.note_path}`;
			}

			// Read the current file content
			const originalContent = await this.app.vault.read(file);
			const originalLines = originalContent.split('\n');

			// Validate edits for overlaps and constraints
			const validationResult = this.validateEditOperations(args.edits, originalLines.length);
			if (!validationResult.valid) {
				return `Error: ${validationResult.error}`;
			}

			// Apply edits in reverse order (highest line numbers first)
			const sortedEdits = [...args.edits].sort((a, b) => b.start_line - a.start_line);
			let modifiedLines = [...originalLines];

			for (const edit of sortedEdits) {
				modifiedLines = this.applyEditOperation(modifiedLines, edit);
			}

			const modifiedContent = modifiedLines.join('\n');
			
			// Generate diff for preview
			const diff = this.generateDiff(originalLines, modifiedLines);
			
			// Return a Promise that will be resolved when user confirms or rejects
			return new Promise<string>((resolve, reject) => {
				// Create pending edit confirmation
				const confirmationId = Math.random().toString(36).substr(2, 9);
				const pendingConfirmation: PendingEditConfirmation = {
					id: confirmationId,
					note_path: args.note_path,
					instructions: args.instructions,
					edits: args.edits,
					originalContent: originalContent,
					modifiedContent: modifiedContent,
					diff: diff,
					toolCallId: confirmationId, // This would be set by caller
					timestamp: new Date()
				};

				// Set up callbacks for user decision
				this.editConfirmationCallbacks = {
					onAccept: async () => {
						try {
							// Apply the changes
							await this.app.vault.modify(file, modifiedContent);
							const diffPreview = this.formatDiffForDisplay(diff);
							resolve(`✅ Edit confirmed and applied to: ${args.note_path}\n\nChanges:\n${diffPreview}`);
						} catch (error: any) {
							reject(new Error(`Failed to apply changes: ${error.message}`));
						}
					},
					onReject: (reason?: string) => {
						const message = reason 
							? `❌ Edit rejected by user: ${reason}`
							: `❌ Edit rejected by user. No changes were made to: ${args.note_path}`;
						resolve(message);
					}
				};

				// Store the pending confirmation and notify listeners
				this.pendingEditConfirmation = pendingConfirmation;
				this.notifyEditConfirmationListeners();
			});

		} catch (error: any) {
			return `Error preparing edit: ${error.message}`;
		}
	}

	// Validate edit operations for overlaps and constraints
	private validateEditOperations(edits: EditOperation[], totalLines: number): { valid: boolean; error?: string } {
		// Check for required fields and constraints
		for (const edit of edits) {
			// Validate operation type
			if (!['insert', 'delete', 'replace'].includes(edit.operation)) {
				return { valid: false, error: `Invalid operation type: ${edit.operation}` };
			}

			// Validate line numbers
			if (edit.start_line < 1) {
				return { valid: false, error: `Invalid start_line: ${edit.start_line}. Line numbers must be >= 1.` };
			}

			// For delete and replace operations, validate end_line
			if (edit.operation === 'delete' || edit.operation === 'replace') {
				if (!edit.end_line) {
					return { valid: false, error: `end_line is required for ${edit.operation} operations.` };
				}
				if (edit.end_line < edit.start_line) {
					return { valid: false, error: `end_line (${edit.end_line}) must be >= start_line (${edit.start_line}).` };
				}
				if (edit.end_line > totalLines) {
					return { valid: false, error: `end_line (${edit.end_line}) exceeds file length (${totalLines} lines).` };
				}
			}

			// For insert and replace operations, validate content
			if ((edit.operation === 'insert' || edit.operation === 'replace') && !edit.content) {
				return { valid: false, error: `content is required for ${edit.operation} operations.` };
			}

			// For insert operations, validate start_line doesn't exceed file length + 1
			if (edit.operation === 'insert' && edit.start_line > totalLines + 1) {
				return { valid: false, error: `Cannot insert after line ${edit.start_line}. File only has ${totalLines} lines.` };
			}
		}

		// Check for overlapping edits
		const ranges: Array<{ start: number; end: number }> = [];
		for (const edit of edits) {
			let start: number, end: number;
			
			if (edit.operation === 'insert') {
				// Insert operations affect the line after start_line
				start = edit.start_line + 1;
				end = edit.start_line + 1;
			} else if (edit.operation === 'delete') {
				start = edit.start_line;
				end = edit.end_line!;
			} else { // replace
				start = edit.start_line;
				end = edit.end_line!;
			}

			// Check for overlaps with existing ranges
			for (const range of ranges) {
				if (!(end < range.start || start > range.end)) {
					return { valid: false, error: `Edit operations overlap: lines ${start}-${end} conflicts with lines ${range.start}-${range.end}.` };
				}
			}

			ranges.push({ start, end });
		}

		return { valid: true };
	}

	// Apply a single edit operation to the lines array
	private applyEditOperation(lines: string[], edit: EditOperation): string[] {
		const result = [...lines];

		switch (edit.operation) {
			case 'insert': {
				const newLines = edit.content!.split('\n');
				result.splice(edit.start_line, 0, ...newLines);
				break;
			}
			case 'delete': {
				const deleteCount = edit.end_line! - edit.start_line + 1;
				result.splice(edit.start_line - 1, deleteCount);
				break;
			}
			case 'replace': {
				const deleteCount = edit.end_line! - edit.start_line + 1;
				const newLines = edit.content!.split('\n');
				result.splice(edit.start_line - 1, deleteCount, ...newLines);
				break;
			}
		}

		return result;
	}

	// Generate diff between original and modified lines
	private generateDiff(originalLines: string[], modifiedLines: string[]): DiffLine[] {
		const diff: DiffLine[] = [];
		let originalIndex = 0;
		let modifiedIndex = 0;

		// Simple diff algorithm - this could be enhanced with proper LCS algorithm
		while (originalIndex < originalLines.length || modifiedIndex < modifiedLines.length) {
			if (originalIndex >= originalLines.length) {
				// Only modified lines left
				diff.push({
					type: 'inserted',
					line_number: originalIndex + 1,
					content: modifiedLines[modifiedIndex]
				});
				modifiedIndex++;
			} else if (modifiedIndex >= modifiedLines.length) {
				// Only original lines left
				diff.push({
					type: 'deleted',
					line_number: originalIndex + 1,
					content: originalLines[originalIndex]
				});
				originalIndex++;
			} else if (originalLines[originalIndex] === modifiedLines[modifiedIndex]) {
				// Lines are the same
				diff.push({
					type: 'unchanged',
					line_number: originalIndex + 1,
					content: originalLines[originalIndex]
				});
				originalIndex++;
				modifiedIndex++;
			} else {
				// Lines are different - mark as deleted and inserted
				diff.push({
					type: 'deleted',
					line_number: originalIndex + 1,
					content: originalLines[originalIndex]
				});
				diff.push({
					type: 'inserted',
					line_number: originalIndex + 1,
					content: modifiedLines[modifiedIndex]
				});
				originalIndex++;
				modifiedIndex++;
			}
		}

		return diff;
	}

	// Format diff for display with context
	private formatDiffForDisplay(diff: DiffLine[]): string {
		const lines: string[] = [];
		const contextLines = 2; // Show 2 lines of context around changes
		
		// Find lines with changes
		const changedIndices = new Set<number>();
		diff.forEach((line, index) => {
			if (line.type !== 'unchanged') {
				// Add context around changes
				for (let i = Math.max(0, index - contextLines); i <= Math.min(diff.length - 1, index + contextLines); i++) {
					changedIndices.add(i);
				}
			}
		});
		
		let lastShownIndex = -1;
		
		for (let i = 0; i < diff.length; i++) {
			if (changedIndices.has(i)) {
				// Show separator if there's a gap
				if (lastShownIndex >= 0 && i > lastShownIndex + 1) {
					lines.push('...');
				}
				
				const line = diff[i];
				switch (line.type) {
					case 'deleted':
						lines.push(`- ${line.line_number}: ${line.content}`);
						break;
					case 'inserted':
						lines.push(`+ ${line.line_number}: ${line.content}`);
						break;
					case 'unchanged':
						lines.push(`  ${line.line_number}: ${line.content}`);
						break;
				}
				lastShownIndex = i;
			}
		}

		return lines.join('\n');
	}

	private async toolCreateNote(args: { note_path: string; content: string; explanation: string }): Promise<string> {
		try {
			// Check if the file already exists
			const existingFile = this.app.vault.getAbstractFileByPath(args.note_path);
			if (existingFile) {
				return `Error: A file already exists at path: ${args.note_path}`;
			}

			// Validate the file path
			if (!args.note_path.endsWith('.md')) {
				return `Error: Note path must end with .md extension: ${args.note_path}`;
			}

			// Return a Promise that will be resolved when user confirms or rejects
			return new Promise<string>((resolve, reject) => {
				// Create pending create note confirmation
				const confirmationId = Math.random().toString(36).substr(2, 9);
				const pendingConfirmation: PendingCreateNoteConfirmation = {
					id: confirmationId,
					note_path: args.note_path,
					content: args.content,
					explanation: args.explanation,
					toolCallId: confirmationId, // This would be set by caller
					timestamp: new Date()
				};

				// Set up callbacks for user decision
				this.createNoteConfirmationCallbacks = {
					onAccept: async () => {
						try {
							// Extract directory path from note_path
							const pathParts = args.note_path.split('/');
							if (pathParts.length > 1) {
								// Remove the filename to get the directory path
								const directoryPath = pathParts.slice(0, -1).join('/');
								
								// Check if directory exists, if not create it
								try {
									const dirExists = await this.app.vault.adapter.exists(directoryPath);
									if (!dirExists) {
										console.log(`Creating directory: ${directoryPath}`);
										await this.app.vault.adapter.mkdir(directoryPath);
									}
								} catch (dirError: any) {
									console.log(`Directory creation attempt for ${directoryPath}:`, dirError);
									// Directory might already exist or be created by another process
								}
							}
							
							// Create the note
							await this.app.vault.create(args.note_path, args.content);
							resolve(`✅ Note creation confirmed and completed: ${args.note_path}`);
						} catch (error: any) {
							reject(new Error(`Failed to create note: ${error.message}`));
						}
					},
					onReject: (reason?: string) => {
						const message = reason 
							? `❌ Note creation rejected by user: ${reason}`
							: `❌ Note creation rejected by user. No note was created at: ${args.note_path}`;
						resolve(message);
					}
				};

				// Store the pending confirmation and notify listeners
				this.pendingCreateNoteConfirmation = pendingConfirmation;
				this.notifyCreateNoteConfirmationListeners();
			});

		} catch (error: any) {
			return `Error preparing note creation: ${error.message}`;
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

	// Edit confirmation management methods
	addEditConfirmationListener(listener: (confirmation: PendingEditConfirmation | null) => void) {
		this.editConfirmationListeners.push(listener);
	}

	removeEditConfirmationListener(listener: (confirmation: PendingEditConfirmation | null) => void) {
		const index = this.editConfirmationListeners.indexOf(listener);
		if (index > -1) {
			this.editConfirmationListeners.splice(index, 1);
		}
	}

	private notifyEditConfirmationListeners() {
		this.editConfirmationListeners.forEach(listener => {
			listener(this.pendingEditConfirmation);
		});
	}

	// Accept the pending edit confirmation
	acceptEditConfirmation() {
		if (this.editConfirmationCallbacks) {
			this.editConfirmationCallbacks.onAccept();
			this.pendingEditConfirmation = null;
			this.editConfirmationCallbacks = null;
			this.notifyEditConfirmationListeners();
		}
	}

	// Reject the pending edit confirmation
	rejectEditConfirmation(reason?: string) {
		if (this.editConfirmationCallbacks) {
			this.editConfirmationCallbacks.onReject(reason);
			this.pendingEditConfirmation = null;
			this.editConfirmationCallbacks = null;
			this.notifyEditConfirmationListeners();
		}
	}

	// Get current pending edit confirmation
	getPendingEditConfirmation(): PendingEditConfirmation | null {
		return this.pendingEditConfirmation;
	}

	// Create note confirmation management methods
	addCreateNoteConfirmationListener(listener: (confirmation: PendingCreateNoteConfirmation | null) => void) {
		this.createNoteConfirmationListeners.push(listener);
	}

	removeCreateNoteConfirmationListener(listener: (confirmation: PendingCreateNoteConfirmation | null) => void) {
		const index = this.createNoteConfirmationListeners.indexOf(listener);
		if (index > -1) {
			this.createNoteConfirmationListeners.splice(index, 1);
		}
	}

	private notifyCreateNoteConfirmationListeners() {
		this.createNoteConfirmationListeners.forEach(listener => {
			listener(this.pendingCreateNoteConfirmation);
		});
	}

	// Accept the pending create note confirmation
	acceptCreateNoteConfirmation() {
		if (this.createNoteConfirmationCallbacks) {
			this.createNoteConfirmationCallbacks.onAccept();
			this.pendingCreateNoteConfirmation = null;
			this.createNoteConfirmationCallbacks = null;
			this.notifyCreateNoteConfirmationListeners();
		}
	}

	// Reject the pending create note confirmation
	rejectCreateNoteConfirmation(reason?: string) {
		if (this.createNoteConfirmationCallbacks) {
			this.createNoteConfirmationCallbacks.onReject(reason);
			this.pendingCreateNoteConfirmation = null;
			this.createNoteConfirmationCallbacks = null;
			this.notifyCreateNoteConfirmationListeners();
		}
	}

	// Get current pending create note confirmation
	getPendingCreateNoteConfirmation(): PendingCreateNoteConfirmation | null {
		return this.pendingCreateNoteConfirmation;
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
