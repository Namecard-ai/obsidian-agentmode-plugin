import React, { useState, useRef, useEffect, useCallback } from 'react';
import TiptapEditor, { TiptapEditorRef } from './TiptapEditor';
import { FuzzySuggestModal, TFile, App, Notice, setIcon } from 'obsidian';
import MarkdownRenderer from './MarkdownRenderer';
import AgentPlugin from './main';
import {
  ChatMessage,
  Model,
  AgentMode,
  EditConfirmationArgs,
  CreateNoteConfirmationArgs,
} from './main';

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolResult {
  toolCallId: string;
  result: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatHistory {
  id: string;
  title: string;
  messages: Message[];
  timestamp: Date;
}

interface ContextFile {
  id: string;
  file: TFile;
  displayName: string;
}

// Import interfaces from main.ts
interface EditOperation {
  operation: 'insert' | 'delete' | 'replace';
  start_line: number;
  end_line?: number;
  content?: string;
  description: string;
}

interface DiffLine {
  type: 'unchanged' | 'deleted' | 'inserted';
  line_number: number;
  content: string;
}

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

interface PendingCreateNoteConfirmation {
  id: string;
  note_path: string;
  content: string;
  explanation: string;
  toolCallId: string;
  timestamp: Date;
}

interface UploadedImage {
  id: string;
  file: File;
  name: string;
  base64Data: string; // for OpenAI API
  size: number;
}

interface UploadedFile {
  id: string;
  file: File;
  name: string;
  base64Data: string; // for OpenAI API
  size: number;
  type: string; // MIME type
}

interface AIModel {
  id: string;
  name: string;
  supportVision: boolean;
  supportFiles: boolean;
}

interface AgentPluginConstructor {
  IMAGE_EXTENSIONS: string[];
  MIME_TYPES: Record<string, string>;
}

interface ChatCompletionContentPartText {
  type: 'text';
  text: string;
}

interface ChatCompletionContentPartImage {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

interface ChatCompletionContentPartFile {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
}

type ChatCompletionContentPart = 
  | ChatCompletionContentPartText 
  | ChatCompletionContentPartImage 
  | ChatCompletionContentPartFile;

interface UserMessage {
  role: 'user';
  content: string | ChatCompletionContentPart[];
}

interface FuzzySuggestionItem {
  item?: TFile;
}

// Obsidian internal API interfaces (not officially documented)
interface ObsidianWorkspaceInternal {
  [key: string]: unknown;
  dragManager?: unknown;
  fileManager?: unknown;
}

interface FileExplorerView {
  tree?: {
    selectedDoms?: Array<{ file?: TFile }>;
  };
}

// File picker modal using Obsidian's native FuzzySuggestModal
class FilePickerModal extends FuzzySuggestModal<TFile> {
  private onChooseFile: (file: TFile) => void;

  constructor(app: App, onChooseFile: (file: TFile) => void) {
    super(app);
    this.onChooseFile = onChooseFile;
    this.setPlaceholder('Type to search for files...');
    this.setInstructions([
      { command: '↑↓', purpose: 'to navigate' },
      { command: '↵', purpose: 'to select' },
      { command: 'esc', purpose: 'to dismiss' }
    ]);
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseFile(file);
  }

  renderSuggestion(value: FuzzySuggestionItem | TFile, el: HTMLElement): void {
    const file = (value as FuzzySuggestionItem).item || (value as TFile);
    el.createEl('div', { text: file.basename, cls: 'suggestion-title' });
    el.createEl('small', { text: file.path, cls: 'suggestion-note' });
  }
}

const AI_MODELS: AIModel[] = [
  { id: 'o4-mini', name: 'o4-mini', supportVision: true, supportFiles: true },
  { id: 'gpt-4o', name: 'gpt-4o', supportVision: true, supportFiles: true },
  { id: 'gpt-4o-mini', name: 'gpt-4o-mini', supportVision: true, supportFiles: true },
  { id: 'gpt-4.1', name: 'gpt-4.1', supportVision: true, supportFiles: true },
  { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', supportVision: true, supportFiles: true },
  { id: 'gpt-5', name: 'gpt-5', supportVision: true, supportFiles: true },
  { id: 'gpt-5-mini', name: 'gpt-5-mini', supportVision: true, supportFiles: true },
  { id: 'o3', name: 'o3', supportVision: true, supportFiles: true },
  { id: 'o3-mini', name: 'o3-mini', supportVision: false, supportFiles: true },
];

interface AgentChatViewProps {
  app: App;
  plugin: AgentPlugin;
}


// Reusable Icon Button Component
interface IconButtonProps {
  icon: string;
  tooltip: string;
  onClick: () => void;
}

const IconButton: React.FC<IconButtonProps> = ({ icon, tooltip, onClick }) => {
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (buttonRef.current) {
      setIcon(buttonRef.current, icon);
    }
  }, [icon]);

  return (
    <button
      ref={buttonRef}
      title={tooltip}
      onClick={onClick}
      className="agentmode-close-button"
      style={{
        padding: '6px'
      }}
    />
  );
};

// Login prompt component
interface LoginPromptProps {
  plugin: AgentPlugin;
  onLoginClick: () => void;
}

const LoginPrompt: React.FC<LoginPromptProps> = ({ plugin, onLoginClick }) => {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
      padding: '40px 20px',
      backgroundColor: 'var(--background-primary)',
      color: 'var(--text-normal)',
      textAlign: 'center'
    }}>
      <div style={{
        maxWidth: '400px',
        width: '100%'
      }}>
        <div style={{
          fontSize: '48px',
          marginBottom: '20px'
        }}>
          🔐
        </div>

        <h2 style={{
          margin: '0 0 16px 0',
          color: 'var(--text-normal)',
          fontSize: 'var(--font-ui-large)',
          fontWeight: '600'
        }}>
          Login Required
        </h2>

        <p style={{
          margin: '0 0 24px 0',
          color: 'var(--text-muted)',
          lineHeight: '1.5',
          fontSize: 'var(--font-ui-medium)'
        }}>
          You need to log in to your Agentmode account to start chatting with the AI assistant.
          After logging in, you'll have access to all AI features including note editing and search.
        </p>

        <button
          onClick={onLoginClick}
          className="agentmode-interactive-button"
          style={{
            padding: '12px 24px'
          }}
        >
          Start Login
        </button>

        <div style={{
          marginTop: '24px',
          padding: '16px',
          backgroundColor: 'var(--background-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--background-modifier-border)'
        }}>
          <h4 style={{
            margin: '0 0 8px 0',
            fontSize: 'var(--font-ui-small)',
            fontWeight: '600',
            color: 'var(--text-normal)'
          }}>
            Login Method
          </h4>
          <p style={{
            margin: '0',
            fontSize: 'var(--font-ui-smaller)',
            color: 'var(--text-muted)',
            lineHeight: '1.4'
          }}>
            We use secure Device Authorization Flow.
            You'll need to complete authorization in your browser to start using the features.
          </p>
        </div>
      </div>
    </div>
  );
};

