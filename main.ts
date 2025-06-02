// Set up module aliases for external dependencies
import moduleAlias from 'module-alias';
import path from 'path';

// Register alias for LanceDB
moduleAlias.addAlias('@lancedb/lancedb', path.join(__dirname, '../../../node_modules/@lancedb/lancedb'));

import { StrictMode } from 'react';
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ReactView } from './ReactView';
import { ExampleView, VIEW_TYPE_EXAMPLE } from './ExampleView';

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

export default class HelloWorldPlugin extends Plugin {
	settings: HelloWorldPluginSettings;
	vectorDbPath: string = '';

	async onload() {
		await this.loadSettings();
		await this.initializeVectorDB();

		// Listen for note changes and saves
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				// Check if the modified file is a TFile and is a markdown file (note)
				if (file instanceof TFile && file.extension === 'md') {
					console.log(`Note modified: ${file.path}`);
					console.log(`File name: ${file.name}`);
					console.log(`Last modified: ${new Date(file.stat.mtime).toISOString()}`);
					
					// Process the file for embedding
					await this.processFileForEmbedding(file);
				}
			})
		);

		// Register a new view
		this.registerView(
			VIEW_TYPE_EXAMPLE,
			(leaf) => new ExampleView(leaf)
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
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
