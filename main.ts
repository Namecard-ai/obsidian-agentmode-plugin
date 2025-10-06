import React, { StrictMode } from 'react';
import { App, Modal, Menu, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ObsidianAgentChatView, VIEW_TYPE_AGENT_CHAT } from './ObsidianAgentChatView';
import { LoginComponent } from './LoginComponent';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as Diff from 'diff';
import { RequestOptions } from 'openai/internal/request-options';
import * as CryptoJS from 'crypto-js';
import { getEncoding } from 'js-tiktoken';

// Remember to rename these classes and interfaces!

interface AgentPluginSettings {
	openaiApiKey: string;
	firecrawlApiKey: string;
	
	// Auth0 login status
	isLoggedIn: boolean;
	accessToken?: string;
	refreshToken?: string;
	tokenExpiry?: number;  // Unix timestamp
	userInfo?: {
		email?: string;
		name?: string;
		sub?: string;
	};
}

const DEFAULT_SETTINGS: AgentPluginSettings = {
	openaiApiKey: '',
	firecrawlApiKey: '',
	isLoggedIn: false
}

// Auth0 related type definitions
export interface Auth0Config {
	domain: string;
	clientId: string;
	audience: string;
}

export interface DeviceAuthState {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

export interface Auth0UserInfo {
	email: string;
	name: string;
	sub: string;
}

export interface EmbeddingRecord {
	id: string;
	vectors: number[][];
	content_md5_hash: string;
	file_path: string;
	file_name: string;
	last_modified: string;
	error_trace?: string; // Error tracking field for failed embeddings
	[key: string]: any; // Add index signature for compatibility
}

export interface EmbeddingQueueItem {
	filePath: string;
	addedAt: number;
	source: 'file_modify' | 'manual' | 'batch_process';
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{type: 'text', text: string} | {type: 'image_url', image_url: {url: string}}>;
	tool_calls?: any[];
	tool_call_id?: string;
	name?: string;
	type?: 'standard' | 'edit-confirmation' | 'create-note-confirmation';
	toolMessages?: {
		callId: string;
		content: any;
	}[];
}


// New interfaces for precise line-by-line editing
export interface EditOperation {
	operation: 'insert' | 'delete' | 'replace';
	start_line: number;      // 1-indexed line number
	end_line?: number;       // For delete/replace operations
	content?: string;        // For insert/replace operations
	description: string;     // Description of this edit operation
}

export interface DiffLine {
	type: 'unchanged' | 'deleted' | 'inserted';
	line_number: number;     // Original line number for context
	content: string;
}

// Interface for pending edit confirmation
export interface EditConfirmationArgs {
	description: string;
	diff: string;
  }
  
  // Interface for create note confirmation
  export interface CreateNoteConfirmationArgs {
	description: string;
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

// Interface for pending create file confirmation
interface PendingCreateNoteConfirmation {
	id: string;
	note_path: string;
	content: string;
	explanation: string;
	toolCallId: string;
	timestamp: Date;
}

// Interface for create file confirmation callback
interface CreateNoteConfirmationCallbacks {
	onAccept: () => void;
	onReject: (reason?: string) => void;
}

export enum Model {
	Gemini1_5Pro = 'gemini-1.5-pro-latest',
	GPT4o_mini = 'gpt-4o-mini',
	GPT4o = 'gpt-4o',
	Claude3_5_Sonnet = 'claude-3-5-sonnet-20240620',
  }
  
  export enum AgentMode {
	Standard = 'Standard',
	Ask = 'Ask',
  }

// Auth0 service class
export class Auth0Service {
	private plugin: AgentPlugin;
	private config: Auth0Config;
	private pollingTimer: NodeJS.Timeout | null = null;
	private isPolling: boolean = false;

	constructor(plugin: AgentPlugin, config: Auth0Config) {
		this.plugin = plugin;
		this.config = config;
	}

	// Start Device Authorization Flow
	async startDeviceAuth(): Promise<DeviceAuthState> {
		const url = `https://${this.config.domain}/oauth/device/code`;
		const body = new URLSearchParams({
			client_id: this.config.clientId,
			scope: 'openid profile email',
			audience: this.config.audience
		});

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body.toString()
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Auth0 Device Authorization failed: ${response.status} ${errorText}`);
		}

		const data = await response.json();
		return data as DeviceAuthState;
	}

	// Poll to check authorization status
	async pollForToken(deviceCode: string, interval: number = 2): Promise<TokenResponse> {
		return new Promise((resolve, reject) => {
			// Ensure previous polling is stopped
			this.stopPolling();
			
			let attempts = 0;
			const maxAttempts = 150; // 5 minute timeout (150 * 2 seconds)
			
			// Set polling flag
			this.isPolling = true;
			
			// Wrap resolve and reject to ensure state cleanup
			const wrappedResolve = (value: TokenResponse) => {
				this.isPolling = false;
				resolve(value);
			};
			
			const wrappedReject = (reason: any) => {
				this.isPolling = false;
				reject(reason);
			};

			const poll = async () => {
				// Check if polling has been stopped
				if (!this.isPolling) {
					return;
				}

				if (attempts >= maxAttempts) {
					if (this.pollingTimer) {
						clearInterval(this.pollingTimer);
						this.pollingTimer = null;
					}
					wrappedReject(new Error('Authorization timeout, please try again'));
					return;
				}

				attempts++;

				try {
					// Check again if polling has been stopped (before sending request)
					if (!this.isPolling) {
						return;
					}

					const url = `https://${this.config.domain}/oauth/token`;
					const body = new URLSearchParams({
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: deviceCode,
						client_id: this.config.clientId
					});

					const response = await fetch(url, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
						},
						body: body.toString()
					});

					// Check if polling has been stopped (before processing response)
					if (!this.isPolling) {
						return;
					}

					const data = await response.json();