export const AgentChatView = ({ app, plugin }: AgentChatViewProps) => {
  const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0].id);
  const [chatMode, setChatMode] = useState<'Ask' | 'Agent'>('Agent');
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string>(generateId());
  const [chatCreatedTimestamp, setChatCreatedTimestamp] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragFileCount, setDragFileCount] = useState(0);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [currentStreamingContent, setCurrentStreamingContent] = useState<string>('');
  const currentStreamingContentRef = useRef<string>('');
  const [expandedToolSessions, setExpandedToolSessions] = useState<Set<string>>(new Set());
  const [expandedToolResults, setExpandedToolResults] = useState<Set<string>>(new Set());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<string>('');
  const [pendingEditConfirmation, setPendingEditConfirmation] = useState<PendingEditConfirmation | null>(null);
  const [pendingCreateNoteConfirmation, setPendingCreateNoteConfirmation] = useState<PendingCreateNoteConfirmation | null>(null);
  const [showRejectReasonInput, setShowRejectReasonInput] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // Add state for wiki link input functionality
  const [pendingWikiLinkPosition, setPendingWikiLinkPosition] = useState<number | null>(null);
  const [viewBackgroundColor, setViewBackgroundColor] = useState('var(--background-primary)');
  const [isLightTheme, setIsLightTheme] = useState(document.body.classList.contains('theme-light'));

  // Add login state monitoring
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(plugin.isLoggedIn());

  const textareaRef = useRef<TiptapEditorRef>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const historySidebarRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLDivElement>(null);

  // Sync ref with state
  useEffect(() => {
    currentStreamingContentRef.current = currentStreamingContent;
  }, [currentStreamingContent]);

  // Sync messages ref with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Handle click outside to close history sidebar
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        showHistory &&
        historySidebarRef.current &&
        historyButtonRef.current &&
        !historySidebarRef.current.contains(event.target as Node) &&
        !historyButtonRef.current.contains(event.target as Node)
      ) {
        setShowHistory(false);
      }
    };

    if (showHistory) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showHistory]);

  useEffect(() => {
    // Set background color based on theme
    const isLight = document.body.classList.contains('theme-light');
    setIsLightTheme(isLight);
    if (isLight) {
      setViewBackgroundColor('#FFFFFF');
    } else {
      setViewBackgroundColor('var(--background-primary)');
    }

    // Optional: Add a mutation observer to watch for theme changes in real-time
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        if (mutation.attributeName === 'class') {
          const isLight = document.body.classList.contains('theme-light');
          setIsLightTheme(isLight);
          if (isLight) {
            setViewBackgroundColor('#FFFFFF');
          } else {
            setViewBackgroundColor('var(--background-primary)');
          }
        }
      });
    });

    observer.observe(document.body, { attributes: true });

    return () => observer.disconnect();
  }, []);

  // Load chat history from disk on mount
  useEffect(() => {
    const loadHistory = async () => {
      const history = await plugin.loadAllHistory();
      setChatHistory(history);
    };
    loadHistory().catch((error) => {
      console.error('Failed to load chat history:', error);
    });
  }, [plugin]);

  // TipTap editor handles auto-resizing internally, so we can remove this
  // Auto-resize textarea utility function
  // const autoResizeTextarea = (textarea: HTMLTextAreaElement) => {
  //   textarea.style.height = 'auto'; // Reset height to recalculate
  //   textarea.style.height = `${textarea.scrollHeight}px`; // Set to content height
  // };

  // useEffect(() => {
  //   if (textareaRef.current) {
  //     autoResizeTextarea(textareaRef.current);
  //   }
  // }, [inputText]);

  // Listen for edit confirmation changes
  useEffect(() => {
    const listener = (confirmation: PendingEditConfirmation | null) => {
      setPendingEditConfirmation(confirmation);
      if (!confirmation) {
        setShowRejectReasonInput(false);
        setRejectReason('');
      }
    };

    plugin.addEditConfirmationListener(listener);

    // Get initial state
    const initialConfirmation = plugin.getPendingEditConfirmation();
    if (initialConfirmation) {
      setPendingEditConfirmation(initialConfirmation);
    }

    return () => {
      plugin.removeEditConfirmationListener(listener);
    };
  }, [plugin]);

  // Listen for create note confirmation changes
  useEffect(() => {
    const listener = (confirmation: PendingCreateNoteConfirmation | null) => {
      setPendingCreateNoteConfirmation(confirmation);
      if (!confirmation) {
        setShowRejectReasonInput(false);
        setRejectReason('');
      }
    };

    plugin.addCreateNoteConfirmationListener(listener);

    // Get initial state
    const initialConfirmation = plugin.getPendingCreateNoteConfirmation();
    if (initialConfirmation) {
      setPendingCreateNoteConfirmation(initialConfirmation);
    }

    return () => {
      plugin.removeCreateNoteConfirmationListener(listener);
    };
  }, [plugin]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Monitor login state changes
  useEffect(() => {
    const checkLoginStatus = () => {
      setIsLoggedIn(plugin.isLoggedIn());
    };

    // Initial check
    checkLoginStatus();

    // Check login status every 5 seconds (in case state changes aren't updated promptly)
    const interval = window.setInterval(checkLoginStatus, 5000);

    return () => window.clearInterval(interval);
  }, [plugin]);

  // Monitor messages changes
  useEffect(() => {
    // Messages state updated
  }, [messages]);

  const toggleToolSession = (messageId: string) => {
    setExpandedToolSessions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  const toggleToolResult = (messageId: string) => {
    setExpandedToolResults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  // Handle starting edit mode for a message
  const handleStartEdit = (message: Message) => {
    setEditingMessageId(message.id);
    setEditingContent(message.content);
  };

  // Handle canceling edit
  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
  };

  // Handle saving edited message and re-sending
  const handleSaveEdit = async (messageId: string) => {
    if (!editingContent.trim()) return;

    // Find the index of the message being edited
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    // Truncate all messages after this one
    const truncatedMessages = messages.slice(0, messageIndex);

    // Create updated message with new content
    const updatedMessage: Message = {
      ...messages[messageIndex],
      content: editingContent.trim(),
      timestamp: new Date()
    };

    // Update messages with truncated list + updated message
    const newMessages = [...truncatedMessages, updatedMessage];
    setMessages(newMessages);

    // Clear editing state
    setEditingMessageId(null);
    setEditingContent('');

    // Re-send from this point
    setIsLoading(true);

    const toolSessionId = generateId();
    setStreamingMessageId(toolSessionId);
    let lastToolCallContent = '';

    // Convert messages to plugin format
    const chatMessages = newMessages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool')
      .map(msg => ({
        role: msg.role,
        content: msg.content,
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
        ...(msg.name && { name: msg.name })
      }));

    try {
      await plugin.streamAgentChat(
        chatMessages,
        contextFiles.map(cf => cf.file),
        selectedModel,
        chatMode,
        (chunk: string) => {
          setCurrentStreamingContent(prev => prev + chunk);
        },
        (toolCall: ToolCall) => {
          const handleToolCall = async () => {
            const currentContent = currentStreamingContentRef.current;
            lastToolCallContent = currentContent;

            const currentMessages = messagesRef.current;
            const newMessages = [...currentMessages];
            const lastMessage = newMessages[newMessages.length - 1];

            let updatedMessages: Message[];

            if (lastMessage &&
              lastMessage.role === 'assistant' &&
              lastMessage.content === currentContent &&
              lastMessage.tool_calls) {
              lastMessage.tool_calls.push(toolCall);
              updatedMessages = newMessages;
            } else {
              const toolCallMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: currentContent,
                timestamp: new Date(),
                tool_calls: [toolCall]
              };
              updatedMessages = [...newMessages, toolCallMessage];
            }

            setMessages(updatedMessages);
            await persistCurrentChat(updatedMessages);
            setCurrentStreamingContent('');
          };

          handleToolCall().catch((error) => {
            console.error('Failed to handle tool call:', error);
            new Notice('Failed to process tool call');
          });
        },
        (finalContent: string) => {
          const handleComplete = async () => {
            if (finalContent) {
              const finalMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: finalContent,
                timestamp: new Date()
              };
              await appendMessage(finalMessage);
            }
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
            setIsLoading(false);
          };

          handleComplete().catch((error) => {
            console.error('Failed to handle completion:', error);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
            setIsLoading(false);
          });
        },
        (error: string) => {
          const handleError = async () => {
            const errorMessage: Message = {
              id: generateId(),
              role: 'assistant',
              content: `Error: ${error}`,
              timestamp: new Date()
            };
            await appendMessage(errorMessage);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
            setIsLoading(false);
          };

          handleError().catch((err) => {
            console.error('Failed to handle error:', err);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
            setIsLoading(false);
          });
        },
        (toolResult: ToolResult) => {
          const handleToolResult = async () => {
            const toolResultMessage: Message = {
              id: generateId(),
              role: 'tool',
              content: toolResult.result,
              timestamp: new Date(),
              tool_call_id: toolResult.toolCallId,
              name: 'tool_result'
            };
            await appendMessage(toolResultMessage);
          };

          handleToolResult().catch((error) => {
            console.error('Failed to handle tool result:', error);
            new Notice('Failed to process tool result');
          });
        }
      );
    } catch (error) {
      console.error('Error re-sending message:', error);
      new Notice('Failed to re-send message');
      setIsLoading(false);
      setStreamingMessageId(null);
    }
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    // Check if there are images but the model doesn't support Vision, give warning
    if (uploadedImages.length > 0 && !currentModelSupportsVision) {
      new Notice(`Current model "${getCurrentModel()?.name}" does not support image analysis. Please select a Vision-capable model (like GPT-4o)`);
      return;
    }

    // Check if there are files but the model doesn't support Files, give warning
    if (uploadedFiles.length > 0 && !currentModelSupportsFiles) {
      new Notice(`Current model "${getCurrentModel()?.name}" does not support file analysis. Please select a file-capable model`);
      return;
    }

    let messageContent = inputText.trim();

    // Add context files information if any are selected
    if (contextFiles.length > 0) {
      const contextInfo = contextFiles.map(cf => `[[${cf.file.path}]]`).join(' ');
      messageContent += `\n\nContext files: ${contextInfo}`;
    }

    // Add image information if any are uploaded
    if (uploadedImages.length > 0) {
      const imageInfo = uploadedImages.map(img => `[Image: ${img.name}]`).join(' ');
      messageContent += `\n\nUploaded images: ${imageInfo}`;
    }

    // Add file information if any are uploaded
    if (uploadedFiles.length > 0) {
      const fileInfo = uploadedFiles.map(file => `[File: ${file.name}]`).join(' ');
      messageContent += `\n\nUploaded files: ${fileInfo}`;
    }

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: messageContent,
      timestamp: new Date()
    };

    await appendMessage(userMessage);
    // Clear the TiptapEditor content
    if (textareaRef.current) {
      textareaRef.current.clear();
    }
    setIsLoading(true);

    // Both Ask and Agent modes now use the same streamAgentChat function
    // The difference is handled internally by the chatMode parameter
    const toolSessionId = generateId();
    setStreamingMessageId(toolSessionId);
    let lastToolCallContent = ''; // Track content before tool calls

    // Convert messages to plugin format - now include tool messages too
    const chatMessages: Array<{
      role: 'user' | 'assistant' | 'tool';
      content: string | ChatCompletionContentPart[];
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      name?: string;
    }> = messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool')
      .map(msg => ({
        role: msg.role,
        content: msg.content,
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
        ...(msg.name && { name: msg.name })
      }));

    // Add the current user message with images and files if any
    const currentUserMessage: UserMessage = {
      role: 'user' as const,
      content: (uploadedImages.length > 0 || uploadedFiles.length > 0) ? [
        {
          type: 'text',
          text: messageContent
        },
        ...uploadedImages.map(img => ({
          type: 'image_url' as const,
          image_url: {
            url: `data:${img.file.type};base64,${img.base64Data}`
          }
        })),
        ...uploadedFiles.map(file => ({
          type: 'file' as const,
          file: {
            filename: file.name,
            file_data: `data:${file.type};base64,${file.base64Data}`
          }
        }))
      ] : messageContent
    };

    chatMessages.push(currentUserMessage);

    // Get context files as TFile objects
    const contextTFiles = contextFiles.map(cf => cf.file);

    try {
      await plugin.streamAgentChat(
        chatMessages as ChatMessage[],
        contextTFiles,
        selectedModel,
        chatMode,
        (chunk: string) => {
          // Handle streaming for assistant response content
          setCurrentStreamingContent(prev => prev + chunk);
        },
        (toolCall: ToolCall) => {
          const handleToolCall = async () => {
            // Handle tool call - accumulate tool calls into a single assistant message
            const currentContent = currentStreamingContentRef.current;
            lastToolCallContent = currentContent;

            // Use messagesRef to get current messages
            const currentMessages = messagesRef.current;
            const newMessages = [...currentMessages];
            const lastMessage = newMessages[newMessages.length - 1];

            let updatedMessages: Message[];

            // If the last message is an assistant message with the same content, add this tool call to it
            if (lastMessage &&
              lastMessage.role === 'assistant' &&
              lastMessage.content === currentContent &&
              lastMessage.tool_calls) {
              lastMessage.tool_calls.push(toolCall);
              updatedMessages = newMessages;
            } else {
              // Create new assistant message with this tool call
              const toolCallMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: currentContent,
                timestamp: new Date(),
                tool_calls: [toolCall]
              };
              updatedMessages = [...newMessages, toolCallMessage];
            }

            // Update state
            setMessages(updatedMessages);

            // Persist after updating messages
            await persistCurrentChat(updatedMessages);

            setCurrentStreamingContent(''); // Reset for new content after tool call
          };

          handleToolCall().catch((error) => {
            console.error('Failed to handle tool call:', error);
            new Notice('Failed to process tool call');
          });
        },
        (finalContent: string) => {
          const handleComplete = async () => {
            // Handle completion - create final message with complete content from main.ts
            if (finalContent) {
              const finalMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: finalContent,
                timestamp: new Date()
              };

              await appendMessage(finalMessage);
            }

            // Use setTimeout to ensure the message is rendered before clearing states
            window.setTimeout(() => {
              setIsLoading(false);
              setStreamingMessageId(null);
              setCurrentStreamingContent('');
            }, 50); // Small delay to ensure rendering
          };

          handleComplete().catch((error) => {
            console.error('Failed to handle completion:', error);
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          });
        },
        (error: string) => {
          const handleError = async () => {
            // Handle error
            console.error(`${chatMode} chat error:`, error);

            const errorMessage: Message = {
              id: generateId(),
              role: 'assistant',
              content: currentStreamingContentRef.current + `\n\n❌ Error: ${error}`,
              timestamp: new Date()
            };
            await appendMessage(errorMessage);

            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          };

          handleError().catch((err) => {
            console.error('Failed to handle error:', err);
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          });
        },
        (toolResult: { toolCallId: string; result: string }) => {
          const handleToolResult = async () => {
            // Handle tool result - add as tool message
            const toolResultMessage: Message = {
              id: generateId(),
              role: 'tool',
              content: toolResult.result,
              timestamp: new Date(),
              tool_call_id: toolResult.toolCallId
            };

            await appendMessage(toolResultMessage);

            // Add UI notification for Ask Mode auto-rejection
            if (chatMode === 'Ask' && toolResult.result.includes("I'm currently in Ask Mode")) {
              // Show a subtle notification that editing was blocked
            }
          };

          handleToolResult().catch((error) => {
            console.error('Failed to handle tool result:', error);
            new Notice('Failed to process tool result');
          });
        },
        () => {
          const handleInterruption = async () => {
            // Handle interruption
            const interruptedMessage: Message = {
              id: generateId(),
              role: 'assistant',
              content: '❌ Chat interrupted',
              timestamp: new Date()
            };
            await appendMessage(interruptedMessage);
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          };

          handleInterruption().catch((error) => {
            console.error('Failed to handle interruption:', error);
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          });
        }
      );
    } catch (error) {
      console.error(`Error starting ${chatMode.toLowerCase()} chat:`, error);

      const errorMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `❌ Error: ${error.message || 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      await appendMessage(errorMessage);

      setIsLoading(false);
      setStreamingMessageId(null);
      setCurrentStreamingContent('');
    }
  };

  const handleStopChat = () => {
    if (plugin && isLoading) {
      plugin.stopCurrentChat();
    }
  };

  const handleNewChat = () => {
    // Clear current chat and start new one
    setMessages([]);
    setContextFiles([]);
    setUploadedImages([]);
    setUploadedFiles([]);
    setCurrentChatId(generateId());
    setChatCreatedTimestamp(null);
  };

  const loadChatFromHistory = (chat: ChatHistory) => {
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
    setChatCreatedTimestamp(chat.timestamp);
    setContextFiles([]);
    setUploadedImages([]);
    setUploadedFiles([]);
    setShowHistory(false);
  };

  const persistCurrentChat = async (messagesSnapshot?: Message[]) => {
    const messagesToPersist = messagesSnapshot || messages;

    if (messagesToPersist.length === 0 || !currentChatId) {
      return;
    }

    const isFirstPersist = chatCreatedTimestamp === null;
    const timestamp = isFirstPersist ? new Date() : chatCreatedTimestamp!;

    if (isFirstPersist) {
      setChatCreatedTimestamp(timestamp);
    }

    const chatTitle = messagesToPersist[0]?.content.slice(0, 50) + (messagesToPersist[0]?.content.length > 50 ? '...' : '');
    const chatEntry: ChatHistory = {
      id: currentChatId,
      title: chatTitle,
      messages: [...messagesToPersist],
      timestamp: timestamp
    };

    // Save to disk
    await plugin.saveHistoryEntry(chatEntry, isFirstPersist);

    // Update chatHistory state
    setChatHistory(prev => {
      const existingIndex = prev.findIndex(chat => chat.id === currentChatId);
      if (existingIndex !== -1) {
        // Update existing entry
        const newHistory = [...prev];
        newHistory[existingIndex] = chatEntry;
        return newHistory;
      } else {
        // Add new entry
        return [chatEntry, ...prev];
      }
    });
  };

  const appendMessage = async (message: Message) => {
    // Use ref to get the most current messages
    const currentMessages = messagesRef.current;
    const newMessages = [...currentMessages, message];

    // Update state
    setMessages(newMessages);

    // Persist with the updated messages
    await persistCurrentChat(newMessages);
  };

  const handleDeleteHistoryEntry = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent loading the chat when clicking delete

    // Show confirmation dialog
    const confirmed = window.confirm('Are you sure you want to delete this chat from history?');
    if (!confirmed) return;

    // Delete from disk
    await plugin.deleteHistoryEntry(id);

    // Update local state
    setChatHistory(prev => prev.filter(chat => chat.id !== id));
  };

  const handleClearAllHistory = async () => {
    // Show confirmation dialog with warning
    const confirmed = window.confirm('Are you sure you want to clear ALL chat history? This action cannot be undone.');
    if (!confirmed) return;

    // Clear from disk
    await plugin.clearAllHistory();

    // Update local state
    setChatHistory([]);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage().catch((error) => {
        console.error('Failed to send message:', error);
      });
    } else if (e.key === '[' && textareaRef.current) {
      // Check if this is the second [ to trigger wiki link input
      // Get the character immediately before the cursor from the TipTap editor
      const charBeforeCursor = textareaRef.current.getTextBeforeCursor(1);

      // Check if the previous character is also [
      if (charBeforeCursor === '[') {
        // This will be the second [, prevent it from being inserted and trigger file selection
        e.preventDefault(); // Prevent the second [ from being inserted

        const cursorPos = textareaRef.current.getCursorPosition();
        // The first [ should be at cursorPos - 1
        const bracketStartPos = cursorPos - 1;
        setPendingWikiLinkPosition(bracketStartPos);
        handleWikiLinkInput(bracketStartPos);
      }
    }
  };

  // Check if current model supports Vision and Files
  const getCurrentModel = () => AI_MODELS.find(model => model.id === selectedModel);
  const currentModelSupportsVision = getCurrentModel()?.supportVision || false;
  const currentModelSupportsFiles = getCurrentModel()?.supportFiles || false;

  const handleImageUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileUpload = () => {
    fileUploadInputRef.current?.click();
  };

  const handleImageFileDrop = async (file: TFile) => {
    try {
      const maxSize = 50 * 1024 * 1024; // 50MB

      // Check file size
      if (file.stat.size > maxSize) {
        new Notice(`File "${file.name}" exceeds 50MB size limit`);
        return;
      }

      // Check if already uploaded
      if (uploadedImages.some(img => img.name === file.name && img.size === file.stat.size)) {
        new Notice(`Image "${file.name}" has already been uploaded`);
        return;
      }

      // Read file as binary and convert to base64
      const arrayBuffer = await app.vault.readBinary(file);
      const uint8Array = new Uint8Array(arrayBuffer);

      // Convert to base64 safely (handle large files)
      let binaryString = '';
      const chunkSize = 8192;

      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        binaryString += String.fromCharCode(...chunk);
      }

      const base64Data = btoa(binaryString);
      const fileExtension = file.extension.toLowerCase();
      const mimeType = (plugin.constructor as unknown as AgentPluginConstructor).MIME_TYPES[fileExtension] || 'application/octet-stream';

      // Create File object for compatibility with existing upload logic
      const fileObj = new File([arrayBuffer], file.name, { type: mimeType });

      const uploadedImage: UploadedImage = {
        id: generateId(),
        file: fileObj,
        name: file.name,
        base64Data: base64Data,
        size: file.stat.size
      };

      setUploadedImages(prev => [...prev, uploadedImage]);
      new Notice(`Image "${file.name}" uploaded successfully`);
    } catch (error) {
      console.error('Error processing dropped image:', error);
      new Notice(`Error processing image "${file.name}"`);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    let hasImage = false;

    // First, check if there are any images in the clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        hasImage = true;
        break;
      }
    }

    // If there are images, prevent default paste behavior and only process images
    if (hasImage) {
      e.preventDefault();
    }

    // Collect all valid images first, then process them
    const validImages: Array<{ file: File, filename: string }> = [];
    const processedFilenames = new Set<string>(); // Track filenames in current batch

    // Process all clipboard items to collect valid images
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Check if it's an image
      if (item.type.startsWith('image/')) {
        try {
          const file = item.getAsFile();
          if (!file) continue;

          // Get file extension from MIME type
          const mimeToExtension: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp'
          };

          const fileExtension = mimeToExtension[item.type];

          // Check if extension is supported
          if (!fileExtension || !(plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
            const supportedFormats = (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.join(', ').toUpperCase();
            new Notice(`Pasted image format "${item.type}" is not supported. Supported formats: ${supportedFormats}`);
            continue;
          }

          // Check file size (50MB limit)
          const maxSize = 50 * 1024 * 1024;
          if (file.size > maxSize) {
            new Notice(`Pasted image exceeds 50MB size limit`);
            continue;
          }

          // Try to use original filename, fallback to generated name
          let filename: string;
          if (file.name && file.name.trim() !== '' && file.name !== 'image.png' && file.name !== 'image.jpg') {
            // Use original filename if available and not a generic name
            filename = file.name;

            // Handle duplicate filenames in current batch
            let counter = 1;
            let originalFilename = filename;
            while (processedFilenames.has(filename)) {
              const nameWithoutExt = originalFilename.substring(0, originalFilename.lastIndexOf('.'));
              const ext = originalFilename.substring(originalFilename.lastIndexOf('.'));
              filename = `${nameWithoutExt}_${counter}${ext}`;
              counter++;
            }
          } else {
            // Generate filename with timestamp as fallback
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            filename = `pasted-image-${timestamp}-${i}.${fileExtension}`;
          }

          // Check if already uploaded in existing images
          const existingImage = uploadedImages.find(img => {
            if (filename.startsWith('pasted-image-')) {
              // For generated names, check by size and recent time
              const timeMatch = img.name.match(/pasted-image-(.+)\./);
              if (timeMatch) {
                const imgTime = new Date(timeMatch[1].replace(/-/g, ':'));
                return img.size === file.size && Math.abs(Date.now() - imgTime.getTime()) < 5000;
              }
              return img.size === file.size;
            } else {
              // For original filenames, check by exact name and size
              return img.name === filename && img.size === file.size;
            }
          });

          if (existingImage) {
            new Notice(`Image "${filename}" has already been uploaded`);
            continue;
          }

          validImages.push({ file, filename });
          processedFilenames.add(filename);

        } catch (error) {
          console.error('Error processing pasted image:', error);
          new Notice(`Error processing pasted image`);
        }
      }
    }

    // Now process all valid images and convert them
    const newUploadedImages: UploadedImage[] = [];

    for (const { file, filename } of validImages) {
      try {
        // Convert to base64
        const base64Data = await fileToBase64(file);

        // Create new File object with proper name
        const renamedFile = new File([file], filename, { type: file.type });

        const uploadedImage: UploadedImage = {
          id: generateId(),
          file: renamedFile,
          name: filename,
          base64Data: base64Data,
          size: file.size
        };

        newUploadedImages.push(uploadedImage);
        new Notice(`Image "${filename}" uploaded successfully`);

      } catch (error) {
        console.error('Error processing pasted image:', error);
        new Notice(`Error processing image "${filename}"`);
      }
    }

    // Add all new images at once
    if (newUploadedImages.length > 0) {
      setUploadedImages(prev => [...prev, ...newUploadedImages]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const maxSize = 50 * 1024 * 1024; // 50MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check file type using IMAGE_EXTENSIONS from main.ts
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      const isImageSupported = fileExtension && (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension);

      if (!isImageSupported) {
        const supportedFormats = (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.join(', ').toUpperCase();
        new Notice(`File "${file.name}" is not a supported image format. Supported formats: ${supportedFormats}`);
        continue;
      }

      // Check file size
      if (file.size > maxSize) {
        new Notice(`File "${file.name}" exceeds 50MB size limit`);
        continue;
      }

      // Check if already uploaded
      if (uploadedImages.some(img => img.name === file.name && img.size === file.size)) {
        new Notice(`Image "${file.name}" has already been uploaded`);
        continue;
      }

      try {
        // Convert image to base64
        const base64Data = await fileToBase64(file);

        const uploadedImage: UploadedImage = {
          id: generateId(),
          file: file,
          name: file.name,
          base64Data: base64Data,
          size: file.size
        };

        setUploadedImages(prev => [...prev, uploadedImage]);
        new Notice(`Image "${file.name}" uploaded successfully`);
      } catch (error) {
        console.error('Error processing image:', error);
        new Notice(`Error processing image "${file.name}"`);
      }
    }

    // Clear input value to allow selecting the same file again
    e.target.value = '';
  };

  // Convert file to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // Remove data:image/...;base64, prefix, keep only base64 content
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        } else {
          reject(new Error('Failed to read file as base64'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  };

  const removeUploadedImage = (imageId: string) => {
    setUploadedImages(prev => prev.filter(img => img.id !== imageId));
  };

  const handleFileUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const supportedTypes = ['application/pdf'];
    const maxSize = 32 * 1024 * 1024; // 32MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check file type
      if (!supportedTypes.includes(file.type)) {
        new Notice(`File "${file.name}" is not a supported file format. Supported formats: PDF`);
        continue;
      }

      // Check file size
      if (file.size > maxSize) {
        new Notice(`File "${file.name}" exceeds 32MB size limit`);
        continue;
      }

      // Check if already uploaded
      if (uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
        new Notice(`File "${file.name}" has already been uploaded`);
        continue;
      }

      try {
        // Convert file to base64
        const base64Data = await fileToBase64(file);

        const uploadedFile: UploadedFile = {
          id: generateId(),
          file: file,
          name: file.name,
          base64Data: base64Data,
          size: file.size,
          type: file.type
        };

        setUploadedFiles(prev => [...prev, uploadedFile]);
        new Notice(`File "${file.name}" uploaded successfully`);
      } catch (error) {
        console.error('Error processing file:', error);
        new Notice(`Error processing file "${file.name}"`);
      }
    }

    // Clear input value to allow selecting the same file again
    e.target.value = '';
  };

  const removeUploadedFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
  };

  // Set up drag and drop event listeners for better Obsidian integration
  useEffect(() => {
    const chatContainer = chatContainerRef.current;
    if (!chatContainer) return;

    const handleNativeDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    };

    const handleNativeDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Check if we're really leaving the container
      if (!chatContainer.contains(e.relatedTarget as Node)) {
        setIsDragOver(false);
        setDragFileCount(0);
      }
    };

    const handleNativeDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      setDragFileCount(0);

      // Handle Obsidian's native file drag data
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const filePromises = Array.from(files).map(async (file) => {
          const abstractFile = app.vault.getAbstractFileByPath(file.name);
          if (abstractFile && abstractFile instanceof TFile) {
            const fileExtension = abstractFile.extension.toLowerCase();

            // Check if it's an image file
            if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
              await handleImageFileDrop(abstractFile);
            }
            // Check if file is supported by read_file tool
            else if (plugin.isFileSupportedByReadTool(abstractFile)) {
              addContextFile(abstractFile);
            }
          }
        });
        await Promise.all(filePromises);
        return;
      }

      // Try different data transfer formats
      const dataTypes = ['text/plain', 'text/uri-list', 'application/json', 'text/html'];
      let filesAdded = 0;

      for (const type of dataTypes) {
        const data = e.dataTransfer?.getData(type);
        if (data) {
          // Parse multiple files from the data
          let filePaths: string[] = [];

          if (type === 'text/plain' || type === 'text/uri-list') {
            // Handle Obsidian URI format: obsidian://open?vault=VaultName&file=FileName
            const obsidianUriRegex = /obsidian:\/\/open\?vault=[^&]+&file=([^\s\n]+)/g;
            let match;
            while ((match = obsidianUriRegex.exec(data)) !== null) {
              filePaths.push(decodeURIComponent(match[1]));
            }

            // If no Obsidian URIs found, try splitting by newlines or other separators
            if (filePaths.length === 0) {
              filePaths = data.split(/[\n\r]+/).filter(path => path.trim().length > 0);
            }
          } else {
            // For other types, try splitting by common separators
            filePaths = data.split(/[\n\r,;]+/).filter(path => path.trim().length > 0);
          }

          // Process each file path
          for (const filePath of filePaths) {
            const cleanPath = filePath.trim();
            if (!cleanPath) continue;

            // Try to find file by exact path
            let abstractFile = app.vault.getAbstractFileByPath(cleanPath);
            if (abstractFile && abstractFile instanceof TFile) {
              const fileExtension = abstractFile.extension.toLowerCase();

              // Check if it's an image file
              if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                await handleImageFileDrop(abstractFile);
                filesAdded++;
                continue;
              }
              // Check if file is supported by read_file tool
              else if (plugin.isFileSupportedByReadTool(abstractFile)) {
                addContextFile(abstractFile);
                filesAdded++;
                continue;
              }
            }

            // Try with different path variations
            const pathVariations = [
              cleanPath,
              cleanPath.replace(/^\/+/, ''), // Remove leading slashes
              cleanPath.replace(/\\/g, '/'), // Convert backslashes to forward slashes
              cleanPath + '.md', // Add .md extension
              cleanPath.replace(/\.md$/, '') + '.md' // Ensure .md extension
            ];

            for (const path of pathVariations) {
              abstractFile = app.vault.getAbstractFileByPath(path);
              if (abstractFile && abstractFile instanceof TFile) {
                const fileExtension = abstractFile.extension.toLowerCase();

                // Check if it's an image file
                if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                  handleImageFileDrop(abstractFile).catch(error => {
                    console.error('Error handling dropped image:', error);
                  });
                  filesAdded++;
                  break;
                }
                // Check if file is supported by read_file tool
                else if (plugin.isFileSupportedByReadTool(abstractFile)) {
                  addContextFile(abstractFile);
                  filesAdded++;
                  break;
                }
              }
            }

            if (abstractFile && abstractFile instanceof TFile) {
              const fileExtension = abstractFile.extension.toLowerCase();
              if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension) ||
                plugin.isFileSupportedByReadTool(abstractFile)) {
                continue;
              }
            }

            // Try to find by basename in all supported files
            const allFiles = app.vault.getFiles();
            const foundFile = allFiles.find(f => {
              const fileExtension = f.extension.toLowerCase();
              const isImage = (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension);
              const isReadable = plugin.isFileSupportedByReadTool(f);

              if (!isImage && !isReadable) return false;

              return f.basename === cleanPath ||
                f.name === cleanPath ||
                f.path.endsWith('/' + cleanPath) ||
                f.path.endsWith('\\' + cleanPath) ||
                cleanPath.includes(f.basename);
            });

            if (foundFile) {
              const fileExtension = foundFile.extension.toLowerCase();

              // Check if it's an image file
              if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                handleImageFileDrop(foundFile).catch(error => {
                  console.error('Error handling dropped image:', error);
                });
                filesAdded++;
              }
              // Otherwise add as context file
              else if (plugin.isFileSupportedByReadTool(foundFile)) {
                addContextFile(foundFile);
                filesAdded++;
              }
            }
          }

          // If we found files in this data type, we can stop trying other types
          if (filesAdded > 0) {
            break;
          }
        }
      }

      if (filesAdded === 0) {
        // Try to access Obsidian's internal drag state
        try {
          const workspace = app.workspace as unknown as ObsidianWorkspaceInternal;

          // Try multiple ways to access dragged files
          const possiblePaths = [
            'dragManager.draggedFiles',
            'dragManager.dragging',
            'dragManager.currentDrag',
            'fileManager.draggedFiles',
            'vault.draggedFiles'
          ];

          for (const path of possiblePaths) {
            const parts = path.split('.');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let obj: any = workspace;
            for (const part of parts) {
              obj = obj?.[part];
            }

            if (obj) {
              if (Array.isArray(obj)) {
                const objPromises = obj.map(async (file: TFile) => {
                  if (file) {
                    const fileExtension = file.extension?.toLowerCase();

                    // Check if it's an image file
                    if (fileExtension && (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                      await handleImageFileDrop(file);
                      return true;
                    }
                    // Check if file is supported by read_file tool
                    else if (plugin.isFileSupportedByReadTool(file)) {
                      addContextFile(file);
                      return true;
                    }
                  }
                  return false;
                });
                const results = await Promise.all(objPromises);
                filesAdded += results.filter(Boolean).length;
              } else if (obj) {
                const fileExtension = obj.extension?.toLowerCase();

                // Check if it's an image file
                if (fileExtension && (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                  await handleImageFileDrop(obj);
                  filesAdded++;
                }
                // Check if file is supported by read_file tool
                else if (plugin.isFileSupportedByReadTool(obj)) {
                  addContextFile(obj);
                  filesAdded++;
                }
              }
            }
          }

          // Also try to get the currently selected files from file explorer
          const fileExplorer = app.workspace.getLeavesOfType('file-explorer')[0];
          if (fileExplorer && fileExplorer.view && filesAdded === 0) {
            const view = fileExplorer.view as unknown as FileExplorerView;

            // Try to get selected files
            if (view.tree && view.tree.selectedDoms) {
              const domPromises = view.tree.selectedDoms.map(async (dom: { file?: TFile }) => {
                if (dom.file) {
                  const fileExtension = dom.file.extension?.toLowerCase();

                  // Check if it's an image file
                  if (fileExtension && (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                    await handleImageFileDrop(dom.file);
                    return true;
                  }
                  // Check if file is supported by read_file tool
                  else if (plugin.isFileSupportedByReadTool(dom.file)) {
                    addContextFile(dom.file);
                    return true;
                  }
                }
                return false;
              });
              const results = await Promise.all(domPromises);
              filesAdded += results.filter(Boolean).length;
            }
          }
        } catch (error) {
          console.error('Could not access internal drag state:', error);
        }
      }

      if (filesAdded === 0) {
        // Final fallback: try to parse any text data as a file path
        const allDataTypes = Array.from(e.dataTransfer?.types || []);

        for (const type of allDataTypes) {
          try {
            const data = e.dataTransfer?.getData(type);
            if (data && typeof data === 'string') {
              // Try to find any supported file that matches
              const allFiles = app.vault.getFiles();
              const matchingFile = allFiles.find(file => {
                const fileExtension = file.extension.toLowerCase();
                const isImage = (plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension);
                const isReadable = plugin.isFileSupportedByReadTool(file);

                if (!isImage && !isReadable) return false;

                return data.includes(file.basename) ||
                  data.includes(file.name) ||
                  data.includes(file.path) ||
                  file.path.includes(data) ||
                  file.basename.includes(data);
              });

              if (matchingFile) {
                const fileExtension = matchingFile.extension.toLowerCase();

                // Check if it's an image file
                if ((plugin.constructor as unknown as AgentPluginConstructor).IMAGE_EXTENSIONS.includes(fileExtension)) {
                  handleImageFileDrop(matchingFile).catch(error => {
                    console.error('Error handling dropped image:', error);
                  });
                  filesAdded++;
                  break;
                }
                // Otherwise add as context file
                else if (plugin.isFileSupportedByReadTool(matchingFile)) {
                  addContextFile(matchingFile);
                  filesAdded++;
                  break;
                }
              }
            }
          } catch (error) {
            console.error(`Error processing type "${type}":`, error);
          }
        }
      }
    };

    // Add native event listeners for better compatibility
    chatContainer.addEventListener('dragover', handleNativeDragOver);
    chatContainer.addEventListener('dragleave', handleNativeDragLeave);
    chatContainer.addEventListener('drop', handleNativeDrop);

    return () => {
      chatContainer.removeEventListener('dragover', handleNativeDragOver);
      chatContainer.removeEventListener('dragleave', handleNativeDragLeave);
      chatContainer.removeEventListener('drop', handleNativeDrop);
    };
  }, [app]);

  const handleAddContext = () => {
    const modal = new FilePickerModal(app, addContextFile);
    modal.open();
  };

  const removeContextFile = (fileId: string) => {
    setContextFiles(prev => prev.filter(cf => cf.id !== fileId));
  };

  const addContextFile = (file: TFile) => {
    // Check if file is already added
    if (contextFiles.some(cf => cf.file.path === file.path)) {
      return;
    }

    // Add wikilink to input text if this is a vault file
    if (file && file.path) {
      const wikilink = `[[${file.path}]]`;
      setInputText(prev => {
        // Add wikilink at the end, with a space before if text exists
        const separator = prev.trim() ? ' ' : '';
        return prev + separator + wikilink;
      });
    }

    const contextFile: ContextFile = {
      id: generateId(),
      file: file,
      displayName: file.basename
    };

    setContextFiles(prev => [...prev, contextFile]);
  };

  // Edit confirmation handlers
  const handleAcceptEdit = () => {
    plugin.acceptEditConfirmation();
  };

  const handleRejectEdit = () => {
    if (showRejectReasonInput) {
      plugin.rejectEditConfirmation(rejectReason.trim() || undefined);
    } else {
      setShowRejectReasonInput(true);
    }
  };

  const handleCancelReject = () => {
    setShowRejectReasonInput(false);
    setRejectReason('');
  };

  // Handle login button click
  const handleLoginClick = async () => {
    try {
      await plugin.startLogin();
      // Login state will be automatically updated through useEffect
    } catch (error: unknown) {
      console.error('Login failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      new Notice(`Login failed: ${errorMessage}`);
    }
  };

  // Create note confirmation handlers
  const handleAcceptCreateNote = () => {
    plugin.acceptCreateNoteConfirmation();
  };

  const handleRejectCreateNote = () => {
    if (showRejectReasonInput) {
      plugin.rejectCreateNoteConfirmation(rejectReason.trim() || undefined);
    } else {
      setShowRejectReasonInput(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);

    // Try to count markdown files being dragged
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const mdFiles = Array.from(files).filter(file => file.name.endsWith('.md'));
      setDragFileCount(mdFiles.length);
    } else {
      setDragFileCount(1); // Default to 1 if we can't determine
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragOver to false if we're leaving the chat container entirely
    if (chatContainerRef.current && !chatContainerRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDragFileCount(0);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDragFileCount(0);

    // Let the native handler take care of this
    // This prevents duplicate handling
  };

  const renderMessage = (message: Message) => {
    const isUser = message.role === 'user';
    const isStreaming = streamingMessageId === message.id;
    const isToolResult = message.role === 'tool';
    const isToolResultExpanded = expandedToolResults.has(message.id);
    const isEditing = editingMessageId === message.id;

    // Calculate how many messages will be deleted if this message is edited
    const messageIndex = messages.findIndex(msg => msg.id === message.id);
    const messagesAfterCount = messageIndex >= 0 ? messages.length - messageIndex - 1 : 0;

    return (
      <div
        key={message.id}
        className={`message ${isUser ? 'user' : 'assistant'} ${isEditing ? 'editing' : ''}`}
        style={{
          width: '100%',
          // marginBottom is removed for a more document-like flow
        }}
      >
        <div
          style={{
            width: '100%',
            padding: '8px 0', // Vertical padding only
            backgroundColor: 'transparent', // No more bubbles
            color: 'var(--text-normal)', // Inherit text color
            border: 'none',
            position: 'relative',
          }}
        >
          {/* Message type indicator */}
          <div
            className={isToolResult ? 'agentmode-tool-result-header' : ''}
            style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              marginBottom: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              opacity: 0.8,
              cursor: isToolResult ? 'pointer' : 'default',
              userSelect: 'none',
              padding: isToolResult ? '4px' : '0',
              margin: isToolResult ? '-4px' : '0',
              transition: 'background-color 0.2s ease'
            }}
            onClick={isToolResult ? () => toggleToolResult(message.id) : undefined}
          >
            <span style={{
              fontSize: '14px',
              minWidth: '20px'
            }}>
              {isUser ? '👤' : message.role === 'tool' ? '🔧' : '🤖'}
            </span>
            <span style={{ fontWeight: '500' }}>
              {isUser
                ? 'You'
                : message.role === 'tool'
                  ? 'Tool Result'
                  : message.tool_calls
                    ? `Assistant (calling: ${message.tool_calls.map(tc => tc.function.name).join(', ')})`
                    : 'Assistant'
              }
            </span>
            {/* Ask Mode auto-rejection indicator */}
            {isToolResult && message.content.includes("I'm currently in Ask Mode") && (
              <span style={{
                fontSize: '11px',
                backgroundColor: 'var(--interactive-error)',
                color: 'var(--text-on-accent)',
                padding: '2px 6px',
                borderRadius: '10px',
                fontWeight: '500',
                marginLeft: '8px'
              }}>
                🚫 Ask Mode Blocked
              </span>
            )}
            {isToolResult && (
              <span style={{
                fontSize: '12px',
                marginLeft: 'auto',
                transform: isToolResultExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease'
              }}>
                ▶
              </span>
            )}
          </div>

          {/* Main message content */}
          {isToolResult ? (
            <div>
              {/* Tool result summary (always visible) */}
              <div style={{
                fontSize: '13px',
                color: 'var(--text-muted)',
                marginBottom: '8px',
                fontStyle: 'italic'
              }}>
                Click to expand detailed results ({message.content.length} characters)
              </div>

              {/* Collapsible content */}
              {isToolResultExpanded && (
                <div style={{
                  backgroundColor: 'var(--background-secondary)',
                  border: '1px solid var(--background-modifier-border)',
                  borderRadius: '6px',
                  padding: '12px',
                  marginTop: '8px',
                  fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                  fontSize: '13px',
                  lineHeight: '1.4',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                  MozUserSelect: 'text',
                  msUserSelect: 'text',
                  color: 'var(--text-normal)',
                }}>
                  {message.content}
                </div>
              )}
            </div>
          ) : isEditing ? (
            // Edit mode for user messages
            <div>
              <textarea
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  minHeight: '80px',
                  padding: '8px',
                  backgroundColor: 'var(--background-secondary)',
                  border: '1px solid var(--background-modifier-border)',
                  borderRadius: '6px',
                  color: 'var(--text-normal)',
                  fontFamily: 'inherit',
                  fontSize: '14px',
                  lineHeight: '1.5',
                  resize: 'vertical',
                  outline: 'none',
                }}
                onFocus={(e) => {
                  e.target.style.border = '1px solid var(--interactive-accent)';
                }}
                onBlur={(e) => {
                  e.target.style.border = '1px solid var(--background-modifier-border)';
                }}
              />

              {/* Warning about deleted messages */}
              {messagesAfterCount > 0 && (
                <div style={{
                  fontSize: '12px',
                  color: 'var(--text-warning)',
                  marginTop: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}>
                  <span>⚠️</span>
                  <span>Will delete {messagesAfterCount} message{messagesAfterCount > 1 ? 's' : ''} below</span>
                </div>
              )}

              {/* Action buttons */}
              <div style={{
                display: 'flex',
                gap: '8px',
                marginTop: '12px',
              }}>
                <button
                  onClick={() => handleSaveEdit(message.id)}
                  disabled={!editingContent.trim()}
                  style={{
                    padding: '6px 16px',
                    backgroundColor: editingContent.trim() ? 'var(--interactive-accent)' : 'var(--background-modifier-border)',
                    color: editingContent.trim() ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: editingContent.trim() ? 'pointer' : 'not-allowed',
                    fontWeight: '500',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>📤</span>
                  <span>Send</span>
                </button>
                <button
                  onClick={handleCancelEdit}
                  style={{
                    padding: '6px 16px',
                    backgroundColor: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <span>❌</span>
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              userSelect: 'text',
              WebkitUserSelect: 'text',
              MozUserSelect: 'text',
              msUserSelect: 'text',
            }}>
              {/* Choose rendering method based on message type */}
              {message.role === 'assistant' ? (
                <MarkdownRenderer
                  content={message.content}
                  style={{
                    lineHeight: '1.5'
                  }}
                  plugin={plugin}
                />
              ) : (
                <div style={{
                  whiteSpace: 'pre-wrap',
                  lineHeight: '1.5'
                }}>
                  {message.content}
                </div>
              )}
              {isStreaming && (
                <span className="agentmode-streaming-cursor" style={{
                  display: 'inline-block',
                  width: '2px',
                  height: '20px',
                  backgroundColor: 'var(--interactive-accent)',
                  marginLeft: '2px',
                  animation: 'blink 1s infinite',
                }} />
              )}
            </div>
          )}

          {/* Timestamp and Edit Button */}
          {!isEditing && (
            <div style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              opacity: 0.7,
              marginTop: '4px',
              textAlign: isUser ? 'right' : 'left',
              display: 'flex',
              alignItems: 'center',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
              gap: '8px',
            }}>
              <span>{message.timestamp.toLocaleTimeString()}</span>

              {/* Edit button for user messages */}
              {isUser && !isLoading && !streamingMessageId && (
                <button
                  onClick={() => handleStartEdit(message)}
                  className="agentmode-message-edit-button"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    opacity: 0,
                    transition: 'opacity 0.2s ease, background-color 0.2s ease',
                    color: 'var(--text-muted)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  title="Edit message"
                >
                  ✏️
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };


  // Handle [[ input detection and file selection
  const handleWikiLinkInput = (bracketStartPosition: number) => {
    const modal = new FilePickerModal(app, (file: TFile) => {
      const relativePath = file.path;

      if (textareaRef.current) {
        // Replace the single [ with the wikilink mention
        // Since we prevented the second [ from being inserted, we only need to replace 1 character
        window.setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.replaceRangeWithWikilink(
              bracketStartPosition,
              bracketStartPosition + 1, // Only replace 1 character now
              relativePath
            );
          }
        }, 10);
      }

      setPendingWikiLinkPosition(null);
    });
    modal.open();
  };


  // If not logged in, show login prompt
  if (!isLoggedIn) {
    return (
      <LoginPrompt
        plugin={plugin}
        onLoginClick={handleLoginClick}
      />
    );
  }

  return (
    <div
      ref={chatContainerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: viewBackgroundColor,
        color: 'var(--text-normal)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        position: 'relative'
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end', // Align buttons to the right
        padding: '8px', // Reduced padding
        borderBottom: '1px solid var(--background-modifier-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <IconButton
            icon="plus"
            tooltip="New chat"
            onClick={handleNewChat}
          />
          <div ref={historyButtonRef}>
            <IconButton
              icon="history"
              tooltip="History"
              onClick={() => setShowHistory(!showHistory)}
            />
          </div>
          <IconButton
            icon="image"
            tooltip="Upload image"
            onClick={handleImageUpload}
          />
          <IconButton
            icon="paperclip"
            tooltip="Upload file"
            onClick={handleFileUpload}
          />
          <IconButton
            icon="link"
            tooltip="Add context"
            onClick={handleAddContext}
          />
        </div>
      </div>

      {/* History Sidebar */}
      {showHistory && (
        <div ref={historySidebarRef} className="agentmode-chat-history-sidebar">
          <div className="agentmode-chat-history-header">
            <h3 className="agentmode-chat-history-title">Chat History</h3>
            {chatHistory.length > 0 && (
              <button
                className="agentmode-chat-history-clear-btn"
                onClick={handleClearAllHistory}
              >
                Clear All
              </button>
            )}
          </div>
          {chatHistory.length === 0 ? (
            <p className="agentmode-chat-history-empty">No chat history yet</p>
          ) : (
            chatHistory.map(chat => (
              <div
                key={chat.id}
                className="agentmode-chat-history-entry"
              >
                <div
                  className="agentmode-chat-history-entry-content"
                  onClick={() => loadChatFromHistory(chat)}
                >
                  <div className="agentmode-chat-history-entry-title">{chat.title}</div>
                  <div className="agentmode-chat-history-entry-date">
                    {chat.timestamp.toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="agentmode-chat-history-delete-btn"
                  onClick={(e) => handleDeleteHistoryEntry(chat.id, e)}
                  title="Delete this chat"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Messages Area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}>


        {messages.length === 0 ? (
          null
        ) : (
          messages.map(message => (
            <div key={message.id}>
              {renderMessage(message)}
            </div>
          ))
        )}

        {/* Current streaming content */}
        {isLoading && currentStreamingContent && (
          <div style={{
            width: '100%',
            marginBottom: '2px',
          }}>
            <div style={{
              width: '100%',
              padding: '8px 12px',
              backgroundColor: 'var(--background-primary-alt)', // background color for assistant messages
              color: 'var(--text-normal)',
              position: 'relative',
            }}>
              <div style={{
                userSelect: 'text',
                WebkitUserSelect: 'text',
                MozUserSelect: 'text',
                msUserSelect: 'text',
              }}>
                <MarkdownRenderer
                  content={currentStreamingContent}
                  style={{
                    lineHeight: '1.5'
                  }}
                  plugin={plugin}
                />
                <span className="agentmode-streaming-cursor" style={{
                  display: 'inline-block',
                  width: '2px',
                  height: '20px',
                  backgroundColor: 'var(--interactive-accent)',
                  marginLeft: '2px',
                  animation: 'blink 1s infinite',
                }} />
              </div>
              <div style={{
                fontSize: '11px',
                opacity: 0.7,
                marginTop: '8px',
                textAlign: 'left',
              }}>
                {new Date().toLocaleTimeString()} • Typing...
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={{
        padding: '16px 16px 8px 16px',
        borderTop: '1px solid var(--background-modifier-border)',
        backgroundColor: 'var(--background-secondary)'
      }}>
        <style>
          {`
            @keyframes pulse {
              0% { border-bottom-color: var(--interactive-accent); }
              50% { border-bottom-color: var(--interactive-accent-hover); }
              100% { border-bottom-color: var(--interactive-accent); }
            }
            @keyframes blink {
              0%, 50% { opacity: 1; }
              51%, 100% { opacity: 0; }
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            .chat-textarea::placeholder {
              color: var(--text-faint);
            }
          `}
        </style>
        {/* Uploaded Images Tags */}
        {uploadedImages.length > 0 && (
          <div style={{
            marginBottom: '12px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            alignItems: 'center'
          }}>
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              fontWeight: '500',
              marginRight: '4px'
            }}>
              Images:
            </span>
            {uploadedImages.map(image => (
              <div
                key={image.id}
                title={`${image.name} (${(image.size / 1024 / 1024).toFixed(1)}MB)`}
                className="agentmode-file-tag agentmode-file-tag-success"
              >
                <span>🖼️ {image.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeUploadedImage(image.id);
                  }}
                  className="agentmode-remove-button"
                  style={{
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1'
                  }}
                  title="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Uploaded Files Tags */}
        {uploadedFiles.length > 0 && (
          <div style={{
            marginBottom: '12px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            alignItems: 'center'
          }}>
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              fontWeight: '500',
              marginRight: '4px'
            }}>
              Files:
            </span>
            {uploadedFiles.map(file => (
              <div
                key={file.id}
                title={`${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`}
                className="agentmode-file-tag agentmode-file-tag-info"
              >
                <span>📎 {file.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeUploadedFile(file.id);
                  }}
                  className="agentmode-remove-button"
                  style={{
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1'
                  }}
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Context Files Tags */}
        {contextFiles.length > 0 && (
          <div style={{
            marginBottom: '12px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            alignItems: 'center'
          }}>
            <span style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              fontWeight: '500',
              marginRight: '4px'
            }}>
              Context:
            </span>
            {contextFiles.map(contextFile => (
              <div
                key={contextFile.id}
                title={contextFile.file.path}
                className="agentmode-file-tag agentmode-file-tag-secondary"
              >
                <span>📄 {contextFile.displayName}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeContextFile(contextFile.id);
                  }}
                  className="agentmode-remove-button"
                  style={{
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1'
                  }}
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Loading Bar */}
        {isLoading && (
          <div style={{
            marginBottom: '8px'
          }}>
            <div className="agentmode-loading-bar" />
          </div>
        )}

        {/* Input Row */}
        <div style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-end'
        }}>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            flex: 1
          }}>

            {/* Main TipTap Editor */}
            <TiptapEditor
              ref={textareaRef}
              value={inputText}
              onChange={(value) => setInputText(value)}
              onKeyPress={handleKeyPress}
              onPaste={handlePaste}
              placeholder={chatMode === 'Ask'
                ? "Ask something... Use [[]] to link notes"
                : "Give instructions to the agent... Use [[]] to link notes"
              }
              className="agentmode-chat-textarea"
              style={{
                boxSizing: 'border-box',
                minHeight: '44px',
                maxHeight: '250px',
                overflowY: 'auto',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid var(--background-modifier-border)',
                backgroundColor: 'var(--background-secondary)',
                color: 'var(--text-normal)',
                fontSize: '14px',
                fontFamily: 'inherit',
                width: '100%'
              }}
              chatMode={chatMode}
            />

            {/* New Bottom Control Strip */}
            <div style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              {/* Left side controls */}
              <div style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center'
              }}>
                <select
                  value={chatMode}
                  onChange={(e) => setChatMode(e.target.value as 'Ask' | 'Agent')}
                  style={{
                    backgroundColor: 'var(--background-secondary)',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '6px',
                    color: 'var(--text-normal)',
                    padding: '6px 12px',
                    fontSize: '14px',
                    minWidth: '80px'
                  }}
                >
                  <option value="Agent">Agent</option>
                  <option value="Ask">Ask</option>
                </select>
                <span style={{
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  fontWeight: '500'
                }}>
                  {chatMode === 'Ask' ? 'Ask mode' : 'Agent mode'}
                </span>
              </div>

              {/* Right side controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  style={{
                    backgroundColor: 'var(--background-secondary)',
                    border: '1px solid var(--background-modifier-border)',
                    borderRadius: '6px',
                    color: 'var(--text-normal)',
                    padding: '6px 12px',
                    fontSize: '14px',
                    minWidth: '140px'
                  }}
                >
                  {AI_MODELS.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                {uploadedImages.length > 0 && !currentModelSupportsVision && (
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-error)',
                    fontWeight: '500',
                    marginLeft: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}>
                    ⚠️ Please select a model that supports images
                  </div>
                )}
                {uploadedFiles.length > 0 && !currentModelSupportsFiles && (
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-error)',
                    fontWeight: '500',
                    marginLeft: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}>
                    ⚠️ Please select a model that supports files
                  </div>
                )}
                <button
                  onClick={isLoading ? handleStopChat : handleSendMessage}
                  disabled={!isLoading && !inputText.trim()}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    backgroundColor: isLoading ? 'var(--text-error)' : (inputText.trim() ? 'var(--interactive-accent)' : 'var(--background-modifier-border)'),
                    color: 'var(--text-on-accent)',
                    cursor: (isLoading || inputText.trim()) ? 'pointer' : 'not-allowed',
                    fontSize: '14px',
                    fontWeight: '500',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  {isLoading ? 'Stop' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Hidden image input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/bmp"
        style={{ display: 'none' }}
        onChange={handleFileChange}
        multiple
      />

      {/* Hidden file input */}
      <input
        ref={fileUploadInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={handleFileUploadChange}
        multiple
      />

      {/* Create Note Confirmation Modal */}
      {pendingCreateNoteConfirmation && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--background-translucent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: 'var(--background-primary)',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '800px',
            maxHeight: '80vh',
            width: '100%',
            overflow: 'auto',
            border: '1px solid var(--background-modifier-border)',
            boxShadow: 'var(--shadow-l)'
          }}>
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid var(--background-modifier-border)'
            }}>
              <div>
                <h3 style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: '600',
                  color: 'var(--text-normal)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  📄 Confirm Create New Note
                </h3>
                <p style={{
                  margin: '4px 0 0 0',
                  fontSize: '14px',
                  color: 'var(--text-muted)'
                }}>
                  Path: <code style={{
                    backgroundColor: 'var(--background-secondary)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '13px'
                  }}>{pendingCreateNoteConfirmation.note_path}</code>
                </p>
              </div>
            </div>

            {/* Explanation */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--text-normal)'
              }}>Creation Description:</h4>
              <p style={{
                margin: 0,
                fontSize: '14px',
                color: 'var(--text-normal)',
                backgroundColor: 'var(--background-secondary)',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-border)'
              }}>
                {pendingCreateNoteConfirmation.explanation}
              </p>
            </div>

            {/* Content Preview */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--text-normal)'
              }}>Note Content Preview:</h4>
              <div style={{
                backgroundColor: 'var(--background-primary)',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-border)',
                maxHeight: '400px',
                overflow: 'auto',
                fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                fontSize: '13px',
                lineHeight: '1.5',
                color: 'var(--text-normal)',
                whiteSpace: 'pre-wrap'
              }}>
                {pendingCreateNoteConfirmation.content}
              </div>
            </div>

            {/* Reject Reason Input */}
            {showRejectReasonInput && (
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{
                  margin: '0 0 8px 0',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: 'var(--text-normal)'
                }}>Rejection Reason (Optional):</h4>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Please explain why you want to reject creating this note..."
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid var(--background-modifier-border)',
                    backgroundColor: 'var(--background-secondary)',
                    color: 'var(--text-normal)',
                    fontSize: '14px',
                    resize: 'vertical',
                    fontFamily: 'inherit'
                  }}
                />
              </div>
            )}

            {/* Action Buttons */}
            <div style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'flex-end',
              paddingTop: '16px',
              borderTop: '1px solid var(--background-modifier-border)'
            }}>
              {showRejectReasonInput ? (
                <>
                  <button
                    onClick={handleCancelReject}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid var(--background-modifier-border)',
                      backgroundColor: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRejectCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--interactive-error)',
                      color: 'var(--text-on-accent)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    Confirm Reject
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleRejectCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid var(--interactive-error)',
                      backgroundColor: 'transparent',
                      color: 'var(--interactive-error)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ❌ Reject
                  </button>
                  <button
                    onClick={handleAcceptCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--interactive-success)',
                      color: isLightTheme ? 'var(--text-normal)' : 'var(--text-on-accent)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ✅ Confirm Create
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Confirmation Modal */}
      {pendingEditConfirmation && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--background-translucent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: 'var(--background-primary)',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '800px',
            maxHeight: '80vh',
            width: '100%',
            overflow: 'auto',
            border: '1px solid var(--background-modifier-border)',
            boxShadow: 'var(--shadow-l)'
          }}>
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid var(--background-modifier-border)'
            }}>
              <div>
                <h3 style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: '600',
                  color: 'var(--text-normal)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  📝 Confirm Edit
                </h3>
                <p style={{
                  margin: '4px 0 0 0',
                  fontSize: '14px',
                  color: 'var(--text-muted)'
                }}>
                  File: <code style={{
                    backgroundColor: 'var(--background-secondary)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '13px'
                  }}>{pendingEditConfirmation.note_path}</code>
                </p>
              </div>
            </div>

            {/* Instructions */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--text-normal)'
              }}>Edit Description:</h4>
              <p style={{
                margin: 0,
                fontSize: '14px',
                color: 'var(--text-normal)',
                backgroundColor: 'var(--background-secondary)',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-border)'
              }}>
                {pendingEditConfirmation.instructions}
              </p>
            </div>

            {/* Edit Operations Summary */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--text-normal)'
              }}>Edit Operations:</h4>
              <div style={{
                backgroundColor: 'var(--background-secondary)',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-border)'
              }}>
                {pendingEditConfirmation.edits.map((edit, index) => (
                  <div key={index} style={{
                    fontSize: '13px',
                    color: 'var(--text-normal)',
                    marginBottom: index < pendingEditConfirmation.edits.length - 1 ? '8px' : '0',
                    padding: '8px',
                    backgroundColor: 'var(--background-primary)',
                    borderRadius: '4px',
                    border: '1px solid var(--background-modifier-border)'
                  }}>
                    <div style={{
                      fontWeight: '600',
                      marginBottom: '4px',
                      color: edit.operation === 'insert' ? 'var(--text-success)' :
                        edit.operation === 'delete' ? 'var(--text-error)' : 'var(--text-warning)'
                    }}>
                      {edit.operation === 'insert' ? '➕ Insert' :
                        edit.operation === 'delete' ? '➖ Delete' : '🔄 Replace'}
                      {edit.operation === 'insert'
                        ? ` after line ${edit.start_line}`
                        : ` line ${edit.start_line}${edit.end_line && edit.end_line !== edit.start_line ? `-${edit.end_line}` : ''}`
                      }
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {edit.description}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Diff Preview */}
            <div style={{ marginBottom: '24px' }}>
              <h4 style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: '600',
                color: 'var(--text-normal)'
              }}>Diff Preview:</h4>
              <div style={{
                backgroundColor: 'var(--background-primary)',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid var(--background-modifier-border)',
                maxHeight: '300px',
                overflow: 'auto',
                fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                fontSize: '12px',
                lineHeight: '1.5'
              }}>
                {pendingEditConfirmation.diff.map((line, index) => {
                  // Only show lines that are changed or context lines
                  const showLine = line.type !== 'unchanged' ||
                    (index > 0 && pendingEditConfirmation.diff[index - 1].type !== 'unchanged') ||
                    (index < pendingEditConfirmation.diff.length - 1 && pendingEditConfirmation.diff[index + 1].type !== 'unchanged');

                  if (!showLine) return null;

                  return (
                    <div key={index} style={{
                      color: line.type === 'deleted' ? 'var(--text-error)' :
                        line.type === 'inserted' ? 'var(--text-success)' : 'var(--text-muted)',
                      backgroundColor: line.type === 'deleted' ? 'var(--background-modifier-error-hover)' :
                        line.type === 'inserted' ? 'var(--background-modifier-success-hover)' : 'transparent',
                      padding: '2px 8px',
                      margin: '1px 0',
                      borderRadius: '2px'
                    }}>
                      <span style={{ marginRight: '8px', opacity: 0.6 }}>
                        {line.type === 'deleted' ? '-' :
                          line.type === 'inserted' ? '+' : ' '}
                      </span>
                      <span style={{ marginRight: '12px', opacity: 0.4, fontSize: '11px' }}>
                        {line.line_number}:
                      </span>
                      {line.content}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Reject Reason Input */}
            {showRejectReasonInput && (
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{
                  margin: '0 0 8px 0',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: 'var(--text-normal)'
                }}>Rejection Reason (Optional):</h4>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Please explain why you want to reject this edit..."
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid var(--background-modifier-border)',
                    backgroundColor: 'var(--background-secondary)',
                    color: 'var(--text-normal)',
                    fontSize: '14px',
                    resize: 'vertical',
                    fontFamily: 'inherit'
                  }}
                />
              </div>
            )}

            {/* Action Buttons */}
            <div style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'flex-end',
              paddingTop: '16px',
              borderTop: '1px solid var(--background-modifier-border)'
            }}>
              {showRejectReasonInput ? (
                <>
                  <button
                    onClick={handleCancelReject}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid var(--background-modifier-border)',
                      backgroundColor: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRejectEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--interactive-error)',
                      color: 'var(--text-on-accent)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    Confirm Reject
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleRejectEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid var(--interactive-error)',
                      backgroundColor: 'transparent',
                      color: 'var(--interactive-error)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ❌ Reject
                  </button>
                  <button
                    onClick={handleAcceptEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--interactive-success)',
                      color: isLightTheme ? 'var(--text-normal)' : 'var(--text-on-accent)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ✅ Accept Edit
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--background-translucent)',
          border: '2px dashed var(--interactive-accent)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          pointerEvents: 'none'
        }}>
          <div style={{
            backgroundColor: 'var(--interactive-accent-translucent)',
            color: 'var(--text-on-accent)',
            padding: '20px 40px',
            borderRadius: '12px',
            fontSize: '18px',
            fontWeight: '600',
            textAlign: 'center',
            boxShadow: 'var(--shadow-l)'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>📁</div>
            Drop {dragFileCount > 1 ? `${dragFileCount} files` : 'file'} here to add as context
          </div>
        </div>
      )}
    </div>
  );
};