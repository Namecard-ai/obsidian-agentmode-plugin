import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { AgentChatView } from './AgentChatView';
import type AgentPlugin from './main';

export const VIEW_TYPE_AGENT_CHAT = 'obsidian-agent-chat-view';

export class ObsidianAgentChatView extends ItemView {
	root: Root | null = null;
	plugin: AgentPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AgentPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_AGENT_CHAT;
	}

	getDisplayText() {
		return 'Agent';
	}

	getIcon() {
		return 'bot-message-square';
	}

	onOpen() : Promise<void> {
		this.root = createRoot(this.containerEl.children[1]);
		this.root.render(
			<StrictMode>
				<AgentChatView app={this.app} plugin={this.plugin} />
			</StrictMode>
		);
		return Promise.resolve();
	}

	onClose() : Promise<void> {
		this.root?.unmount();
		return Promise.resolve();
	}
}