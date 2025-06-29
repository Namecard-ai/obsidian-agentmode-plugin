import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ReactView } from './ReactView';

export const VIEW_TYPE_AGENT_CHAT = 'obsidian-agent-chat-view';

export class ObsidianAgentChatView extends ItemView {
	root: Root | null = null;
	plugin: any;

	constructor(leaf: WorkspaceLeaf, plugin: any) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_AGENT_CHAT;
	}

	getDisplayText() {
		return 'Agent';
	}

	async onOpen() {
		this.root = createRoot(this.containerEl.children[1]);
		this.root.render(
			<StrictMode>
				<ReactView app={this.app} plugin={this.plugin} />
			</StrictMode>
		);
	}

	async onClose() {
		this.root?.unmount();
	}
}