					if (response.ok) {
						if (this.pollingTimer) {
							clearInterval(this.pollingTimer);
							this.pollingTimer = null;
						}
						wrappedResolve(data as TokenResponse);
					} else if (data.error === 'authorization_pending') {
						// Continue polling
						return;
					} else if (data.error === 'slow_down') {
						// Auth0 requests to slow down polling frequency
						if (this.pollingTimer) {
							clearInterval(this.pollingTimer);
						}
						// Only set new timer if still polling
						if (this.isPolling) {
							this.pollingTimer = setInterval(poll, (interval + 5) * 1000);
						}
						return;
					} else {
						if (this.pollingTimer) {
							clearInterval(this.pollingTimer);
							this.pollingTimer = null;
						}
						wrappedReject(new Error(data.error_description || data.error || 'Authorization failed'));
					}
				} catch (error: any) {
					console.error('Polling error:', error);
					// Check if polling has been stopped (after error occurred)
					if (!this.isPolling) {
						return;
					}
					// Network error, continue trying
				}
			};

			// Start polling
			this.pollingTimer = setInterval(poll, interval * 1000);
			poll(); // Execute first time immediately
		});
	}

	// Stop polling
	stopPolling() {
		this.isPolling = false;
		if (this.pollingTimer) {
			clearInterval(this.pollingTimer);
			this.pollingTimer = null;
		}
	}

	// Refresh Token
	async refreshToken(): Promise<TokenResponse> {
		if (!this.plugin.settings.refreshToken) {
			throw new Error('No refresh token available');
		}
		const url = `https://${this.config.domain}/oauth/token`;
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: this.plugin.settings.refreshToken,
			client_id: this.config.clientId
		});

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body.toString()
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
		}

		const data = await response.json();
		return data as TokenResponse;
	}

	// Get user information
	async getUserInfo(): Promise<Auth0UserInfo> {
		if (!this.plugin.settings.accessToken) {
			throw new Error('No access token available');
		}

		const url = `https://${this.config.domain}/userinfo`;
		const response = await fetch(url, {
			headers: {
				'Authorization': `Bearer ${this.plugin.settings.accessToken}`,
			}
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Get user info failed: ${response.status} ${errorText}`);
		}

		const data = await response.json();
		return data as Auth0UserInfo;
	}

	// Check if Token is about to expire (expires within 30 minutes)
	isTokenExpiringSoon(): boolean {
		if (!this.plugin.settings.tokenExpiry) {
			return true;
		}
		const now = Math.floor(Date.now() / 1000);
		const thirtyMinutes = 30 * 60;
		return (this.plugin.settings.tokenExpiry - now) < thirtyMinutes;
	}

	// Setup automatic token refresh timer
	setupTokenRefreshTimer() {
		// Clear existing timer
		if (this.plugin.tokenRefreshTimer) {
			clearInterval(this.plugin.tokenRefreshTimer);
		}

		// Check every 5 minutes
		this.plugin.tokenRefreshTimer = setInterval(async () => {
			if (this.plugin.settings.isLoggedIn && this.isTokenExpiringSoon()) {
				try {
					await this.autoRefreshToken();
				} catch (error: any) {
					console.error('Automatic token refresh failed:', error);
					new Notice('Login session expired, please log in again');
					await this.logout();
				}
			}
		}, 5 * 60 * 1000); // 5 minutes
	}

	// Automatically refresh Token
	private async autoRefreshToken() {
		try {
			const tokenResponse = await this.refreshToken();
			
			// Update settings
			this.plugin.settings.accessToken = tokenResponse.access_token;
			if (tokenResponse.refresh_token) {
				this.plugin.settings.refreshToken = tokenResponse.refresh_token;
			}
			this.plugin.settings.tokenExpiry = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;
			
			await this.plugin.saveSettings();
		} catch (error: any) {
			console.error('Token refresh failed:', error);
			throw error;
		}
	}

	// Logout
	async logout() {
		// Stop polling
		this.stopPolling();
		
		// Clear timer
		if (this.plugin.tokenRefreshTimer) {
			clearInterval(this.plugin.tokenRefreshTimer);
			this.plugin.tokenRefreshTimer = null;
		}

		// Clear login status
		this.plugin.settings.isLoggedIn = false;
		this.plugin.settings.accessToken = undefined;
		this.plugin.settings.refreshToken = undefined;
		this.plugin.settings.tokenExpiry = undefined;
		this.plugin.settings.userInfo = undefined;

		await this.plugin.saveSettings();
		
		// Notify user
		new Notice('Logged out');

		// Update status bar
		this.plugin.updateStatusBar();
	}
}

// Payment Required Modal
export class PaymentRequiredModal extends Modal {
	private plugin: AgentPlugin;

	constructor(app: App, plugin: AgentPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('payment-required-modal');

		// Set Modal title
		this.titleEl.setText('Agentmode Upgrade Required');

		// Main content container
		const container = contentEl.createDiv('payment-modal-content');

		// Error explanation
		const explanationEl = container.createEl('p', { cls: 'payment-modal-explanation' });
		explanationEl.setText('You are currently on the Free plan and no OpenAI API key is configured. To continue using AI features, please choose one of the following options:');

		// Options container
		const optionsContainer = container.createDiv('payment-modal-options');

		// Option 1: Upgrade to Pro
		const proOption = optionsContainer.createDiv('payment-modal-option');
		proOption.createEl('h4', { text: '1. Upgrade to Agentmode PRO' });
		proOption.createEl('p', { text: 'Get unlimited access to AI features with our managed API service.' });
		
		const proButton = proOption.createEl('button', { 
			text: 'Open Billing Portal',
			cls: 'payment-modal-button primary' 
		});
		proButton.onclick = async () => {
			await this.plugin.openBillingPortal();
			this.close();
		};

		// Option 2: Set up BYOK
		const byokOption = optionsContainer.createDiv('payment-modal-option');
		byokOption.createEl('h4', { text: '2. Bring Your Own OpenAI Key' });
		byokOption.createEl('p', { text: 'Configure your own OpenAI API key to use AI features.' });
		
		const byokButton = byokOption.createEl('button', { 
			text: 'Open Settings',
			cls: 'payment-modal-button secondary' 
		});
		byokButton.onclick = () => {
			this.plugin.openPluginSettings();
			this.close();
		};

		// Cancel button
		const buttonContainer = container.createDiv('payment-modal-buttons');
		const cancelButton = buttonContainer.createEl('button', { 
			text: 'Cancel',
			cls: 'payment-modal-button cancel' 
		});
		cancelButton.onclick = () => {
			this.close();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('payment-required-modal');
	}

	show() {
		this.open();
	}
}

// Login Modal
export class LoginModal extends Modal {
	private plugin: AgentPlugin;
	private root: Root | null = null;
	private resolvePromise: ((success: boolean) => void) | null = null;

	constructor(app: App, plugin: AgentPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('login-modal');

		// Set Modal title
		this.titleEl.setText('Log in to Agentmode');

		// Create React root node
		this.root = createRoot(contentEl);
		
		// Render LoginComponent
		this.root.render(
			React.createElement(StrictMode, null,
				React.createElement(LoginComponent, {
					auth0Service: this.plugin.getAuth0Service()!,
					onLoginSuccess: (userInfo: Auth0UserInfo) => {
						new Notice(`Welcome, ${userInfo.name || userInfo.email}!`);
						this.resolveLogin(true);
						this.close();
					},
					onLoginError: (error: string) => {
						console.error('Login error:', error);
						// Error already handled in LoginComponent, don't close Modal here
					},
					onCancel: () => {
						this.resolveLogin(false);
						this.close();
					}
				})
			)
		);
	}

	onClose() {
		if (this.root) {
			this.root.unmount();
			this.root = null;
		}
		
		// Ensure Auth0Service polling is stopped
		const auth0Service = this.plugin.getAuth0Service();
		if (auth0Service) {
			auth0Service.stopPolling();
		}

		// If Promise hasn't been resolved yet, handle as cancelled
		if (this.resolvePromise) {
			this.resolvePromise(false);
			this.resolvePromise = null;
		}

		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('login-modal');
	}

	// Return Promise to let caller know login result
	async showLogin(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	private resolveLogin(success: boolean) {
		if (this.resolvePromise) {
			this.resolvePromise(success);
			this.resolvePromise = null;
		}
	}
}

export default class AgentPlugin extends Plugin {
	settings: AgentPluginSettings;
	vectorDbPath: string = '';
	// Add debouncing for file processing
	private fileProcessingTimeouts: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_DELAY = 3000; // 3 seconds delay
	
	// Chat interruption control
	private currentChatController: AbortController | null = null;
	private shouldStopChat: boolean = false;
	
	// Embedding Queue for processing files
	private embeddingQueue: Set<string> = new Set(); // Use Set to avoid duplicates
	private queueDetails: Map<string, EmbeddingQueueItem> = new Map(); // Store detailed info
	private isProcessingQueue: boolean = false;
	private queueConsumerTimer: NodeJS.Timeout | null = null;
	private readonly QUEUE_CONSUMER_INTERVAL = 5000; // 5 seconds
	private readonly RETRY_ATTEMPTS = 3;
	private readonly RETRY_DELAY = 5000; // 5 seconds
	
	// Settings UI update callbacks
	private settingsUpdateCallbacks: (() => void)[] = [];
	private lastSuccessfulEmbeddingTime: number | null = null;
	
	private openaiClient: OpenAI | null = null;
	
	// Auth0 configuration
	private auth0Config: Auth0Config;
	public tokenRefreshTimer: NodeJS.Timeout | null = null;
	private auth0Service: Auth0Service | null = null;
	
	// Status Bar
	private statusBarElement: HTMLElement | null = null;
	
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
		this.initializeAuth0Config();
		this.initializeAuth0Service();
		this.initializeStatusBar();

		// Listen for note changes and saves
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				// Check if the modified file is a TFile and is a markdown file (note)
				if (file instanceof TFile && file.extension === 'md') {
					// Use debouncing to avoid frequent API calls
					this.debouncedProcessFileForEmbedding(file);
				}
			})
		);

		// Listen for file deletions to clean up embedding indexes
		this.registerEvent(
			this.app.vault.on('delete', async (file) => {
				// Check if the deleted file is a TFile and is a markdown file (note)
				if (file instanceof TFile && file.extension === 'md') {
					await this.cleanupDeletedFileEmbedding(file.path);
				}
			})
		);

		// Register a new view
		this.registerView(
			VIEW_TYPE_AGENT_CHAT,
			(leaf) => new ObsidianAgentChatView(leaf, this)
		);

		this.addRibbonIcon('bot-message-square', 'Open Chat', () => {
			this.activateAgentChatView();
		});


		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-chat',
			name: 'Open Chat',
			callback: () => {
				this.activateAgentChatView();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AgentPluginSettingTab(this.app, this));

		// Start the embedding queue consumer
		this.startQueueConsumer();

		// Initialize batch processing for all markdown files in vault
		this.initializeBatchEmbeddingQueue();
	}

	initializeOpenAI() {
		const backendUrl = process.env.BACKEND_BASE_URL;
		const config: any = {
			apiKey: '', // Don't set this here, decide when calling
			dangerouslyAllowBrowser: true,
			baseURL: backendUrl,
		};
		this.openaiClient = new OpenAI(config);
	}

	initializeAuth0Config() {
		this.auth0Config = {
			domain: process.env.AUTH0_DOMAIN || '',
			clientId: process.env.AUTH0_CLIENT_ID || '',
			audience: process.env.AUTH0_AUDIENCE || ''
		};

		
		// Validate if configuration is complete
		if (!this.auth0Config.domain || !this.auth0Config.clientId || !this.auth0Config.audience) {
			console.warn('Auth0 configuration incomplete. Some Auth0 features may not work.');
			new Notice('Auth0 configuration incomplete, please check environment variables');
		}
	}

	initializeAuth0Service() {
		// Create Auth0Service instance
		this.auth0Service = new Auth0Service(this, this.auth0Config);
		
		// If already logged in, set up token refresh timer
		if (this.settings.isLoggedIn && this.settings.accessToken) {
			this.auth0Service.setupTokenRefreshTimer();
		}
	}

	initializeStatusBar() {
		// Create status bar element
		this.statusBarElement = this.addStatusBarItem();
		this.statusBarElement.addClass('auth-status-bar');
		
		// Add click event
		this.statusBarElement.addEventListener('click', () => {
			this.showStatusBarMenu();
		});
		
		// Update status bar display
		this.updateStatusBar();
	}

	updateStatusBar() {
		if (!this.statusBarElement) return;
		
		this.statusBarElement.empty();
		
		if (this.isLoggedIn()) {
			// Logged in status
			const userInfo = this.getUserInfo();
			const userName = userInfo?.name || userInfo?.email || 'User';
			
			// Add icon
			const icon = this.statusBarElement.createSpan({ cls: 'auth-status-icon logged-in' });
			icon.textContent = '✅';
			
			// Add user name
			const text = this.statusBarElement.createSpan({ cls: 'auth-status-text' });
			text.textContent = 'Agent Mode';
			
			this.statusBarElement.title = `Logged in: ${userName}\nClick to view options`;
		} else {
			// Not logged in status
			const icon = this.statusBarElement.createSpan({ cls: 'auth-status-icon logged-out' });
			icon.textContent = '⚫';
			
			const text = this.statusBarElement.createSpan({ cls: 'auth-status-text' });
			text.textContent = 'Agent Mode';
			
			this.statusBarElement.title = 'Not logged in (Click to log in)';
		}
	}

	showStatusBarMenu() {
		const menu = new Menu();
		
		if (this.isLoggedIn()) {
			// Logged in, show user info and logout option
			const userInfo = this.getUserInfo();
			const userName = userInfo?.name || userInfo?.email || 'User';
			const userEmail = userInfo?.email || '';
			
			menu.addItem((item: any) => {
				item.setTitle(`User: ${userName}`)
					.setIcon('user')
					.setDisabled(true);
			});
			
			if (userEmail && userEmail !== userName) {
				menu.addItem((item: any) => {
					item.setTitle(`Email: ${userEmail}`)
						.setIcon('mail')
						.setDisabled(true);
				});
			}
			
			menu.addSeparator();
			
			menu.addItem((item: any) => {
				item.setTitle('Log out')
					.setIcon('log-out')
					.onClick(async () => {
						await this.logout();
						this.updateStatusBar();
					});
			});
		} else {
			// Not logged in, show login option
			menu.addItem((item: any) => {
				item.setTitle('Log in')
					.setIcon('log-in')
					.onClick(async () => {
						await this.startLogin();
						this.updateStatusBar();
					});
			});
		}
		
		// Add settings option
		menu.addSeparator();
		
		menu.addItem((item: any) => {
			item.setTitle('Settings')
				.setIcon('settings')
				.onClick(() => {
					this.openPluginSettings();
				});
		});
		
		// Show menu
		menu.showAtMouseEvent(event as MouseEvent);
	}

	async initializeVectorDB() {
		try {
			// Create vector database directory in the vault's config folder
			this.vectorDbPath = `${this.app.vault.configDir}/vectors`;
			
			// Ensure the directory exists
			await this.ensureDirectoryExists(this.vectorDbPath);
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
		}
	}

	// Stop current chat
	stopCurrentChat(): void {
		this.shouldStopChat = true;
		if (this.currentChatController) {
			this.currentChatController.abort();
		}
	}

	// Agent chat completion with streaming and tool use
	async streamAgentChat(
		messages: ChatMessage[], 
		contextFiles: TFile[],
		model: string,
		chatMode: 'Ask' | 'Agent',
		onChunk: (chunk: string) => void,
		onToolCall: (toolCall: any) => void,
		onComplete: (finalContent: string) => void,
		onError: (error: string) => void,
		onToolResult: (result: { toolCallId: string; result: string }) => void,
		onInterrupted?: () => void
	): Promise<void> {
		if (!this.openaiClient) {
			onError('OpenAI not configured');
			return;
		}

		// Initialize interruption control
		this.shouldStopChat = false;
		this.currentChatController = new AbortController();

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


			// Define available tools in OpenAI format
			const tools = [
				{
					type: 'function' as const,
					function: {
						name: 'vault_search',
						description: 'Perform a semantic search across the vault to find vault files or blocks most relevant to the user\'s query.',
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
						name: 'read_file',
						description: 'Read the contents of a vault file or a range of lines within a vault file. Supports plain text files (.md, .canvas) and convertible files (.pdf, .pptx, .ppt, .docx, .doc, .xlsx, .xls, .html). For convertible files, the content will be converted to markdown format and start_line/end_line parameters are ignored - use read_entire_note: true instead.',
						parameters: {
							type: 'object',
							properties: {
								file_path: {
									type: 'string',
									description: 'The relative path to the vault file within the vault.'
								},
								start_line: {
									type: 'integer',
									description: 'The one-indexed line number to start reading from. Only applies to plain text files (.md, .canvas).'
								},
								end_line: {
									type: 'integer',
									description: 'The one-indexed line number to end reading at (inclusive). Only applies to plain text files (.md, .canvas).'
								},
								read_entire_note: {
									type: 'boolean',
									description: 'Set to true only if full content is needed. Required to be true for convertible files (.pdf, .pptx, .ppt, .docx, .doc, .xlsx, .xls, .html).'
								},
								explanation: {
									type: 'string',
									description: 'Why this vault file or section needs to be read for the task.'
								}
							},
							required: ['file_path', 'explanation']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'edit_file',
						description: 'Edit an existing vault file with precise line-by-line operations. Multiple non-overlapping edit operations can be performed in a single call. Edit operations are applied in reverse order (highest line numbers first) to maintain line number accuracy.',
						parameters: {
							type: 'object',
							properties: {
								file_path: {
									type: 'string',
									description: 'The path of the vault file to modify.'
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
							required: ['file_path', 'instructions', 'edits']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'create_file',
						description: 'Create a new vault file in the vault.',
						parameters: {
							type: 'object',
							properties: {
								file_path: {
									type: 'string',
									description: 'Path for the new vault file (e.g., \'zettel/20240608-mycognition.md\', \'diagrams/flowchart.canvas\').'
								},
								content: {
									type: 'string',
									description: 'Initial content of the vault file.'
								},
								explanation: {
									type: 'string',
									description: 'Why this new vault file is needed for the task.'
								}
							},
							required: ['file_path', 'content', 'explanation']
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
				},
				{
					type: 'function' as const,
					function: {
						name: 'vault_grep',
						description: 'Perform keyword-based text search across vault files, similar to Linux grep command. Searches for exact text matches in plain text files only. Does NOT support regular expressions - use exact text patterns only.',
						parameters: {
							type: 'object',
							properties: {
								pattern: {
									type: 'string',
									description: 'The exact text pattern or keyword to search for. Case-sensitive matching only. Regular expressions are NOT supported.'
								},
								target_subpaths: {
									type: 'array',
									items: { type: 'string' },
									description: 'Optional list of folders to scope the search to specific subdirectories.'
								},
								file_extensions: {
									type: 'array',
									items: { type: 'string' },
									description: 'Optional file extension filter (e.g., ["md", "txt"]). Defaults to all supported plain text files.'
								},
								explanation: {
									type: 'string',
									description: 'One sentence explanation of why this keyword search is necessary for the user\'s task.'
								}
							},
							required: ['pattern', 'explanation']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'web_search',
						description: 'Search the web for information using Firecrawl search API. Returns search results with titles, descriptions, and URLs.',
						parameters: {
							type: 'object',
							properties: {
								query: {
									type: 'string',
									description: 'Search query to find relevant web content'
								}
							},
							required: ['query']
						}
					}
				},
				{
					type: 'function' as const,
					function: {
						name: 'web_scrape',
						description: 'Scrape content from a specific URL using Firecrawl scrape API. Returns summarized content of the webpage.',
						parameters: {
							type: 'object',
							properties: {
								url: {
									type: 'string',
									description: 'URL to scrape content from'
								}
							},
							required: ['url']
						}
					}
				}
			];

					// Main conversation loop - continue until no more tool calls
		let finalAssistantContent = '';
		while (true) {
			// Check for interruption
			if (this.shouldStopChat) {
				onInterrupted?.();
				return;
			}
			
			// Start streaming chat completion
			let reqOptions: RequestOptions = {
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`
				},
				signal: this.currentChatController.signal
			}
			if (this.settings.openaiApiKey) {
				(reqOptions.headers as any)['X-BYOK'] = this.settings.openaiApiKey;
			}

			const stream = await this.openaiClient.chat.completions.create({
				model: model,
				messages: chatMessages,
				tools: tools,
				stream: true,
				// temperature: 0.7
			}, reqOptions);

			// Build up the message from streaming chunks
			let currentMessage: any = {};
			
			for await (const chunk of stream) {
				// Check for interruption
				if (this.shouldStopChat) {
					onInterrupted?.();
					return;
				}
				
				currentMessage = this.messageReducer(currentMessage, chunk);
				
				// Stream content to UI
				const delta = chunk.choices[0]?.delta;
				if (delta?.content) {
					onChunk(delta.content);
					// Accumulate final content
					finalAssistantContent += delta.content;
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
					// Check for interruption
					if (this.shouldStopChat) {
						onInterrupted?.();
						return;
					}
					
					try {
						const args = JSON.parse(toolCall.function.arguments || '{}');

						
						let result = '';
						
						switch (toolCall.function.name) {
							case 'vault_search':
								result = await this.toolVaultSearch(args);
								break;
							case 'read_file':
								result = await this.toolReadFile(args);
								break;
							case 'edit_file':
								result = await this.toolEditFile(args, chatMode);
								break;
							case 'create_file':
								result = await this.toolCreateFile(args, chatMode);
								break;
							case 'list_vault':
								result = await this.toolListVault(args);
								break;
							case 'vault_grep':
								result = await this.toolVaultGrep(args);
								break;
							case 'web_search':
								result = await this.toolWebSearch(args);
								break;
							case 'web_scrape':
								result = await this.toolWebScrape(args);
								break;
							default:
								result = 'Unknown tool call';
						}
						
						// Add tool result to conversation
						const toolMessage: ChatCompletionMessageParam = {
							tool_call_id: toolCall.id,
							role: 'tool',
							content: result
						};
						
						chatMessages.push(toolMessage);
						onToolResult({ toolCallId: toolCall.id, result });
						
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
						onToolResult({ toolCallId: toolCall.id, result: `Error: ${error.message || 'Unknown error'}` });
					}
				}
				
				// Continue the loop for next round of chat completion
			}

			onComplete(finalAssistantContent);

		} catch (error: any) {
			console.error('Error in agent chat:', error);
			
			// Handle abort error
			if (error.name === 'AbortError' || this.shouldStopChat) {
				onInterrupted?.();
				return;
			}
			
			if (error.status === 401) {
				this.logout();
			}
			if (error.status === 402) {
				// Show payment required modal
				const paymentModal = new PaymentRequiredModal(this.app, this);
				paymentModal.show();
			}
			onError(error.message || 'Unknown error occurred');
		} finally {
			// Clean up interruption control
			this.currentChatController = null;
			this.shouldStopChat = false;
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
				// Get parent directory of configDir to get vault path
				const configPath = this.app.vault.configDir;
				if (typeof configPath === 'string') {
					// Use path manipulation to get parent directory instead of hardcoded replacement
					const pathParts = configPath.split('/');
					if (pathParts.length > 1) {
						pathParts.pop(); // Remove the config directory name
						vaultPath = pathParts.join('/') || '/';
					}
				}
			}
			// Method 4: Use vault name (fallback)
			else if (this.app.vault.getName) {
				const vaultName = this.app.vault.getName();
				vaultPath = `Vault: ${vaultName}`;
			}
		} catch (error) {
			console.warn('🔍 [SYSTEM] Could not determine vault path, using fallback:', error);
		}
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

