import React, { StrictMode } from 'react';
import { App, Editor, MarkdownView, Modal, Menu, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { AgentChatView } from './AgentChatView';
import { ObsidianAgentChatView, VIEW_TYPE_AGENT_CHAT } from './ObsidianAgentChatView';
import { LoginComponent } from './LoginComponent';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as Diff from 'diff';
import { RequestOptions } from 'openai/internal/request-options';

// Remember to rename these classes and interfaces!

interface AgentPluginSettings {
	openaiApiKey: string;
	
	// Auth0 登入狀態
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
	isLoggedIn: false
}

// Auth0 相關類型定義
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
	vector: number[];
	content: string;
	file_path: string;
	file_name: string;
	last_modified: string;
	[key: string]: any; // Add index signature for compatibility
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

// Auth0 服務類別
export class Auth0Service {
	private plugin: AgentPlugin;
	private config: Auth0Config;
	private pollingTimer: NodeJS.Timeout | null = null;
	private isPolling: boolean = false;

	constructor(plugin: AgentPlugin, config: Auth0Config) {
		this.plugin = plugin;
		this.config = config;
	}

	// 啟動 Device Authorization Flow
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

	// 輪詢檢查授權狀態
	async pollForToken(deviceCode: string, interval: number = 2): Promise<TokenResponse> {
		return new Promise((resolve, reject) => {
			// 確保停止之前的 polling
			this.stopPolling();
			
			let attempts = 0;
			const maxAttempts = 150; // 5 分鐘超時 (150 * 2 秒)
			
			// 設置 polling 標誌
			this.isPolling = true;
			
			// 包裝 resolve 和 reject 以確保清理狀態
			const wrappedResolve = (value: TokenResponse) => {
				this.isPolling = false;
				resolve(value);
			};
			
			const wrappedReject = (reason: any) => {
				this.isPolling = false;
				reject(reason);
			};

			const poll = async () => {
				// 檢查是否已經停止 polling
				if (!this.isPolling) {
					console.log('Polling stopped, aborting current poll');
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
					// 再次檢查是否已經停止 polling（在發送請求前）
					if (!this.isPolling) {
						console.log('Polling stopped, aborting before request');
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

					// 檢查是否已經停止 polling（在處理響應前）
					if (!this.isPolling) {
						console.log('Polling stopped, aborting after request');
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
						// 繼續輪詢
						return;
					} else if (data.error === 'slow_down') {
						// Auth0 要求減慢輪詢頻率
						if (this.pollingTimer) {
							clearInterval(this.pollingTimer);
						}
						// 只有在還在 polling 時才設置新的 timer
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
					// 檢查是否已經停止 polling（在錯誤發生後）
					if (!this.isPolling) {
						console.log('Polling stopped, aborting after error');
						return;
					}
					// 網路錯誤，繼續嘗試
				}
			};

			// 開始輪詢
			this.pollingTimer = setInterval(poll, interval * 1000);
			poll(); // 立即執行第一次
		});
	}

	// 停止輪詢
	stopPolling() {
		console.log('stopPolling');
		this.isPolling = false;
		if (this.pollingTimer) {
			clearInterval(this.pollingTimer);
			this.pollingTimer = null;
		}
	}

	// 刷新 Token
	async refreshToken(): Promise<TokenResponse> {
		if (!this.plugin.settings.refreshToken) {
			throw new Error('No refresh token available');
		}
		console.log('refreshToken', this.plugin.settings.refreshToken);
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

	// 獲取用戶資訊
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

	// 檢查 Token 是否即將過期（30分鐘內過期）
	isTokenExpiringSoon(): boolean {
		if (!this.plugin.settings.tokenExpiry) {
			return true;
		}
		const now = Math.floor(Date.now() / 1000);
		const thirtyMinutes = 30 * 60;
		return (this.plugin.settings.tokenExpiry - now) < thirtyMinutes;
	}

	// 設置自動刷新定時器
	setupTokenRefreshTimer() {
		// 清除現有定時器
		if (this.plugin.tokenRefreshTimer) {
			clearInterval(this.plugin.tokenRefreshTimer);
		}

		// 每 5 分鐘檢查一次
		this.plugin.tokenRefreshTimer = setInterval(async () => {
			if (this.plugin.settings.isLoggedIn && this.isTokenExpiringSoon()) {
				try {
					console.log('Token即將過期，開始自動刷新...');
					await this.autoRefreshToken();
				} catch (error: any) {
					console.error('自動刷新Token失敗:', error);
					new Notice('Login session expired, please log in again');
					await this.logout();
				}
			}
		}, 5 * 60 * 1000); // 5 分鐘
	}

	// 自動刷新 Token
	private async autoRefreshToken() {
		try {
			const tokenResponse = await this.refreshToken();
			
			// 更新設定
			this.plugin.settings.accessToken = tokenResponse.access_token;
			if (tokenResponse.refresh_token) {
				this.plugin.settings.refreshToken = tokenResponse.refresh_token;
			}
			this.plugin.settings.tokenExpiry = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;
			
			await this.plugin.saveSettings();
			console.log('Token 刷新成功');
		} catch (error: any) {
			console.error('Token 刷新失敗:', error);
			throw error;
		}
	}

	// 登出
	async logout() {
		// 停止輪詢
		this.stopPolling();
		
		// 清除定時器
		if (this.plugin.tokenRefreshTimer) {
			clearInterval(this.plugin.tokenRefreshTimer);
			this.plugin.tokenRefreshTimer = null;
		}

		// 清空登入狀態
		this.plugin.settings.isLoggedIn = false;
		this.plugin.settings.accessToken = undefined;
		this.plugin.settings.refreshToken = undefined;
		this.plugin.settings.tokenExpiry = undefined;
		this.plugin.settings.userInfo = undefined;

		await this.plugin.saveSettings();
		
		// 通知用戶
		new Notice('Logged out');
		console.log('用戶已登出');

		// 更新狀態欄
		this.plugin.updateStatusBar();
	}
}

// 登入 Modal
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

		// 設置 Modal 標題
		this.titleEl.setText('Log in to NameCard AI');

		// 創建 React 根節點
		this.root = createRoot(contentEl);
		
		// 渲染 LoginComponent
		this.root.render(
			React.createElement(StrictMode, null,
				React.createElement(LoginComponent, {
					auth0Service: this.plugin.getAuth0Service()!,
					onLoginSuccess: (userInfo: Auth0UserInfo) => {
						console.log('登入成功:', userInfo);
						new Notice(`Welcome, ${userInfo.name || userInfo.email}!`);
						this.resolveLogin(true);
						this.close();
					},
					onLoginError: (error: string) => {
						console.error('登入錯誤:', error);
						// 錯誤已經在 LoginComponent 中處理，這裡不關閉 Modal
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
		
		// 確保停止 Auth0Service 的輪詢
		const auth0Service = this.plugin.getAuth0Service();
		if (auth0Service) {
			auth0Service.stopPolling();
		}

		// 如果 Promise 還沒有解決，就以取消處理
		if (this.resolvePromise) {
			this.resolvePromise(false);
			this.resolvePromise = null;
		}

		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('login-modal');
	}

	// 返回 Promise，讓調用者知道登入結果
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
	private openaiClient: OpenAI | null = null;
	
	// Auth0 配置
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
			VIEW_TYPE_AGENT_CHAT,
			(leaf) => new ObsidianAgentChatView(leaf, this)
		);

		this.addRibbonIcon('bot-message-square', 'Open Agent Chat', () => {
			this.activateAgentChatView();
		});


		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-agent-chat',
			name: 'Open Agent Chat',
			callback: () => {
				this.activateAgentChatView();
			}
		});

		// This adds an editor command that can perform some operation on the current editor instance
		// this.addCommand({
		// 	id: 'sample-editor-command',
		// 	name: 'Sample editor command',
		// 	editorCallback: (editor: Editor, view: MarkdownView) => {
		// 		console.log(editor.getSelection());
		// 		editor.replaceSelection('Sample Editor Command');
		// 	}
		// });

		// This adds a complex command that can check whether the current state of the app allows execution of the command
		// this.addCommand({
		// 	id: 'open-sample-modal-complex',
		// 	name: 'Open sample modal (complex)',
		// 	checkCallback: (checking: boolean) => {
		// 		// Conditions to check
		// 		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		// 		if (markdownView) {
		// 			// If checking is true, we're simply "checking" if the command can be run.
		// 			// If checking is false, then we want to actually perform the operation.
		// 			if (!checking) {
		// 				new SampleModal(this.app).open();
		// 			}

		// 			// This command will only show up in Command Palette when the check function returns true
		// 			return true;
		// 		}
		// 	}
		// });

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AgentPluginSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	initializeOpenAI() {
		const backendUrl = process.env.BACKEND_BASE_URL;
		const config: any = {
			apiKey: '', // 這裡先不設定，在呼叫時才決定
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
		
		console.log('Auth0 Config initialized:', {
			domain: this.auth0Config.domain,
			clientId: this.auth0Config.clientId ? 'configured' : 'missing',
			audience: this.auth0Config.audience ? 'configured' : 'missing'
		});
		
		// 驗證配置是否完整
		if (!this.auth0Config.domain || !this.auth0Config.clientId || !this.auth0Config.audience) {
			console.warn('Auth0 configuration incomplete. Some Auth0 features may not work.');
			new Notice('Auth0 configuration incomplete, please check environment variables');
		}
	}

	initializeAuth0Service() {
		// 創建 Auth0Service 實例
		this.auth0Service = new Auth0Service(this, this.auth0Config);
		
		// 如果已經登入，設置 token 刷新定時器
		if (this.settings.isLoggedIn && this.settings.accessToken) {
			this.auth0Service.setupTokenRefreshTimer();
			console.log('已登入用戶，已設置 token 刷新定時器');
		}
	}

	initializeStatusBar() {
		// 創建狀態欄元素
		this.statusBarElement = this.addStatusBarItem();
		this.statusBarElement.addClass('auth-status-bar');
		
		// 添加點擊事件
		this.statusBarElement.addEventListener('click', () => {
			this.showStatusBarMenu();
		});
		
		// 更新狀態欄顯示
		this.updateStatusBar();
	}

	updateStatusBar() {
		if (!this.statusBarElement) return;
		
		this.statusBarElement.empty();
		
		if (this.isLoggedIn()) {
			// 已登入狀態
			const userInfo = this.getUserInfo();
			const userName = userInfo?.name || userInfo?.email || 'User';
			
			// 添加圖示
			const icon = this.statusBarElement.createSpan({ cls: 'auth-status-icon logged-in' });
			icon.innerHTML = '✅';
			
			// 添加用戶名稱
			const text = this.statusBarElement.createSpan({ cls: 'auth-status-text' });
			text.textContent = 'Agent Mode';
			
			this.statusBarElement.title = `Logged in: ${userName}\nClick to view options`;
		} else {
			// 未登入狀態
			const icon = this.statusBarElement.createSpan({ cls: 'auth-status-icon logged-out' });
			icon.innerHTML = '⚫';
			
			const text = this.statusBarElement.createSpan({ cls: 'auth-status-text' });
			text.textContent = 'Agent Mode';
			
			this.statusBarElement.title = 'Not logged in (Click to log in)';
		}
	}

	showStatusBarMenu() {
		const menu = new Menu();
		
		if (this.isLoggedIn()) {
			// 已登入，顯示用戶資訊和登出選項
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
			// 未登入，顯示登入選項
			menu.addItem((item: any) => {
				item.setTitle('Log in')
					.setIcon('log-in')
					.onClick(async () => {
						await this.startLogin();
						this.updateStatusBar();
					});
			});
		}
		
		// 加上設定選項
		menu.addSeparator();
		
		menu.addItem((item: any) => {
			item.setTitle('Settings')
				.setIcon('settings')
				.onClick(() => {
					(this.app as any).setting.open();
					(this.app as any).setting.openTabById(this.manifest.id);
				});
		});
		
		// 顯示選單
		menu.showAtMouseEvent(event as MouseEvent);
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
		model: string,
		chatMode: 'Ask' | 'Agent',
		onChunk: (chunk: string) => void,
		onToolCall: (toolCall: any) => void,
		onComplete: (finalContent: string) => void,
		onError: (error: string) => void,
		onToolResult: (result: { toolCallId: string; result: string }) => void
	): Promise<void> {
		if (!this.openaiClient) {
			onError('OpenAI not configured');
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
		let finalAssistantContent = '';
		while (true) {
			// Start streaming chat completion
			var reqOptions: RequestOptions = {
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`
				}
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
				currentMessage = this.messageReducer(currentMessage, chunk);
				
				// Stream content to UI
				const delta = chunk.choices[0]?.delta;
				if (delta?.content) {
					onChunk(delta.content);
					// 累積最終內容
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
					try {
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
								result = await this.toolEditNote(args, chatMode);
								break;
							case 'create_note':
								result = await this.toolCreateNote(args, chatMode);
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

CRITICAL: Before editing any note, you MUST first read the note's content using the read_note tool to understand:
- The current structure and content of the note
- Existing sections, headers, and formatting
- YAML frontmatter, metadata, and tags
- Any content that might be overwritten or affected by your edits
- The appropriate location for new content insertion

DO NOT attempt to edit a note without first reading its content. This prevents accidental overwrites and ensures contextually appropriate edits.

Ensure your edits respect the following:
1. Do not overwrite user content unless clearly requested or safe to do so.
2. Preserve YAML frontmatter, metadata, and tags unless explicitly directed to change them.
3. Use clear section headers, semantic structure, and proper Markdown formatting.
4. When inserting content (e.g. summaries, backlinks, tables), place it in the correct context based on the note's existing structure — don't guess.
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

	private async toolEditNote(args: { note_path: string; instructions: string; edits: EditOperation[] }, chatMode: 'Ask' | 'Agent' = 'Agent'): Promise<string> {
		try {
			// Check if we're in Ask Mode - if so, auto-reject
			if (chatMode === 'Ask') {
				return "❌ I'm currently in Ask Mode, which prohibits note editing operations. If you need to create or edit notes, please ask the user to switch to Agent Mode and try again.";
			}

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
			const diff = this.generateDiff(originalLines, modifiedLines, args.edits);
			
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

	private async toolCreateNote(args: { note_path: string; content: string; explanation: string }, chatMode: 'Ask' | 'Agent' = 'Agent'): Promise<string> {
		try {
			// Check if we're in Ask Mode - if so, auto-reject
			if (chatMode === 'Ask') {
				return "❌ I'm currently in Ask Mode, which prohibits note editing operations. If you need to create or edit notes, please ask the user to switch to Agent Mode and try again.";
			}

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
			if (!this.openaiClient) {
				console.error('OpenAI client not configured');
				return null;
			}

			// 建立請求選項，與其他 OpenAI 呼叫保持一致
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
			return null;
		}
	}

	onunload() {
		// Clear all pending timeouts to prevent memory leaks
		this.fileProcessingTimeouts.forEach((timeout) => {
			clearTimeout(timeout);
		});
		this.fileProcessingTimeouts.clear();
		
		// 清理 Auth0 相關定時器
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

	// Auth0 相關公共方法
	getAuth0Service(): Auth0Service | null {
		return this.auth0Service;
	}

	async startLogin(): Promise<void> {
		if (!this.auth0Service) {
			new Notice('Auth0 服務未初始化');
			return;
		}

		try {
			const loginModal = new LoginModal(this.app, this);
			const success = await loginModal.showLogin();
			
			if (success) {
				console.log('用戶登入成功');
				this.updateStatusBar();
			} else {
				console.log('用戶取消登入');
			}
		} catch (error: any) {
			console.error('登入失敗:', error);
			new Notice(`Login failed: ${error.message}`);
		}
	}

	async logout(): Promise<void> {
		if (!this.auth0Service) {
			return;
		}

		try {
			await this.auth0Service.logout();
			// 這裡後續會添加 UI 更新邏輯
		} catch (error: any) {
			console.error('登出失敗:', error);
			new Notice(`Logout failed: ${error.message}`);
		}
	}

	isLoggedIn(): boolean {
		return this.settings.isLoggedIn && !!this.settings.accessToken;
	}

	getUserInfo(): { email?: string; name?: string; sub?: string } | null {
		return this.settings.userInfo || null;
	}

	// 獲取用戶 profile（包含 subscription 信息）
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
				throw new Error(`Get profile failed: ${response.status} ${errorText}`);
			}

			const data = await response.json();
			return data;
		} catch (error: any) {
			console.error('Get user profile failed:', error);
			throw error;
		}
	}

	// 獲取 Stripe Billing Portal Session URL
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

	constructor(app: App, plugin: AgentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Auth0 登入狀態區塊
		containerEl.createEl('h3', { text: 'Login Status' });
		
		const authContainer = containerEl.createDiv('auth-settings-container');
		
		if (this.plugin.isLoggedIn()) {
			// 顯示已登入狀態
			const userInfo = this.plugin.getUserInfo();
			const userName = userInfo?.name || userInfo?.email || 'User';
			const userEmail = userInfo?.email || '';
			
			const statusDiv = authContainer.createDiv('auth-status-info');
			statusDiv.createEl('div', { text: '✅ Logged in', cls: 'auth-status-logged-in' });
			statusDiv.createEl('div', { text: `User: ${userName}`, cls: 'auth-user-info' });
			if (userEmail && userEmail !== userName) {
				statusDiv.createEl('div', { text: `Email: ${userEmail}`, cls: 'auth-user-info' });
			}
			
			// 添加 subscription 信息
			const subscriptionDiv = statusDiv.createDiv('subscription-info');
			subscriptionDiv.createEl('div', { text: 'Loading subscription...', cls: 'subscription-loading' });
			
			// 異步獲取用戶 profile
			this.plugin.getUserProfile().then(profileData => {
				// 清空 loading 信息
				subscriptionDiv.empty();
				
				if (profileData.success && profileData.data) {
					const { subscription } = profileData.data;
					
					// 創建帶有刷新按鈕的標題
					const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					
					if (subscription) {
						// 顯示有效訂閱信息
						const subscriptionDetails = subscriptionDiv.createDiv('subscription-details');
						subscriptionDetails.createEl('div', { 
							text: `Plan: ${subscription.product_name}`, 
							cls: 'subscription-plan' 
						});
						subscriptionDetails.createEl('div', { 
							text: `Status: ${subscription.status.toUpperCase()}`,
							cls: 'subscription-status-active' 
						});
						
						// 顯示訂閱期限
						const periodEnd = new Date(subscription.current_period_end);
						subscriptionDetails.createEl('div', { 
							text: `Valid until: ${periodEnd.toLocaleDateString()}`, 
							cls: 'subscription-period' 
						});
						
						// 如果有試用期，顯示試用信息
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

					// 添加 Billing Portal 按鈕（對所有登入用戶顯示）
					this.addBillingPortalButton(subscriptionDiv);
				} else {
					// 顯示錯誤信息
					const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
					subscriptionDiv.createEl('div', { 
						text: 'Unable to load subscription info', 
						cls: 'subscription-error' 
					});
					
					// 即使加載失敗也顯示 Billing Portal 按鈕
					this.addBillingPortalButton(subscriptionDiv);
				}
			}).catch(error => {
				// 顯示錯誤信息
				subscriptionDiv.empty();
				const headerContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
				subscriptionDiv.createEl('div', { 
					text: 'Unable to load subscription info', 
					cls: 'subscription-error' 
				});
				console.error('Failed to load user profile:', error);
				
				// 即使出錯也顯示 Billing Portal 按鈕
				this.addBillingPortalButton(subscriptionDiv);
			});
			
			// 登出按鈕
			new Setting(authContainer)
				.setName('Log out')
				.setDesc('Log out of current account')
				.addButton(button => button
					.setButtonText('Log out')
					.setCta()
					.onClick(async () => {
						await this.plugin.logout();
						this.display(); // 重新渲染設定頁面
					}));
		} else {
			// 顯示未登入狀態
			const statusDiv = authContainer.createDiv('auth-status-info');
			statusDiv.createEl('div', { text: '⚫ Not logged in', cls: 'auth-status-logged-out' });
			statusDiv.createEl('div', { text: 'Login required to use AI features', cls: 'auth-status-desc' });
			
			// 登入按鈕
			new Setting(authContainer)
				.setName('Log in')
				.setDesc('Log in to your NameCard AI account')
				.addButton(button => button
					.setButtonText('Start Login')
					.setCta()
					.onClick(async () => {
						await this.plugin.startLogin();
						this.display(); // 重新渲染設定頁面
					}));
		}
		
		// 分隔線
		containerEl.createEl('hr', { cls: 'auth-settings-separator' });
		
		// OpenAI API Key 設定
		containerEl.createEl('h3', { text: 'OpenAI Settings' });

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
	}

	// 添加 Billing Portal 按鈕的輔助方法
	private addBillingPortalButton(containerDiv: HTMLElement) {
		// 直接創建按鈕，不需要獨立的亮色容器
		const billingButton = containerDiv.createEl('button', {
			text: 'Open Billing Portal',
			cls: 'billing-portal-button'
		});

		// 按鈕樣式 - 更簡潔的設計
		billingButton.style.backgroundColor = '#667eea';
		billingButton.style.color = 'white';
		billingButton.style.border = 'none';
		billingButton.style.padding = '6px 12px';
		billingButton.style.borderRadius = '4px';
		billingButton.style.cursor = 'pointer';
		billingButton.style.fontSize = '13px';
		billingButton.style.fontWeight = '500';
		billingButton.style.marginTop = '0.75rem';
		billingButton.style.display = 'block';

		// 懸停效果
		billingButton.addEventListener('mouseenter', () => {
			billingButton.style.backgroundColor = '#5a6fd8';
		});

		billingButton.addEventListener('mouseleave', () => {
			billingButton.style.backgroundColor = '#667eea';
		});

		// 點擊事件
		billingButton.addEventListener('click', async () => {
			// 顯示載入狀態
			const originalText = billingButton.textContent;
			billingButton.textContent = '⏳ Opening...';
			billingButton.disabled = true;
			billingButton.style.opacity = '0.7';

			try {
				// 獲取 billing session URL
				const billingUrl = await this.plugin.getBillingSession();
				
				// 打開外部瀏覽器 - 使用類似 LoginComponent 的方式
				window.open(billingUrl, '_blank', 'noopener,noreferrer');
				
			} catch (error: any) {
				console.error('Failed to open billing portal:', error);
				
				// 顯示錯誤通知
				if (error.message.includes('Not logged in')) {
					new Notice('Please log in first to manage billing');
				} else {
					new Notice('Failed to open billing portal. Please try again.');
				}
			} finally {
				// 恢復按鈕狀態
				billingButton.textContent = originalText;
				billingButton.disabled = false;
				billingButton.style.opacity = '1';
			}
		});
	}

	// 創建帶有刷新按鈕的訂閱標題
	private createSubscriptionHeaderWithRefresh(containerDiv: HTMLElement, subscriptionDiv: HTMLElement): HTMLElement {
		const headerContainer = containerDiv.createEl('div');
		headerContainer.style.display = 'flex';
		headerContainer.style.alignItems = 'center';
		headerContainer.style.justifyContent = 'space-between';
		headerContainer.style.marginBottom = '0.5rem';

		// 標題文字
		const titleEl = headerContainer.createEl('div', { 
			text: 'Current Subscription', 
			cls: 'subscription-header' 
		});

		// 刷新按鈕
		const refreshButton = headerContainer.createEl('button', {
			text: '🔄',
			cls: 'subscription-refresh-button'
		});

		// 刷新按鈕樣式
		refreshButton.style.backgroundColor = 'transparent';
		refreshButton.style.border = 'none';
		refreshButton.style.cursor = 'pointer';
		refreshButton.style.fontSize = '16px';
		refreshButton.style.padding = '2px 4px';
		refreshButton.style.borderRadius = '3px';
		refreshButton.style.opacity = '0.7';
		refreshButton.style.transition = 'opacity 0.2s, background-color 0.2s';

		// 懸停效果
		refreshButton.addEventListener('mouseenter', () => {
			refreshButton.style.opacity = '1';
			refreshButton.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
		});

		refreshButton.addEventListener('mouseleave', () => {
			refreshButton.style.opacity = '0.7';
			refreshButton.style.backgroundColor = 'transparent';
		});

		// 點擊事件 - 刷新訂閱信息
		refreshButton.addEventListener('click', async () => {
			// 顯示載入狀態
			const originalText = refreshButton.textContent;
			refreshButton.textContent = '⏳';
			refreshButton.disabled = true;
			refreshButton.style.opacity = '0.5';

			try {
				// 顯示載入中
				subscriptionDiv.empty();
				subscriptionDiv.createEl('div', { text: 'Refreshing subscription...', cls: 'subscription-loading' });

				// 重新獲取用戶 profile
				const profileData = await this.plugin.getUserProfile();
				
				// 清空並重新顯示
				subscriptionDiv.empty();
				
				// 重新創建標題（遞歸調用）
				const newHeaderContainer = this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
				
				if (profileData.success && profileData.data) {
					const { subscription } = profileData.data;
					
					if (subscription && (subscription.status === 'active' || subscription.status === 'trialing')) {
						// 顯示有效訂閱信息
						const subscriptionDetails = subscriptionDiv.createDiv('subscription-details');
						subscriptionDetails.createEl('div', { 
							text: `Plan: ${subscription.product_name}`, 
							cls: 'subscription-plan' 
						});
						subscriptionDetails.createEl('div', { 
							text: `Status: ${subscription.status.toUpperCase()}`,
							cls: 'subscription-status-active' 
						});
						
						// 顯示訂閱期限
						const periodEnd = new Date(subscription.current_period_end);
						subscriptionDetails.createEl('div', { 
							text: `Valid until: ${periodEnd.toLocaleDateString()}`, 
							cls: 'subscription-period' 
						});
						
						// 如果有試用期，顯示試用信息
						if (subscription.trial_end) {
							const trialEnd = new Date(subscription.trial_end);
							if (trialEnd > new Date()) {
								subscriptionDetails.createEl('div', { 
									text: `Trial ends: ${trialEnd.toLocaleDateString()}`, 
									cls: 'subscription-trial' 
								});
							}
						}
					} else {
						// 顯示 Free 計劃
						const freeDetails = subscriptionDiv.createDiv('subscription-details');
						freeDetails.createEl('div', { 
							text: 'Plan: Free', 
							cls: 'subscription-plan-free' 
						});
						freeDetails.createEl('div', { 
							text: 'Status: Active', 
							cls: 'subscription-status-free' 
						});
					}

					// 添加 Billing Portal 按鈕
					this.addBillingPortalButton(subscriptionDiv);
				} else {
					// 顯示錯誤信息
					subscriptionDiv.createEl('div', { 
						text: 'Unable to load subscription info', 
						cls: 'subscription-error' 
					});
					
					// 即使加載失敗也顯示 Billing Portal 按鈕
					this.addBillingPortalButton(subscriptionDiv);
				}

			} catch (error: any) {
				console.error('Failed to refresh subscription:', error);
				
				// 顯示錯誤
				subscriptionDiv.empty();
				this.createSubscriptionHeaderWithRefresh(subscriptionDiv, subscriptionDiv);
				subscriptionDiv.createEl('div', { 
					text: 'Failed to refresh subscription info', 
					cls: 'subscription-error' 
				});
				this.addBillingPortalButton(subscriptionDiv);
			} finally {
				// 恢復按鈕狀態（如果按鈕還存在的話）
				if (refreshButton.isConnected) {
					refreshButton.textContent = originalText;
					refreshButton.disabled = false;
					refreshButton.style.opacity = '0.7';
				}
			}
		});

		return headerContainer;
	}
}