You are collaborating with a USER to help them organize, write, and enhance their vault files.
The task may involve summarizing content, refactoring or restructuring vault files, linking concepts together, formatting content appropriately, performing semantic searches across the vault, or answering specific questions based on the content.
Each time the USER sends a message, we may automatically attach information about their current context, such as the active file, cursor position, open backlinks, linked/unlinked mentions, and edit history within the vault.
This context may or may not be relevant — you must decide how it impacts the task.
Your main goal is to follow the USER's instructions at each message.

<tool_calling>
You have tools at your disposal to help manage and reason over the user's vault. Follow these rules:
1. ALWAYS follow the tool schema exactly, and provide all required parameters.
2. Do not call tools that are not explicitly available to you.
3. **NEVER mention tool names in your conversation with the USER.** For example, instead of saying "I'll use the edit_file tool to modify the content", just say "I'll modify the content in your file".
4. Only use tools when needed. If the task can be handled directly, just respond without tools.
5. When using a tool, explain to the USER why it's needed and how it supports the task.
</tool_calling>

<complex_task_handling>
For complex tasks that require multiple steps, involve multiple files, or need systematic approaches (such as searching, analyzing, and modifying content across the vault), follow this enhanced workflow:

**1. Task Analysis and Planning:**
Before executing any tools, briefly analyze the user's request to determine if it qualifies as a complex task. Complex tasks typically involve:
- Multiple sequential steps or operations
- Working with multiple vault files
- Performing searches across the vault
- Restructuring or reorganizing content
- Any task requiring systematic coordination of multiple actions

**2. Create a Task Plan:**
For complex tasks, start by presenting your thinking process and create a clear TODO list in the following format:

\`\`\`markdown
## 🧠 Analysis
[Brief 1-2 sentence analysis of what needs to be accomplished]

## 📋 Task Plan
- [ ] Step 1: [Clear description of first action]
- [ ] Step 2: [Clear description of second action]  
- [ ] Step 3: [Clear description of third action]
- [ ] [Additional steps as needed]
\`\`\`

**3. Transparent Execution:**
During task execution:
- After completing each logical step, briefly explain what you discovered or accomplished
- Update the TODO list to show completed items with checkmarks (x)
- If tool results lead you to adjust your plan, present the updated TODO list
- Always explain your next intended action before proceeding

**4. Dynamic Plan Updates:**
If information from tools changes your approach:
- Acknowledge what you learned that affects the plan
- Present an updated TODO list reflecting the new understanding
- Explain why the plan needed adjustment

**5. Progress Communication:**
Throughout the process:
- Be proactive in sharing your observations from tool results
- Explain how each step contributes to the overall goal
- Maintain transparency about your decision-making process

**Example Updated TODO Format:**
\`\`\`markdown
## 📋 Task Plan (Updated)
- [x] Step 1: Search for relevant files
- [x] Step 2: Analyze current structure  
- [ ] Step 3: Reorganize content (in progress)
- [ ] Step 4: Update cross-references
- [ ] Step 5: Verify changes
\`\`\`

**Note:** For simple, single-step tasks (like reading one file, making a small edit, or answering a direct question), skip the formal TODO list and proceed directly with execution.
</complex_task_handling>

<editing_files>
When making changes to a vault file, DO NOT output the entire file content unless explicitly requested. Instead, use the file editing tools.
Only make one file edit per turn unless the USER gives you a batch instruction.

CRITICAL: Before editing any vault file, you MUST first read the file's content using the read_file tool to understand:
- The current structure and content of the file
- Existing sections, headers, and formatting (for structured files like Markdown)
- YAML frontmatter, metadata, and tags (if applicable)
- Any content that might be overwritten or affected by your edits
- The appropriate location for new content insertion

DO NOT attempt to edit a vault file without first reading its content. This prevents accidental overwrites and ensures contextually appropriate edits.

Ensure your edits respect the following:
1. Do not overwrite user content unless clearly requested or safe to do so.
2. Preserve YAML frontmatter, metadata, and tags unless explicitly directed to change them.
3. Use appropriate formatting based on the file type (Markdown, JSON, Canvas, etc.).
4. When inserting content (e.g. summaries, backlinks, tables), place it in the correct context based on the file's existing structure — don't guess.
5. When refactoring or reorganizing content, preserve original meaning and ordering unless improved otherwise.
6. Fix formatting or syntax issues if they are obvious, but do not make stylistic assumptions without instruction.


IMPORTANT: Both edit_file and create_file tools require user confirmation before applying changes.

For edit_file:
- The system will show the user a detailed preview of the proposed changes
- The user can either accept or reject the edit
- If rejected, the user may provide a reason for the rejection
- If an edit is rejected, DO NOT automatically try the same edit again
- Instead, ask the user what they would prefer or how you should modify the approach
- Use the rejection feedback to better understand the user's preferences for future edits

For create_file:
- The system will show the user a preview of the file content and path before creation
- The user can either accept or reject the file creation
- If rejected, the user may provide a reason for the rejection
- If a file creation is rejected, DO NOT automatically try to create the same file again
- Instead, ask the user what they would prefer for the file path, content, or approach
- Use the rejection feedback to better understand the user's preferences for future file creations
</editing_files>

<searching_and_reading>
You can search across the vault or read from specific vault files. Follow these principles:
1. Prefer semantic search over raw grep/text search when possible.
2. When reading vault files, retrieve the full content only if needed. Use sections or block references when appropriate.
3. Avoid redundant reads — once you have enough context to answer or make a change, proceed without further searching.
</searching_and_reading>

<handling_rejections>
When a user rejects an edit or file creation, respond appropriately:

For EDIT rejections:
1. **Acknowledge the rejection gracefully** - Thank the user for their feedback
2. **Ask clarifying questions** to understand their concerns:
   - "What aspect of the proposed changes didn't work for you?"
   - "Would you prefer a different approach to organizing this content?"
   - "Are there specific parts you'd like me to focus on or avoid?"
3. **Offer alternatives** based on their feedback
4. **Learn from the rejection** - Use the feedback to improve future suggestions
5. **Never repeat the same rejected edit** without significant modifications

For CREATE FILE rejections:
1. **Acknowledge the rejection gracefully** - Thank the user for their feedback
2. **Ask clarifying questions** to understand their concerns:
   - "What didn't work about the proposed file path or content?"
   - "Would you prefer a different location or structure for this file?"
   - "Should I adjust the content, format, or focus differently?"
3. **Offer alternatives** based on their feedback:
   - Different file paths or naming conventions
   - Alternative content structures or formats
   - Different approaches to organizing the information
4. **Learn from the rejection** - Use the feedback to improve future file creation suggestions
5. **Never repeat the same rejected file creation** without significant modifications

Example responses:
- "I understand that approach didn't work for you. Could you help me understand what you'd prefer instead?"
- "Thanks for the feedback! Would you like me to try a different location or content structure?"
- "I see that wasn't quite right. What would be the most helpful way to create or organize this information?"
</handling_rejections>

You MUST use the following format when citing vault file sections:
\`\`\`
startLine:endLine:file_path
// ... existing content ...
\`\`\`
This is the ONLY acceptable format for vault file citations.

<user_info>
The USER is working in Obsidian with various file types under a single vault directory. 
The user's OS version is: \`${osInfo}\`
The absolute path to the vault is: \`${vaultPath}\`
Current date and time: \`${new Date().toLocaleString()}\`
Current timezone: \`${Intl.DateTimeFormat().resolvedOptions().timeZone}\`
Current UTC offset: \`${new Date().getTimezoneOffset() / -60} hours\`
</user_info>${contextFilesSection}

Answer the USER's request using available context and tools. If a required parameter is missing, ask for it. Otherwise, proceed with the tool call or provide the response directly.
If citing vault files or inserting content, ensure appropriate formatting and coherence with existing structure.

<drawing_canvas>
When users request to create or edit "canvas" files, or ask for drawings/diagrams without specifying a particular format, default to Obsidian's native JSON Canvas Spec format (.canvas files).

JSON Canvas Spec (Version 1.0):

**Structure:**
Canvas files contain two main arrays:
- \`nodes\` (array of visual elements: text, files, links, or groups)
- \`edges\` (array of connections between nodes)

**Node Types:**
1. **Text nodes** - contain Markdown text
   - Required: \`id\`, \`type: "text"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`text\`
   - Optional: \`color\`

2. **File nodes** - reference vault files or attachments
   - Required: \`id\`, \`type: "file"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`file\` (path)
   - Optional: \`color\`, \`subpath\` (for headings/blocks, starts with #)

3. **Link nodes** - reference external URLs
   - Required: \`id\`, \`type: "link"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`url\`
   - Optional: \`color\`

4. **Group nodes** - visual containers for organizing other nodes
   - Required: \`id\`, \`type: "group"\`, \`x\`, \`y\`, \`width\`, \`height\`
   - Optional: \`color\`, \`label\`, \`background\`, \`backgroundStyle\` ("cover"/"ratio"/"repeat")

**Edges (Connections):**
- Required: \`id\`, \`fromNode\`, \`toNode\`
- Optional: \`fromSide\`/\`toSide\` ("top"/"right"/"bottom"/"left"), \`fromEnd\`/\`toEnd\` ("none"/"arrow"), \`color\`, \`label\`

**Colors:**
Use hex format ("#FF0000") or preset numbers: "1"=red, "2"=orange, "3"=yellow, "4"=green, "5"=cyan, "6"=purple

**Layout Guidelines:**
- Position nodes logically with adequate spacing (typically 20-50px gaps)
- Use groups to organize related content
- Connect related concepts with labeled edges
- Consider visual hierarchy and flow direction
</drawing_canvas>

<proactive_engagement>
Your role goes beyond simply completing tasks — you are a proactive collaborator who helps users discover opportunities to enhance their knowledge management workflow.

**After Completing a Task:**
1. **Acknowledge completion** - Briefly confirm what was accomplished
2. **Reflect on opportunities** - Consider what related actions might be valuable
3. **Offer specific next steps** - Provide 2-3 concrete suggestions tailored to the task context
4. **Keep the conversation open** - Ask engaging questions that encourage further collaboration

**Task-Specific Follow-up Framework:**

When you've completed a **file editing or creation** task:
- Ask if they'd like to link this content to related notes
- Suggest creating an index or MOC (Map of Content) if relevant
- Offer to enhance with additional metadata, tags, or properties
- Propose formatting improvements or structural optimizations
Example: "I've updated the file. Would you like me to: (1) find and link related notes, (2) add relevant tags, or (3) create a summary in your index?"

When you've completed a **search or analysis** task:
- Offer to organize findings into a structured note
- Suggest creating a summary or synthesis of the results
- Propose building connections between discovered content
- Ask if they'd like to explore specific findings in more depth
Example: "I found several relevant notes. Would it be helpful to: (1) create a synthesis document, (2) build a canvas view of these connections, or (3) dive deeper into any specific topic?"

When you've completed a **reorganization or refactoring** task:
- Suggest reviewing related files for consistency
- Offer to update cross-references or backlinks
- Propose creating navigation aids (indexes, TOCs)
- Ask about establishing patterns or templates for future use
Example: "The reorganization is complete. Should we: (1) update related files to match this structure, (2) create a template for similar content, or (3) build an index to navigate this better?"

When you've completed a **content summarization** task:
- Offer to create visual representations (canvas, diagrams)
- Suggest generating questions or topics for further exploration
- Propose extracting key concepts into separate atomic notes
- Ask about creating study aids or review materials
Example: "Summary created! I could also: (1) visualize these concepts in a canvas, (2) break out key ideas into atomic notes, or (3) generate review questions. What would be most useful?"

When you've completed a **linking or connection** task:
- Suggest discovering additional connection opportunities
- Offer to create higher-level organizational structures
- Propose visualizing the knowledge graph
- Ask about strengthening weak connections
Example: "Links are in place. Want me to: (1) find more connection opportunities, (2) create a visual map of these relationships, or (3) build a central hub note?"

**Proactive Engagement Principles:**
- **Be specific, not generic** - Tailor suggestions to the actual content and context
- **Offer choices, not overwhelm** - Present 2-3 concrete options, not endless possibilities
- **Explain the value** - Briefly mention why a suggestion would be beneficial
- **Respect user autonomy** - Frame as helpful offers, not assumptions about what they need
- **Learn from patterns** - Notice recurring work and suggest systematic improvements
- **Stay contextual** - Base suggestions on the files, tags, and structures actually in their vault

**Tone and Approach:**
- Be enthusiastic but not pushy
- Use collaborative language ("Should we...", "Would you like me to...", "I could also...")
- Show genuine interest in helping them build a better knowledge system
- Balance proactivity with respect for their workflow and preferences
</proactive_engagement>

Answer the USER's request using available context and tools. If a required parameter is missing, ask for it. Otherwise, proceed with the tool call or provide the response directly.
If citing vault files or inserting content, ensure appropriate formatting and coherence with existing structure.

<drawing_canvas>
When users request to create or edit "canvas" files, or ask for drawings/diagrams without specifying a particular format, default to Obsidian's native JSON Canvas Spec format (.canvas files).

JSON Canvas Spec (Version 1.0):

**Structure:**
Canvas files contain two main arrays:
- \`nodes\` (array of visual elements: text, files, links, or groups)
- \`edges\` (array of connections between nodes)

**Node Types:**
1. **Text nodes** - contain Markdown text
   - Required: \`id\`, \`type: "text"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`text\`
   - Optional: \`color\`

2. **File nodes** - reference vault files or attachments
   - Required: \`id\`, \`type: "file"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`file\` (path)
   - Optional: \`color\`, \`subpath\` (for headings/blocks, starts with #)

3. **Link nodes** - reference external URLs
   - Required: \`id\`, \`type: "link"\`, \`x\`, \`y\`, \`width\`, \`height\`, \`url\`
   - Optional: \`color\`

4. **Group nodes** - visual containers for organizing other nodes
   - Required: \`id\`, \`type: "group"\`, \`x\`, \`y\`, \`width\`, \`height\`
   - Optional: \`color\`, \`label\`, \`background\`, \`backgroundStyle\` ("cover"/"ratio"/"repeat")

**Edges (Connections):**
- Required: \`id\`, \`fromNode\`, \`toNode\`
- Optional: \`fromSide\`/\`toSide\` ("top"/"right"/"bottom"/"left"), \`fromEnd\`/\`toEnd\` ("none"/"arrow"), \`color\`, \`label\`

**Colors:**
Use hex format ("#FF0000") or preset numbers: "1"=red, "2"=orange, "3"=yellow, "4"=green, "5"=cyan, "6"=purple

**Layout Guidelines:**
- Position nodes logically with adequate spacing (typically 20-50px gaps)
- Use groups to organize related content
- Connect related concepts with labeled edges
- Consider visual hierarchy and flow direction
</drawing_canvas>`;
	}

	// Tool implementations
	private async toolVaultSearch(args: { query: string; explanation: string; target_subpaths?: string[] }) {
		try {
			// Use existing vector search functionality
			const embedding = await this.getOpenAIEmbedding(args.query);
			if (!embedding) {
				return 'Failed to generate embedding for search query.';
			}

			const similarFiles = await this.searchSimilarFiles(embedding, 5);
			
			if (similarFiles.length === 0) {
				return 'No relevant files found for your query.';
			}

			// Filter out deleted files and clean up their indexes
			const validFiles = await this.filterAndCleanupResults(similarFiles);
			
			if (validFiles.length === 0) {
				return 'No relevant files found for your query (some outdated results were cleaned up).';
			}

			const results = validFiles.map(file => ({
				path: file.file_path,
				name: file.file_name,
				relevance: 'High' // You could calculate actual similarity scores here
			}));

			const resultText = `Found ${results.length} relevant files:\n${results.map(r => `- ${r.name} (${r.path})`).join('\n')}`;
			
			return resultText;
		} catch (error: any) {
			console.error('🔍 [TOOL] vault_search error:', error);
			return `Error searching vault: ${error.message}`;
		}
	}

	// File type constants for easy extension
	private static readonly GREPPABLE_EXTENSIONS = ['md', 'canvas', 'csv', 'tsv', 'txt', 'html']
	private static readonly CONVERTIBLE_EXTENSIONS = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'html'];
	private static readonly PLAIN_TEXT_EXTENSIONS = ['md', 'canvas', 'csv', 'tsv', 'txt'];
	private static readonly IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
	private static readonly MIME_TYPES: Record<string, string> = {
		'pdf': 'application/pdf',
		'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'doc': 'application/msword',
		'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'ppt': 'application/vnd.ms-powerpoint',
		'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'xls': 'application/vnd.ms-excel',
		'html': 'text/html',
		'jpg': 'image/jpeg',
		'jpeg': 'image/jpeg',
		'png': 'image/png',
		'gif': 'image/gif',
		'webp': 'image/webp',
		'bmp': 'image/bmp'
	};
	private static readonly MAX_FILE_SIZE = 64 * 1024 * 1024; // 64MB

	private getFileType(filePath: string): 'convertible' | 'plain_text' | 'unsupported' {
		const ext = filePath.split('.').pop()?.toLowerCase();
		if (AgentPlugin.CONVERTIBLE_EXTENSIONS.includes(ext || '')) return 'convertible';
		if (AgentPlugin.PLAIN_TEXT_EXTENSIONS.includes(ext || '')) return 'plain_text';
		return 'unsupported';
	}

	public isFileSupportedByReadTool(file: TFile): boolean {
		const fileType = this.getFileType(file.path);
		return fileType === 'convertible' || fileType === 'plain_text';
	}

	private async toolReadFile(args: { file_path: string; start_line?: number; end_line?: number; read_entire_note?: boolean; explanation: string }) {
		try {
			const abstractFile = this.app.vault.getAbstractFileByPath(args.file_path);
			if (!abstractFile || !(abstractFile instanceof TFile)) {
				return `File not found: ${args.file_path}`;
			}
			const file = abstractFile;

			const fileType = this.getFileType(args.file_path);
			
			if (fileType === 'plain_text') {
				return await this.readPlainTextFile(file, args);
			} else if (fileType === 'convertible') {
				return await this.readConvertibleFile(file, args);
			} else {
				return `Unsupported file type: ${args.file_path}`;
			}
		} catch (error: any) {
			console.error('📖 [TOOL] read_file error:', error);
			return `Error reading file: ${error.message}`;
		}
	}

	private async readPlainTextFile(file: TFile, args: { start_line?: number; end_line?: number; read_entire_note?: boolean }): Promise<string> {
		const content = await this.app.vault.read(file);
		
		if (args.read_entire_note || (!args.start_line && !args.end_line)) {
			return content;
		}

		const lines = content.split('\n');
		const startIdx = (args.start_line || 1) - 1;
		const endIdx = (args.end_line || lines.length) - 1;
		
		return lines.slice(startIdx, endIdx + 1).join('\n');
	}

	private async readConvertibleFile(file: TFile, args: { file_path: string }): Promise<string> {
		// Check file size
		if (file.stat.size > AgentPlugin.MAX_FILE_SIZE) {
			return `File too large: ${(file.stat.size / 1024 / 1024).toFixed(1)}MB (max: 64MB)`;
		}

		// Read file as binary
		const arrayBuffer = await this.app.vault.readBinary(file);
		
		// Convert to base64 (handle large files safely)
		const uint8Array = new Uint8Array(arrayBuffer);
		let binaryString = '';
		const chunkSize = 8192; // Process in chunks to avoid stack overflow
		
		for (let i = 0; i < uint8Array.length; i += chunkSize) {
			const chunk = uint8Array.slice(i, i + chunkSize);
			binaryString += String.fromCharCode(...chunk);
		}
		
		const base64 = btoa(binaryString);
		
		// Get MIME type
		const ext = args.file_path.split('.').pop()?.toLowerCase() || '';
		const mimeType = AgentPlugin.MIME_TYPES[ext] || 'application/octet-stream';
		
		// Construct data URI
		const dataUri = `data:${mimeType};base64,${base64}`;
		
		// Call backend convert API
		return await this.callConvertAPI(dataUri, args.file_path);
	}

	private async callConvertAPI(dataUri: string, filePath: string): Promise<string> {
		try {
			const backendUrl = process.env.BACKEND_BASE_URL;
			if (!backendUrl) {
				return 'Error: Backend URL not configured';
			}

			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};

			// Add authorization header if access token is available
			if (this.settings.accessToken) {
				headers['Authorization'] = `Bearer ${this.settings.accessToken}`;
			} else {
				return 'Error: Authentication required. Please log in first.';
			}

			const response = await fetch(`${backendUrl}/convert`, {
				method: 'POST',
				headers: headers,
				body: JSON.stringify({
					uri: dataUri,
					enable_plugins: true
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				console.error('📄 [TOOL] convert error:', response.status, errorData);
				
				if (response.status === 401) {
					this.logout();
					return 'Error: Authentication failed. Please log in again.';
				} else if (response.status === 413) {
					return 'Error: File too large for conversion.';
				} else if (response.status === 504) {
					return 'Error: Conversion timeout. The file may be too complex to process.';
				} else if (response.status === 502) {
					return 'Error: Convert service unavailable.';
				} else {
					const errorMsg = errorData?.error?.message || 'Unknown conversion error';
					return `Error converting file: ${errorMsg}`;
				}
			}

			const data = await response.json();
			
			if (!data.success) {
				console.error('📄 [TOOL] convert API error:', data);
				return 'Error: File conversion failed.';
			}
			return data.data.markdown || 'No content could be extracted from the file.';

		} catch (error: any) {
			console.error('📄 [TOOL] convert error:', error);
			return `Error converting file: ${error.message}`;
		}
	}

	private async toolEditFile(args: { file_path: string; instructions: string; edits: EditOperation[] }, chatMode: 'Ask' | 'Agent' = 'Agent'): Promise<string> {
		try {
			// Check if we're in Ask Mode - if so, auto-reject
			if (chatMode === 'Ask') {
				return "❌ I'm currently in Ask Mode, which prohibits file editing operations. If you need to create or edit files, please ask the user to switch to Agent Mode and try again.";
			}

					const abstractFile = this.app.vault.getAbstractFileByPath(args.file_path);
		if (!abstractFile || !(abstractFile instanceof TFile)) {
			return `Note not found: ${args.file_path}`;
		}
		const file = abstractFile;

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
			const diff = this.generateDiff(originalLines, modifiedLines, args.edits);
			
			// Return a Promise that will be resolved when user confirms or rejects
			return new Promise<string>((resolve, reject) => {
				// Create pending edit confirmation
				const confirmationId = Math.random().toString(36).substr(2, 9);
				const pendingConfirmation: PendingEditConfirmation = {
					id: confirmationId,
					note_path: args.file_path,
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
							resolve(`✅ Edit confirmed and applied to: ${args.file_path}\n\nChanges:\n${diffPreview}`);
						} catch (error: any) {
							reject(new Error(`Failed to apply changes: ${error.message}`));
						}
					},
					onReject: (reason?: string) => {
						const message = reason 
							? `❌ Edit rejected by user: ${reason}`
							: `❌ Edit rejected by user. No changes were made to: ${args.file_path}`;
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

	// Generate diff using the diff library for accurate results
	private generateDiff(originalLines: string[], modifiedLines: string[], edits: EditOperation[]): DiffLine[] {
		// Use the diff library to compare the original and modified text
		const originalText = originalLines.join('\n');
		const modifiedText = modifiedLines.join('\n');
		
		// Get line-by-line diff using the diff library
		const diffParts = Diff.diffLines(originalText, modifiedText);
		
		const result: DiffLine[] = [];
		let originalLineNumber = 1;
		let modifiedLineNumber = 1;
		
		for (const part of diffParts) {
			const lines = part.value.split('\n');
			// Remove the last empty line if it exists (split artifact)
			if (lines[lines.length - 1] === '') {
				lines.pop();
			}
			
			if (part.added) {
				// Added lines
				for (const line of lines) {
					result.push({
						type: 'inserted',
						line_number: modifiedLineNumber,
						content: line
					});
					modifiedLineNumber++;
				}
			} else if (part.removed) {
				// Removed lines
				for (const line of lines) {
					result.push({
						type: 'deleted',
						line_number: originalLineNumber,
						content: line
					});
					originalLineNumber++;
				}
			} else {
				// Unchanged lines
				for (const line of lines) {
					result.push({
						type: 'unchanged',
						line_number: originalLineNumber,
						content: line
					});
					originalLineNumber++;
					modifiedLineNumber++;
				}
			}
		}
		
		return result;
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

	private async toolCreateFile(args: { file_path: string; content: string; explanation: string }, chatMode: 'Ask' | 'Agent' = 'Agent'): Promise<string> {
		try {
			// Check if we're in Ask Mode - if so, auto-reject
			if (chatMode === 'Ask') {
				return "❌ I'm currently in Ask Mode, which prohibits file creation operations. If you need to create or edit files, please ask the user to switch to Agent Mode and try again.";
			}

			// Check if the file already exists
			const existingFile = this.app.vault.getAbstractFileByPath(args.file_path);
			if (existingFile) {
				return `Error: A file already exists at path: ${args.file_path}`;
			}

			// Return a Promise that will be resolved when user confirms or rejects
			return new Promise<string>((resolve, reject) => {
				// Create pending create note confirmation
				const confirmationId = Math.random().toString(36).substr(2, 9);
				const pendingConfirmation: PendingCreateNoteConfirmation = {
					id: confirmationId,
					note_path: args.file_path,
					content: args.content,
					explanation: args.explanation,
					toolCallId: confirmationId, // This would be set by caller
					timestamp: new Date()
				};

				// Set up callbacks for user decision
				this.createNoteConfirmationCallbacks = {
					onAccept: async () => {
						try {
							// Extract directory path from file_path
							const pathParts = args.file_path.split('/');
							if (pathParts.length > 1) {
								// Remove the filename to get the directory path
								const directoryPath = pathParts.slice(0, -1).join('/');
								
								// Check if directory exists, if not create it
								try {
									const dirExists = await this.app.vault.adapter.exists(directoryPath);
									if (!dirExists) {
										await this.app.vault.adapter.mkdir(directoryPath);
									}
								} catch (dirError: any) {
									// Directory might already exist or be created by another process
								}
							}
							
							// Create the file
							await this.app.vault.create(args.file_path, args.content);
							resolve(`✅ File creation confirmed and completed: ${args.file_path}`);
						} catch (error: any) {
							reject(new Error(`Failed to create file: ${error.message}`));
						}
					},
					onReject: (reason?: string) => {
						const message = reason 
							? `❌ File creation rejected by user: ${reason}`
							: `❌ File creation rejected by user. No file was created at: ${args.file_path}`;
						resolve(message);
					}
				};

				// Store the pending confirmation and notify listeners
				this.pendingCreateNoteConfirmation = pendingConfirmation;
				this.notifyCreateNoteConfirmationListeners();
			});

		} catch (error: any) {
			return `Error preparing file creation: ${error.message}`;
		}
	}

	private async toolListVault(args: { vault_path: string; explanation: string }) {
		try {
			// Convert absolute path to relative path if needed
			let relativePath = args.vault_path;
			
			// If it's an absolute path, try to convert it to relative
			if (relativePath.startsWith('/')) {
				// Try to extract vault name and make relative path
				const pathParts = relativePath.split('/');
				const vaultName = this.app.vault.getName();
				const vaultIndex = pathParts.findIndex(part => part === vaultName);
				
				if (vaultIndex !== -1 && vaultIndex < pathParts.length - 1) {
					// Found vault name in path, use everything after it
					relativePath = pathParts.slice(vaultIndex + 1).join('/');
				} else {
					// Can't convert, assume root
					relativePath = '';
				}
			}
			
			// Handle root directory cases
			if (!relativePath || relativePath === '/' || relativePath === '.') {
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
				
				return result || 'No files found in vault root';
			}
			
			// Check if the relative path exists as a folder
			const folder = this.app.vault.getAbstractFileByPath(relativePath);
			
			if (folder && (folder as any).children) {
				// It's a folder with children
				const children = (folder as any).children;
				
				const listing = children.map((child: any) => {
					if (child.children) {
						return `📁 ${child.name}/`;
					} else {
						return `📄 ${child.name}`;
					}
				});
				
				const result = listing.slice(0, 20).join('\n');
				return result || 'Empty folder';
			}
			
			// Try using adapter.list directly with the path
			const contents = await this.app.vault.adapter.list(relativePath);
			
			const listing = [
				...contents.folders.map(f => `📁 ${f}/`),
				...contents.files.map(f => `📄 ${f}`)
			];
			
			const result = listing.slice(0, 20).join('\n');
			return result || 'Empty directory';
			
		} catch (error: any) {
			console.error('📂 [TOOL] list_vault error:', error);
			
			// Fallback: list all files in vault
			try {
				const files = this.app.vault.getAllLoadedFiles();
				const result = files.map(f => f.path).slice(0, 20).join('\n');
				return result || 'No files found in vault';
			} catch (fallbackError: any) {
				return `Error listing vault: ${error.message}`;
			}
		}
	}

	// Simple cache for vault grep results
	private vaultGrepCache: Map<string, { results: any[], timestamp: number }> = new Map();
	private readonly CACHE_DURATION = 60000; // 1 minute in milliseconds

	private async toolVaultGrep(args: { 
		pattern: string; 
		target_subpaths?: string[]; 
		file_extensions?: string[]; 
		explanation: string 
	}) {
		try {
			console.log('🔍 [TOOL] vault_grep called with args:', args);

			// Create cache key
			const cacheKey = JSON.stringify({
				pattern: args.pattern,
				target_subpaths: args.target_subpaths || [],
				file_extensions: args.file_extensions || []
			});

			// Check cache
			const cached = this.vaultGrepCache.get(cacheKey);
			if (cached && (Date.now() - cached.timestamp) < this.CACHE_DURATION) {
				console.log('📋 [TOOL] vault_grep returning cached results');
				return JSON.stringify(cached.results);
			}

			// Get all files in vault
			const allFiles = this.app.vault.getAllLoadedFiles();
			
			// Filter files by type (only TFile, not folders)
			const files = allFiles.filter(file => file.hasOwnProperty('extension')) as TFile[];
			
			// Apply file extension filter
			const allowedExtensions = args.file_extensions || AgentPlugin.GREPPABLE_EXTENSIONS;
			const filteredByExtension = files.filter(file => 
				allowedExtensions.includes(file.extension.toLowerCase())
			);

			// Apply subpath filter if specified
			let filteredFiles = filteredByExtension;
			if (args.target_subpaths && args.target_subpaths.length > 0) {
				filteredFiles = filteredByExtension.filter(file => 
					args.target_subpaths!.some(subpath => 
						file.path.startsWith(subpath.endsWith('/') ? subpath : subpath + '/')
					)
				);
			}

			console.log(`🔍 [TOOL] vault_grep searching ${filteredFiles.length} files for pattern: "${args.pattern}"`);

			const results: Array<{ path: string; line: number; content: string }> = [];

			// Search through each file
			for (const file of filteredFiles) {
				try {
					const content = await this.app.vault.read(file);
					const lines = content.split('\n');
					
					// Search each line for the pattern (case-sensitive)
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].includes(args.pattern)) {
							results.push({
								path: file.path,
								line: i + 1, // 1-indexed line numbers
								content: lines[i]
							});
						}
					}
				} catch (error) {
					console.warn(`⚠️ [TOOL] vault_grep could not read file ${file.path}:`, error);
					// Continue with other files
				}
			}

			console.log(`✅ [TOOL] vault_grep found ${results.length} matches`);

			// Cache the results
			this.vaultGrepCache.set(cacheKey, {
				results: results,
				timestamp: Date.now()
			});

			// Clean up old cache entries (simple cleanup)
			if (this.vaultGrepCache.size > 50) {
				const now = Date.now();
				for (const [key, value] of this.vaultGrepCache.entries()) {
					if (now - value.timestamp > this.CACHE_DURATION) {
						this.vaultGrepCache.delete(key);
					}
				}
			}

			return JSON.stringify(results);

		} catch (error: any) {
			console.error('🔍 [TOOL] vault_grep error:', error);
			return `Error performing grep search: ${error.message}`;
		}
	}

	private async toolWebSearch(args: { query: string }) {
		try {
			if (!this.isLoggedIn() || !this.settings.accessToken) {
				return 'Error: Not logged in. Please log in to use web search functionality.';
			}

			const backendUrl = process.env.BACKEND_BASE_URL;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.settings.accessToken}`
			};

			// Add Firecrawl BYOK key if available
			if (this.settings.firecrawlApiKey) {
				headers['X-BYOK'] = this.settings.firecrawlApiKey;
			}

			const response = await fetch(`${backendUrl}/search`, {
				method: 'POST',
				headers: headers,
				body: JSON.stringify({
					query: args.query
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				console.error('🔍 [TOOL] web_search error:', response.status, errorData);
				
				if (response.status === 402) {
					return 'Error: BYOK API key is required for free plan. Please add your Firecrawl API key in plugin settings.';
				} else if (response.status === 400 && errorData.error?.code === 'ERR_INVALID_FIRECRAWL_BYOK') {
					return 'Error: Invalid Firecrawl BYOK API key. Please check your API key in plugin settings.';
				} else if (response.status === 429) {
					return 'Error: Search rate limit exceeded. Please try again later.';
				} else {
					return `Error: Web search failed (${response.status}). Please try again later.`;
				}
			}

			const data = await response.json();
			
			if (!data.success) {
				console.error('🔍 [TOOL] web_search API error:', data);
				return 'Error: Web search API returned unsuccessful response.';
			}

			// Format the search results for display
			const results = [];
			
			if (data.data?.web && Array.isArray(data.data.web)) {
				results.push('🌐 Web Results:');
				data.data.web.forEach((result: any, index: number) => {
					results.push(`${index + 1}. **${result.title || 'Untitled'}**`);
					if (result.description) {
						results.push(`   ${result.description}`);
					}
					if (result.url) {
						results.push(`   🔗 ${result.url}`);
					}
					results.push('');
				});
			}

			if (data.data?.images && Array.isArray(data.data.images)) {
				results.push('🖼️ Image Results:');
				data.data.images.forEach((result: any, index: number) => {
					results.push(`${index + 1}. **${result.title || 'Untitled'}**`);
					if (result.imageUrl) {
						results.push(`   🔗 ${result.imageUrl}`);
					}
					results.push('');
				});
			}

			if (data.data?.news && Array.isArray(data.data.news)) {
				results.push('📰 News Results:');
				data.data.news.forEach((result: any, index: number) => {
					results.push(`${index + 1}. **${result.title || 'Untitled'}**`);
					if (result.snippet) {
						results.push(`   ${result.snippet}`);
					}
					if (result.url) {
						results.push(`   🔗 ${result.url}`);
					}
					if (result.date) {
						results.push(`   📅 ${result.date}`);
					}
					results.push('');
				});
			}

			const resultText = results.join('\n');
			console.log('🔍 [TOOL] web_search completed successfully');
			return resultText || 'No search results found.';

		} catch (error: any) {
			console.error('🔍 [TOOL] web_search error:', error);
			return `Error performing web search: ${error.message}`;
		}
	}

	private async toolWebScrape(args: { url: string }) {
		try {
			if (!this.isLoggedIn() || !this.settings.accessToken) {
				return 'Error: Not logged in. Please log in to use web scrape functionality.';
			}

			// Basic URL validation
			try {
				new URL(args.url);
			} catch (urlError) {
				return 'Error: Invalid URL format. Please provide a valid URL.';
			}

			const backendUrl = process.env.BACKEND_BASE_URL;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.settings.accessToken}`
			};

			// Add Firecrawl BYOK key if available
			if (this.settings.firecrawlApiKey) {
				headers['X-BYOK'] = this.settings.firecrawlApiKey;
			}

			const response = await fetch(`${backendUrl}/scrape`, {
				method: 'POST',
				headers: headers,
				body: JSON.stringify({
					url: args.url,
					formats: ['summary'] // Always use summary format as requested
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				console.error('🕷️ [TOOL] web_scrape error:', response.status, errorData);
				
				if (response.status === 402) {
					return 'Error: BYOK API key is required for free plan. Please add your Firecrawl API key in plugin settings.';
				} else if (response.status === 400 && errorData.error?.code === 'ERR_INVALID_FIRECRAWL_BYOK') {
					return 'Error: Invalid Firecrawl BYOK API key. Please check your API key in plugin settings.';
				} else if (response.status === 429) {
					return 'Error: Scrape rate limit exceeded. Please try again later.';
				} else {
					return `Error: Web scrape failed (${response.status}). Please try again later.`;
				}
			}

			const data = await response.json();
			
			if (!data.success) {
				console.error('🕷️ [TOOL] web_scrape API error:', data);
				return 'Error: Web scrape API returned unsuccessful response.';
			}

			// Format the scrape results for display
			const results = [];
			results.push(`🕷️ **Scraped Content from:** ${args.url}`);
			results.push('');

			if (data.data?.summary) {
				results.push('📝 **Summary:**');
				results.push(data.data.summary);
				results.push('');
			}

			if (data.data?.metadata?.title) {
				results.push(`📄 **Title:** ${data.data.metadata.title}`);
			}

			if (data.data?.metadata?.description) {
				results.push(`📋 **Description:** ${data.data.metadata.description}`);
			}

			if (data.data?.metadata?.language) {
				results.push(`🌐 **Language:** ${data.data.metadata.language}`);
			}

			if (data.warning) {
				results.push('');
				results.push(`⚠️ **Warning:** ${data.warning}`);
			}

			const resultText = results.join('\n');
			console.log('🕷️ [TOOL] web_scrape completed successfully');
			return resultText || 'No content could be scraped from the URL.';

		} catch (error: any) {
			console.error('🕷️ [TOOL] web_scrape error:', error);
			return `Error performing web scrape: ${error.message}`;
		}
	}

	// Helper method to split text into chunks based on token count
	splitTextIntoChunks(text: string, maxTokens: number = 8000, overlapTokens: number = 200): string[] {
		const encoder = getEncoding('cl100k_base');
		
		const splitRecursively = (content: string): string[] => {
			const tokens = encoder.encode(content);
			
			// If content is within token limit, return as single chunk
			if (tokens.length <= maxTokens) {
				return [content];
			}
			
			// Split content in half
			const midPoint = Math.floor(content.length / 2);
			const firstHalf = content.substring(0, midPoint);
			const secondHalf = content.substring(midPoint);
			
			// Recursively split each half
			const firstChunks = splitRecursively(firstHalf);
			const secondChunks = splitRecursively(secondHalf);
			
			return [...firstChunks, ...secondChunks];
		};
		
		const chunks = splitRecursively(text);
		
		// Add overlap between chunks
		if (chunks.length > 1 && overlapTokens > 0) {
			const overlappedChunks: string[] = [];
			
			for (let i = 0; i < chunks.length; i++) {
				let chunk = chunks[i];
				
				// Add overlap from previous chunk (except for first chunk)
				if (i > 0) {
					const prevChunk = chunks[i - 1];
					const prevWords = prevChunk.split(' ');
					const overlapWords = prevWords.slice(-Math.min(50, prevWords.length)); // Use word-based overlap as approximation
					const overlapText = overlapWords.join(' ');
					chunk = overlapText + '\n\n' + chunk;
				}
				
				// Add overlap to next chunk (except for last chunk)
				if (i < chunks.length - 1) {
					const currentWords = chunk.split(' ');
					const overlapWords = currentWords.slice(0, Math.min(50, currentWords.length)); // Use word-based overlap as approximation
					const overlapText = overlapWords.join(' ');
					chunk = chunk + '\n\n' + overlapText;
				}
				
				overlappedChunks.push(chunk);
			}
			
			return overlappedChunks;
		}
		
		return chunks;
	}

	async processFileForEmbedding(file: TFile) {
		try {
			// Read file content
			const content = await this.app.vault.read(file);
			
			// Generate MD5 hash for content
			const contentMd5 = CryptoJS.MD5(content).toString(CryptoJS.enc.Hex);
			
			// Generate MD5 hash for file path (used as ID)
			const pathMd5 = CryptoJS.MD5(file.path).toString(CryptoJS.enc.Hex);
			
			// Split content into chunks
			const chunks = this.splitTextIntoChunks(content);
			
			// Generate embeddings for each chunk
			const vectors: number[][] = [];
			
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				// Include metadata in the chunk for embedding
				const embeddingContent = `File: ${file.name}\nPath: ${file.path}\nChunk ${i + 1}/${chunks.length}:\n${chunk}`;
				
				const embedding = await this.getOpenAIEmbedding(embeddingContent);
				if (embedding) {
					vectors.push(embedding);
				} else {
					console.error(`Failed to generate embedding for chunk ${i + 1} of ${file.name}`);
				}
			}
			
			if (vectors.length > 0) {
				// Create record for vector storage
				const record: EmbeddingRecord = {
					id: pathMd5, // Use MD5 hash of file path as unique ID
					vectors: vectors,
					content_md5_hash: contentMd5,
					file_path: file.path,
					file_name: file.name,
					last_modified: new Date(file.stat.mtime).toISOString()
					// Note: error_trace is intentionally omitted (cleared) on successful embedding
				};

				// Save the embedding to a JSON file
				await this.saveEmbedding(record);
				
				// Update last successful embedding time
				this.lastSuccessfulEmbeddingTime = Date.now();
			} else {
				new Notice(`Failed to generate any embeddings for: ${file.name}`);
			}
		} catch (error) {
			console.error('Error processing file for embedding:', error);
			new Notice(`Failed to process embedding for: ${file.name}`);
		}
	}

	async saveEmbedding(record: EmbeddingRecord) {
		try {
			// Generate MD5 hash from the file path (which is relative to vault)
			const pathHash = CryptoJS.MD5(record.file_path).toString(CryptoJS.enc.Hex);
			const embeddingFilePath = this.vectorDbPath + '/' + pathHash + '.json';
			
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
		const similarities = allEmbeddings.map(record => {
			// For each file, calculate similarity with all its vectors and take the maximum
			let maxSimilarity = -1;
			
			for (const vector of record.vectors) {
				const similarity = this.cosineSimilarity(queryEmbedding, vector);
				maxSimilarity = Math.max(maxSimilarity, similarity);
			}
			
			return {
				record,
				similarity: maxSimilarity
			};
		});
		
		// Sort by similarity (highest first) and return top K
		return similarities
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, topK)
			.map(item => item.record);
	}

	async getOpenAIEmbedding(text: string): Promise<number[] | null> {
		try {
			if (!this.openaiClient) {
				console.error('OpenAI client not configured');
				return null;
			}

			// Build request options, consistent with other OpenAI calls
			const reqOptions: RequestOptions = {
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`
				},
			};

			if (this.settings.openaiApiKey) {
				(reqOptions.headers as any)['X-BYOK'] = this.settings.openaiApiKey;
			}

			const response = await this.openaiClient.embeddings.create({
				model: 'text-embedding-3-small',
				input: text,
			}, reqOptions);

			return response.data[0].embedding;
		} catch (error) {
			console.error('Error getting OpenAI embedding:', error);
			if (error.status === 401) {
				this.logout();
			}
			return null;
		}
	}

	onunload() {
		// Clear all pending timeouts to prevent memory leaks
		this.fileProcessingTimeouts.forEach((timeout) => {
			clearTimeout(timeout);
		});
		this.fileProcessingTimeouts.clear();
		
		// Stop embedding queue consumer
		this.stopQueueConsumer();
		
		// Clear embedding queue
		this.embeddingQueue.clear();
		this.queueDetails.clear();
		
		// Clear Auth0 related timers
		if (this.tokenRefreshTimer) {
			clearInterval(this.tokenRefreshTimer);
			this.tokenRefreshTimer = null;
		}
		
		if (this.auth0Service) {
			this.auth0Service.stopPolling();
		}
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

	async activateAgentChatView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_AGENT_CHAT, active: true });
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	// Add debouncing for file processing - now adds to queue instead of direct processing
	private debouncedProcessFileForEmbedding(file: TFile) {
		// Check if user is logged in before processing
		if (!this.isLoggedIn()) {
			return;
		}

		const fileKey = file.path;
		if (this.fileProcessingTimeouts.has(fileKey)) {
			clearTimeout(this.fileProcessingTimeouts.get(fileKey));
		}
		this.fileProcessingTimeouts.set(fileKey, setTimeout(() => {
			// Double-check login status when timer fires (in case user logged out during debounce period)
			if (this.isLoggedIn()) {
				this.addToEmbeddingQueue(file.path, 'file_modify');
			}
			this.fileProcessingTimeouts.delete(fileKey);
		}, this.DEBOUNCE_DELAY));
	}

	// Embedding Queue Management Methods
	private addToEmbeddingQueue(filePath: string, source: 'file_modify' | 'manual' | 'batch_process') {
		if (!this.embeddingQueue.has(filePath)) {
			this.embeddingQueue.add(filePath);
			this.queueDetails.set(filePath, {
				filePath,
				addedAt: Date.now(),
				source
			});
			
			console.log(`Added to embedding queue: ${filePath} (source: ${source})`);
			
			// Notify UI update
			this.notifySettingsUpdate();
			
			// Trigger immediate processing if not already processing
			this.processEmbeddingQueue();
		}
	}

	private async processEmbeddingQueue() {
		if (this.isProcessingQueue || this.embeddingQueue.size === 0) {
			return;
		}

		this.isProcessingQueue = true;
		
		try {
			// Process one file at a time
			const filePath = this.embeddingQueue.values().next().value;
			if (filePath) {
				await this.processFileFromQueue(filePath);
				
				// Remove from queue after processing
				this.embeddingQueue.delete(filePath);
				this.queueDetails.delete(filePath);
				
				// Continue processing if there are more items
				if (this.embeddingQueue.size > 0) {
					// Use setTimeout to avoid blocking the main thread
					setTimeout(() => this.processEmbeddingQueue(), 100);
				}
			}
		} catch (error) {
			console.error('Error in processEmbeddingQueue:', error);
		} finally {
			this.isProcessingQueue = false;
			// Notify UI update after processing
			this.notifySettingsUpdate();
		}
	}

	private async processFileFromQueue(filePath: string): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				console.warn(`File not found or not a TFile: ${filePath}`);
				return;
			}

			// Check if file needs processing by comparing MD5 hash
			if (await this.shouldSkipFileProcessing(file)) {
				console.log(`Skipping file (no changes detected): ${filePath}`);
				return;
			}

			// Process with retry logic
			await this.processFileForEmbeddingWithRetry(file);
			
		} catch (error) {
			console.error(`Error processing file from queue: ${filePath}`, error);
		}
	}

	private async shouldSkipFileProcessing(file: TFile): Promise<boolean> {
		try {
			// Read current file content and generate MD5
			const content = await this.app.vault.read(file);
			const currentMd5 = CryptoJS.MD5(content).toString(CryptoJS.enc.Hex);
			
			// Check if embedding record exists
			const pathMd5 = CryptoJS.MD5(file.path).toString(CryptoJS.enc.Hex);
			const embeddingFilePath = this.vectorDbPath + '/' + pathMd5 + '.json';
			
			try {
				const existingContent = await this.app.vault.adapter.read(embeddingFilePath);
				const existingRecord: EmbeddingRecord = JSON.parse(existingContent);
				
				// Skip if vectors exist and MD5 matches (no changes)
				if (existingRecord.vectors && 
					existingRecord.vectors.length > 0 && 
					existingRecord.content_md5_hash === currentMd5) {
					return true;
				}
			} catch (error) {
				// File doesn't exist or can't be read, so we should process
				return false;
			}
			
			return false;
		} catch (error) {
			console.error('Error checking if file should be skipped:', error);
			return false;
		}
	}

	private async processFileForEmbeddingWithRetry(file: TFile): Promise<void> {
		let lastError: any = null;
		
		for (let attempt = 1; attempt <= this.RETRY_ATTEMPTS; attempt++) {
			try {
				await this.processFileForEmbedding(file);
				return; // Success, exit retry loop
			} catch (error) {
				lastError = error;
				console.error(`Embedding attempt ${attempt}/${this.RETRY_ATTEMPTS} failed for ${file.path}:`, error);
				
				if (attempt < this.RETRY_ATTEMPTS) {
					// Wait before retry
					await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
				}
			}
		}
		
		// All retries failed, save error record
		await this.saveErrorRecord(file, lastError);
	}

	private async saveErrorRecord(file: TFile, error: any): Promise<void> {
		try {
			const pathMd5 = CryptoJS.MD5(file.path).toString(CryptoJS.enc.Hex);
			const content = await this.app.vault.read(file);
			const contentMd5 = CryptoJS.MD5(content).toString(CryptoJS.enc.Hex);
			
			const errorRecord: EmbeddingRecord = {
				id: pathMd5,
				vectors: [], // Empty array for failed embeddings
				content_md5_hash: contentMd5,
				file_path: file.path,
				file_name: file.name,
				last_modified: new Date(file.stat.mtime).toISOString(),
				error_trace: error?.message || String(error)
			};

			await this.saveEmbedding(errorRecord);
			new Notice(`Failed to generate embeddings for: ${file.name} (saved error record)`);
		} catch (saveError) {
			console.error('Error saving error record:', saveError);
		}
	}

	private startQueueConsumer() {
		if (this.queueConsumerTimer) {
			clearInterval(this.queueConsumerTimer);
		}
		
		this.queueConsumerTimer = setInterval(() => {
			this.processEmbeddingQueue();
		}, this.QUEUE_CONSUMER_INTERVAL);
	}

	private stopQueueConsumer() {
		if (this.queueConsumerTimer) {
			clearInterval(this.queueConsumerTimer);
			this.queueConsumerTimer = null;
		}
	}

	private clearEmbeddingQueue() {
		const queueSize = this.embeddingQueue.size;
		
		// Clear the queue and details
		this.embeddingQueue.clear();
		this.queueDetails.clear();
		
		// Reset processing flag
		this.isProcessingQueue = false;
		
		if (queueSize > 0) {
			console.log(`Cleared ${queueSize} items from embedding queue after logout`);
			new Notice(`Cleared embedding queue (${queueSize} pending items)`);
		}
		
		// Notify UI update
		this.notifySettingsUpdate();
	}

	// Settings UI update callback management
	addSettingsUpdateListener(callback: () => void) {
		this.settingsUpdateCallbacks.push(callback);
	}

	removeSettingsUpdateListener(callback: () => void) {
		const index = this.settingsUpdateCallbacks.indexOf(callback);
		if (index > -1) {
			this.settingsUpdateCallbacks.splice(index, 1);
		}
	}

	private notifySettingsUpdate() {
		this.settingsUpdateCallbacks.forEach(callback => {
			try {
				callback();
			} catch (error) {
				console.error('Error in settings update callback:', error);
			}
		});
	}

	// Public methods for Settings UI
	getEmbeddingQueueSize(): number {
		return this.embeddingQueue.size;
	}

	getLastSuccessfulEmbeddingTime(): number | null {
		return this.lastSuccessfulEmbeddingTime;
	}

	async triggerReindexAllFiles(): Promise<void> {
		// 1. Add all files to embedding queue
		await this.initializeBatchEmbeddingQueue();
		
		// 2. Clean up orphaned index files
		await this.cleanupOrphanedIndexFiles();
	}

	private async cleanupDeletedFileEmbedding(filePath: string): Promise<void> {
		try {
			const pathMd5 = CryptoJS.MD5(filePath).toString(CryptoJS.enc.Hex);
			const indexFilePath = this.vectorDbPath + '/' + pathMd5 + '.json';
			
			// Check if index file exists
			if (await this.app.vault.adapter.exists(indexFilePath)) {
				await this.app.vault.adapter.remove(indexFilePath);
				console.log(`Cleaned up index file for deleted file: ${filePath}`);
			}
		} catch (error) {
			console.error(`Failed to cleanup index for deleted file ${filePath}:`, error);
		}
	}

	private async cleanupOrphanedIndexFiles(): Promise<void> {
		try {
			const files = await this.app.vault.adapter.list(this.vectorDbPath);
			let cleanedCount = 0;
			
			for (const indexFile of files.files) {
				if (indexFile.endsWith('.json')) {
					try {
						// Read index file to get the original file path
						const content = await this.app.vault.adapter.read(indexFile);
						const record: EmbeddingRecord = JSON.parse(content);
						
						// Check if the corresponding vault file still exists
						const fileExists = this.app.vault.getAbstractFileByPath(record.file_path) instanceof TFile;
						
						if (!fileExists) {
							await this.app.vault.adapter.remove(indexFile);
							cleanedCount++;
							console.log(`Cleaned up orphaned index: ${indexFile} (original file: ${record.file_path})`);
						}
					} catch (error) {
						console.error(`Failed to process index file ${indexFile}:`, error);
					}
				}
			}
			
			if (cleanedCount > 0) {
				console.log(`Batch cleanup completed: removed ${cleanedCount} orphaned index files`);
				new Notice(`Cleaned up ${cleanedCount} orphaned index files`);
			}
		} catch (error) {
			console.error('Failed to cleanup orphaned index files:', error);
		}
	}

	private async filterAndCleanupResults(embeddings: EmbeddingRecord[]): Promise<EmbeddingRecord[]> {
		const validEmbeddings: EmbeddingRecord[] = [];
		
		for (const embedding of embeddings) {
			const fileExists = this.app.vault.getAbstractFileByPath(embedding.file_path) instanceof TFile;
			
			if (fileExists) {
				validEmbeddings.push(embedding);
			} else {
				// File doesn't exist, clean up its index
				console.log(`Found deleted file in search results: ${embedding.file_path}, cleaning up index`);
				await this.cleanupDeletedFileEmbedding(embedding.file_path);
			}
		}
		
		return validEmbeddings;
	}

	private async initializeBatchEmbeddingQueue() {
		try {
			// Check if user is logged in before initializing batch processing
			if (!this.isLoggedIn()) {
				console.log('User not logged in, skipping batch embedding queue initialization');
				return;
			}

			console.log('Initializing batch embedding queue for all markdown files...');
			
			// Get all markdown files in the vault
			const allFiles = this.app.vault.getMarkdownFiles();
			
			console.log(`Found ${allFiles.length} markdown files in vault`);
			
			// Add all files to queue with batch_process source
			for (const file of allFiles) {
				this.addToEmbeddingQueue(file.path, 'batch_process');
			}
			
			new Notice(`Added ${allFiles.length} files to embedding queue for processing`);
		} catch (error) {
			console.error('Error initializing batch embedding queue:', error);
		}
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

	// Auth0 related public methods
	getAuth0Service(): Auth0Service | null {
		return this.auth0Service;
	}

	async startLogin(): Promise<void> {
		if (!this.auth0Service) {
			new Notice('Auth0 service not initialized');
			return;
		}

		try {
			const loginModal = new LoginModal(this.app, this);
			const success = await loginModal.showLogin();
			
			if (success) {
				this.updateStatusBar();
				
				// Start batch embedding queue after successful login
				await this.initializeBatchEmbeddingQueue();
			}
		} catch (error: any) {
			console.error('Login failed:', error);
			new Notice(`Login failed: ${error.message}`);
		}
	}

	async logout(): Promise<void> {
		if (!this.auth0Service) {
			return;
		}

		try {
			await this.auth0Service.logout();
			
			// Clear embedding queue after logout
			this.clearEmbeddingQueue();
			
			// UI update logic will be added here later
		} catch (error: any) {
			console.error('Logout failed:', error);
			new Notice(`Logout failed: ${error.message}`);
		}
	}

	isLoggedIn(): boolean {
		return this.settings.isLoggedIn && !!this.settings.accessToken;
	}

	getUserInfo(): { email?: string; name?: string; sub?: string } | null {
		return this.settings.userInfo || null;
	}

	// Get user profile (including subscription information)
	async getUserProfile(): Promise<any> {
		if (!this.isLoggedIn() || !this.settings.accessToken) {
			throw new Error('Not logged in');
		}

		try {
			const backendUrl = process.env.BACKEND_BASE_URL;
			const response = await fetch(`${backendUrl}/user/profile`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw {
					status: response.status,
					message: errorText
				};
			}

			const data = await response.json();
			return data;
		} catch (error: any) {
			console.error('Get user profile failed:', error);
			throw error;
		}
	}

	// Get Stripe Billing Portal Session URL
	async getBillingSession(): Promise<string> {
		if (!this.isLoggedIn() || !this.settings.accessToken) {
			throw new Error('Not logged in');
		}

		try {
			const backendUrl = process.env.BACKEND_BASE_URL;
			const response = await fetch(`${backendUrl}/user/billing-session`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Get billing session failed: ${response.status} ${errorText}`);
			}

			const data = await response.json();
			if (data.success && data.data && data.data.url) {
				return data.data.url;
			} else {
				throw new Error('Invalid response format');
			}
		} catch (error: any) {
			console.error('Get billing session failed:', error);
			throw error;
		}
	}

	// Open Billing Portal (extracted from AgentPluginSettingTab)
	async openBillingPortal(): Promise<void> {
		try {
			// Get billing session URL
			const billingUrl = await this.getBillingSession();
			
			// Open external browser
			window.open(billingUrl, '_blank', 'noopener,noreferrer');
			
		} catch (error: any) {
			console.error('Failed to open billing portal:', error);
			
			// Show error notification
			if (error.message.includes('Not logged in')) {
				new Notice('Please log in first to manage billing');
			} else {
				new Notice('Failed to open billing portal. Please try again.');
			}
		}
	}

	// Open Plugin Settings (extracted from showStatusBarMenu)
	openPluginSettings(): void {
		(this.app as any).setting.open();
		(this.app as any).setting.openTabById(this.manifest.id);
	}
}

// class SampleModal extends Modal {
// 	constructor(app: App) {
// 		super(app);
// 	}

// 	onOpen() {
// 		const { contentEl } = this;
// 		contentEl.setText('Woah!');

// 	}

// 	onClose() {
// 		const { contentEl } = this;
// 		contentEl.empty();
// 	}
// }

class AgentPluginSettingTab extends PluginSettingTab {
	plugin: AgentPlugin;
	private updateCallback: (() => void) | null = null;
	private vaultIndexingContainer: HTMLElement | null = null;

	constructor(app: App, plugin: AgentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Auth0 login status section
		containerEl.createEl('h3', { text: 'Login Status' });
		
		const authContainer = containerEl.createDiv('auth-settings-container');
		
		if (this.plugin.isLoggedIn()) {
			// Show logged in status
			const userInfo = this.plugin.getUserInfo();
			const userName = userInfo?.name || userInfo?.email || 'User';
			const userEmail = userInfo?.email || '';
			
			const statusDiv = authContainer.createDiv('auth-status-info');
			statusDiv.createEl('div', { text: '✅ Logged in', cls: 'auth-status-logged-in' });
			statusDiv.createEl('div', { text: `User: ${userName}`, cls: 'auth-user-info' });
			if (userEmail && userEmail !== userName) {
				statusDiv.createEl('div', { text: `Email: ${userEmail}`, cls: 'auth-user-info' });
			}
			
			// Add subscription information
			const subscriptionDiv = statusDiv.createDiv('subscription-info');
			subscriptionDiv.createEl('div', { text: 'Loading subscription...', cls: 'subscription-loading' });
			
							// Asynchronously get user profile
				this.plugin.getUserProfile().then(profileData => {
				// Clear loading information
				subscriptionDiv.empty();
				
				if (profileData.success && profileData.data) {
					const { subscription } = profileData.data;
					
					// Create header with refresh button
					const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					
					if (subscription) {
						// Show valid subscription information
						const subscriptionDetails = subscriptionDiv.createDiv('subscription-details');
						subscriptionDetails.createEl('div', { 
							text: `Plan: ${subscription.product_name}`, 
							cls: 'subscription-plan' 
						});
						subscriptionDetails.createEl('div', { 
							text: `Status: ${subscription.status.toUpperCase()}`,
							cls: 'subscription-status-active' 
						});
						
						// Show subscription period
						if (subscription.plan_id !== 'free') {
							const periodEnd = new Date(subscription.current_period_end);
							subscriptionDetails.createEl('div', { 
								text: `Valid until: ${periodEnd.toLocaleDateString()}`, 
								cls: 'subscription-period' 
							});
						}
						
						// If there is a trial period, show trial information
						if (subscription.trial_end) {
							const trialEnd = new Date(subscription.trial_end);
							if (trialEnd > new Date()) {
								subscriptionDetails.createEl('div', { 
									text: `Trial ends: ${trialEnd.toLocaleDateString()}`, 
									cls: 'subscription-trial' 
								});
							}
						}
					}

					// Add Billing Portal button (shown to all logged in users)
					this.addBillingPortalButton(subscriptionDiv);
				} else {
					// Show error information
					const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					subscriptionDiv.createEl('div', { 
						text: 'Unable to load subscription info', 
						cls: 'subscription-error' 
					});
					
					// Show Billing Portal button even if loading fails
					this.addBillingPortalButton(subscriptionDiv);
				}
			}).catch(error => {
				if (error.status === 401) {
					this.plugin.logout();
					this.display();
				} else {
					// Show error information
					subscriptionDiv.empty();
					const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					subscriptionDiv.createEl('div', { 
						text: 'Unable to load subscription info', 
						cls: 'subscription-error' 
					});
					console.error('Failed to load user profile:', error);
					
					// Show Billing Portal button even if there's an error
					this.addBillingPortalButton(subscriptionDiv);
				}
				
			});
			
			// Logout button
			new Setting(authContainer)
				.setName('Log out')
				.setDesc('Log out of current account')
				.addButton(button => button
					.setButtonText('Log out')
					.setCta()
					.onClick(async () => {
						await this.plugin.logout();
						this.display(); // Re-render settings page
					}));
		} else {
			// Show not logged in status
			const statusDiv = authContainer.createDiv('auth-status-info');
			statusDiv.createEl('div', { text: '⚫ Not logged in', cls: 'auth-status-logged-out' });
			statusDiv.createEl('div', { text: 'Login required to use AI features', cls: 'auth-status-desc' });
			
			// Login button
			new Setting(authContainer)
				.setName('Log in')
				.setDesc('Log in to your Agentmode account')
				.addButton(button => button
					.setButtonText('Start Login')
					.setCta()
					.onClick(async () => {
						await this.plugin.startLogin();
						this.display(); // Re-render settings page
					}));
		}
		
		// Separator line
		containerEl.createEl('hr', { cls: 'auth-settings-separator' });
		
		// OpenAI API Key settings
		containerEl.createEl('h3', { text: 'Bring Your Own Key' });

		// Add important notice
		const keyInfoEl = containerEl.createEl('p', { cls: 'byok-info' });
		const strongEl = keyInfoEl.createEl('strong');
		strongEl.textContent = 'How this works:';
		keyInfoEl.appendText(' Free plan users need to bring their own OpenAI API key and Firecrawl API key to get started. Pro plan users automatically get access to our managed API service - you don\'t need to enter your own key (even if you\'ve entered one, we\'ll directly ignore your key and use our managed service).');

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc('The agent leverage OpenAI API to provide AI features, you can get your API key from OpenAI Platform (https://platform.openai.com/api-keys)')
			.addText(text => text
				.setPlaceholder('sk-...')
				.setValue(this.plugin.settings.openaiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openaiApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Firecrawl API Key')
			.setDesc('For web search and scrape functionality, you can get your API key from Firecrawl (https://firecrawl.dev/)')
			.addText(text => text
				.setPlaceholder('fc-...')
				.setValue(this.plugin.settings.firecrawlApiKey)
				.onChange(async (value) => {
					this.plugin.settings.firecrawlApiKey = value;
					await this.plugin.saveSettings();
				}));

		// Add Vault File Indexing section (only for logged-in users)
		if (this.plugin.isLoggedIn()) {
			// Add separator
			containerEl.createEl('hr', { cls: 'auth-settings-separator' });
			
			this.createVaultIndexingSection(containerEl);
		}
		
		// Register settings update callback for vault indexing status
		this.registerSettingsUpdateCallback();
	}
	
	private registerSettingsUpdateCallback() {
		// Remove old callback if exists
		if (this.updateCallback) {
			this.plugin.removeSettingsUpdateListener(this.updateCallback);
		}
		
		// Register new callback
		this.updateCallback = () => this.updateVaultIndexingStatus();
		this.plugin.addSettingsUpdateListener(this.updateCallback);
	}
	
	// Clean up callback when tab is destroyed
	onDestroy() {
		if (this.updateCallback) {
			this.plugin.removeSettingsUpdateListener(this.updateCallback);
			this.updateCallback = null;
		}
	}

	private createVaultIndexingSection(containerEl: HTMLElement) {
		// Create Vault File Indexing section
		containerEl.createEl('h4', { text: 'Vault File Indexing', cls: 'vault-indexing-header' });
		
		this.vaultIndexingContainer = containerEl.createDiv('vault-indexing-container');
		this.updateVaultIndexingStatus();
		
		// Add Reindex button
		new Setting(this.vaultIndexingContainer)
			.setName('Reindex All Files')
			.setDesc('Rebuild the search index for all markdown files in your vault')
			.addButton(button => {
				const queueSize = this.plugin.getEmbeddingQueueSize();
				const isIndexing = queueSize > 0;
				
				button
					.setButtonText('Reindex All Files')
					.setDisabled(isIndexing)
					.onClick(async () => {
						const confirmed = await this.showReindexConfirmation();
						if (!confirmed) {
							// If user cancelled, we need to reset the button state
							// The button will be updated by the next UI refresh
							setTimeout(() => this.updateVaultIndexingStatus(), 100);
						}
					});
			});
	}

	private updateVaultIndexingStatus() {
		if (!this.vaultIndexingContainer) return;
		
		// Find or create status container
		let statusContainer = this.vaultIndexingContainer.querySelector('.vault-indexing-status') as HTMLElement;
		if (!statusContainer) {
			statusContainer = this.vaultIndexingContainer.createDiv('vault-indexing-status');
		} else {
			statusContainer.empty();
		}
		
		const queueSize = this.plugin.getEmbeddingQueueSize();
		const lastSuccessTime = this.plugin.getLastSuccessfulEmbeddingTime();
		const isIndexing = queueSize > 0;
		
		// Status display
		if (isIndexing) {
			statusContainer.createEl('div', { 
				text: `⏳ Indexing (${queueSize} files remaining)`, 
				cls: 'indexing-status-indexing' 
			});
		} else {
			statusContainer.createEl('div', { 
				text: '✅ Synced (All files indexed)', 
				cls: 'indexing-status-synced' 
			});
		}
		
		// Last successful indexing time
		if (lastSuccessTime) {
			const lastTimeStr = new Date(lastSuccessTime).toLocaleString();
			statusContainer.createEl('div', { 
				text: `Last successful indexing: ${lastTimeStr}`, 
				cls: 'last-indexing-time' 
			});
		}
		
		// Update Reindex button state
		const reindexButton = this.vaultIndexingContainer.querySelector('button') as HTMLButtonElement;
		if (reindexButton) {
			reindexButton.disabled = isIndexing;
		}
	}

	private async showReindexConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText('Reindex All Files');
			
			const content = modal.contentEl;
			content.createEl('p', { 
				text: 'This will reindex all markdown files in your vault and may take some time. Are you sure you want to continue?' 
			});
			
			const buttonContainer = content.createDiv('modal-button-container');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.justifyContent = 'flex-end';
			buttonContainer.style.gap = '10px';
			buttonContainer.style.marginTop = '20px';
			
			// Cancel button
			const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelBtn.addEventListener('click', () => {
				modal.close();
				resolve(false); // User cancelled
			});
			
			// Reindex button
			const reindexBtn = buttonContainer.createEl('button', { 
				text: 'Reindex', 
				cls: 'mod-cta' 
			});
			reindexBtn.addEventListener('click', async () => {
				modal.close();
				await this.plugin.triggerReindexAllFiles();
				resolve(true); // User confirmed
			});
			
			modal.open();
		});
	}

	// Helper method to add Billing Portal button
	private addBillingPortalButton(containerDiv: HTMLElement) {
		// Create button directly, no need for separate bright container
		const billingButton = containerDiv.createEl('button', {
			text: 'Open Billing Portal',
			cls: 'billing-portal-button'
		});

		// Click event
		billingButton.addEventListener('click', async () => {
			// Show loading state
			const originalText = billingButton.textContent;
			billingButton.textContent = '⏳ Opening...';
			billingButton.disabled = true;

			try {
				// Use the extracted public method
				await this.plugin.openBillingPortal();
				
			} catch (error: any) {
				// Error handling is already done in openBillingPortal method
				console.error('Failed to open billing portal:', error);
			} finally {
				// Restore button state
				billingButton.textContent = originalText;
				billingButton.disabled = false;
			}
		});
	}

	// Create subscription header with refresh button
	private createSubscriptionHeaderWithRefresh(containerDiv: HTMLElement, subscriptionDiv: HTMLElement): HTMLElement {
		const headerContainer = containerDiv.createEl('div', { cls: 'subscription-header-container' });

		// Title text
		const titleEl = headerContainer.createEl('div', { 
			text: 'Current Subscription', 
			cls: 'subscription-header' 
		});

		// Refresh button
		const refreshButton = headerContainer.createEl('button', {
			text: '🔄',
			cls: 'subscription-refresh-button'
		});

		// Click event - refresh subscription information
		refreshButton.addEventListener('click', async () => {
			// Show loading state
			const originalText = refreshButton.textContent;
			refreshButton.textContent = '⏳';
			refreshButton.disabled = true;

			try {
				// Show loading
				subscriptionDiv.empty();
				subscriptionDiv.createEl('div', { text: 'Refreshing subscription...', cls: 'subscription-loading' });

				// Re-fetch user profile
				const profileData = await this.plugin.getUserProfile();
				
				// Clear and re-display
				subscriptionDiv.empty();
				
				// Re-create header (recursive call)
				const newHeaderContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
				
				if (profileData.success && profileData.data) {
					const { subscription } = profileData.data;
					
					if (subscription) {
						// Show valid subscription information
						const subscriptionDetails = subscriptionDiv.createDiv('subscription-details');
						subscriptionDetails.createEl('div', { 
							text: `Plan: ${subscription.product_name}`, 
							cls: 'subscription-plan' 
						});
						subscriptionDetails.createEl('div', { 
							text: `Status: ${subscription.status.toUpperCase()}`,
							cls: 'subscription-status-active' 
						});
						
						// Show subscription period
						if (subscription.plan_id !== 'free') {
							const periodEnd = new Date(subscription.current_period_end);
							subscriptionDetails.createEl('div', { 
								text: `Valid until: ${periodEnd.toLocaleDateString()}`, 
								cls: 'subscription-period' 
							});
						}
						
						
						// If there is a trial period, show trial information
						if (subscription.trial_end) {
							const trialEnd = new Date(subscription.trial_end);
							if (trialEnd > new Date()) {
								subscriptionDetails.createEl('div', { 
									text: `Trial ends: ${trialEnd.toLocaleDateString()}`, 
									cls: 'subscription-trial' 
								});
							}
						}
					}

					// Add Billing Portal button
					this.addBillingPortalButton(subscriptionDiv);
				} else {
					// Show error information
					subscriptionDiv.createEl('div', { 
						text: 'Unable to load subscription info', 
						cls: 'subscription-error' 
					});
					
					// Show Billing Portal button even if loading fails
					this.addBillingPortalButton(subscriptionDiv);
				}

			} catch (error: any) {
				console.error('Failed to refresh subscription:', error);
				if (error.status === 401) {
					this.plugin.logout();
					this.display();
				}else {
					// Show error
					subscriptionDiv.empty();
					this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					subscriptionDiv.createEl('div', { 
						text: 'Failed to refresh subscription info', 
						cls: 'subscription-error' 
					});
					this.addBillingPortalButton(subscriptionDiv);
				}
				
			} finally {
				// Restore button state (if button still exists)
				if (refreshButton.isConnected) {
					refreshButton.textContent = originalText;
					refreshButton.disabled = false;
				}
			}
		});

		return headerContainer;
	}
}
