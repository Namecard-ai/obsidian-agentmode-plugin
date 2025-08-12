import React, { useState, useRef, useEffect, useCallback } from 'react';
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

// Add CSS styles
const styles = `
  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }
  
  @keyframes pulse {
    0% { opacity: 1; }
    50% { opacity: 0.7; }
    100% { opacity: 1; }
  }
  
  .tool-session-header:hover {
    background-color: var(--background-modifier-hover);
    border-radius: 4px;
  }
  
  .tool-step {
    transition: all 0.2s ease-in-out;
  }
  
  .tool-step:hover {
    transform: translateX(2px);
  }
  
  .tool-result-header:hover {
    background-color: var(--background-modifier-hover);
    border-radius: 4px;
  }
`;

// Inject styles
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
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

  renderSuggestion(value: any, el: HTMLElement): void {
    const file = value.item || value;
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
  { id: 'o3', name: 'o3', supportVision: true, supportFiles: true },
  { id: 'o3-mini', name: 'o3-mini', supportVision: false, supportFiles: true },
];

interface AgentChatViewProps {
  app: App;
  plugin: AgentPlugin;
}

// Add new interface for wiki link parsing
interface WikiLink {
  start: number;
  end: number;
  path: string;
  isValid: boolean;
  fullMatch: string;
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
      style={{
        background: 'transparent',
        border: 'none',
        color: 'var(--text-muted)',
        cursor: 'pointer',
        padding: '6px',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
        e.currentTarget.style.color = 'var(--text-normal)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
        e.currentTarget.style.color = 'var(--text-muted)';
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
          style={{
            padding: '12px 24px',
            backgroundColor: 'var(--interactive-accent)',
            color: 'var(--text-on-accent)',
            border: 'none',
            borderRadius: '6px',
            fontSize: 'var(--font-ui-medium)',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'background-color 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--interactive-accent-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--interactive-accent)';
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0].id);
  const [chatMode, setChatMode] = useState<'Ask' | 'Agent'>('Agent');
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
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
  const [pendingEditConfirmation, setPendingEditConfirmation] = useState<PendingEditConfirmation | null>(null);
  const [pendingCreateNoteConfirmation, setPendingCreateNoteConfirmation] = useState<PendingCreateNoteConfirmation | null>(null);
  const [showRejectReasonInput, setShowRejectReasonInput] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // Add new states for wiki link functionality
  const [wikiLinks, setWikiLinks] = useState<WikiLink[]>([]);
  const [pendingWikiLinkPosition, setPendingWikiLinkPosition] = useState<number | null>(null);
  const [viewBackgroundColor, setViewBackgroundColor] = useState('var(--background-primary)');
  const [isLightTheme, setIsLightTheme] = useState(document.body.classList.contains('theme-light'));
  
  // Add login state monitoring
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(plugin.isLoggedIn());
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const highlightLayerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  // Sync ref with state
  useEffect(() => {
    currentStreamingContentRef.current = currentStreamingContent;
  }, [currentStreamingContent]);

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

  useEffect(() => {
    if (textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.style.height = 'auto'; // Reset height to recalculate
      textarea.style.height = `${textarea.scrollHeight}px`; // Set to content height
    }
  }, [inputText]);

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
    const interval = setInterval(checkLoginStatus, 5000);

    return () => clearInterval(interval);
  }, [plugin]);

  const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Debug: Monitor messages changes
  useEffect(() => {
    console.log('🎯 [DEBUG] Messages changed, current count:', messages.length);
    console.log('🎯 [DEBUG] Messages:', messages.map(m => ({ id: m.id, role: m.role, content: m.content.slice(0, 50) })));
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

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    // Both Ask and Agent modes now use the same streamAgentChat function
    // The difference is handled internally by the chatMode parameter
    const toolSessionId = generateId();
    setStreamingMessageId(toolSessionId);
    let lastToolCallContent = ''; // Track content before tool calls
    
    // Convert messages to plugin format - now include tool messages too
    const chatMessages = messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool')
      .map(msg => ({
        role: msg.role,
        content: msg.content,
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
        ...(msg.name && { name: msg.name })
      }));
    
    // Add the current user message with images and files if any
    const currentUserMessage: any = {
      role: 'user' as const,
      content: (uploadedImages.length > 0 || uploadedFiles.length > 0) ? [
        {
          type: 'text',
          text: messageContent
        },
        ...uploadedImages.map(img => ({
          type: 'image_url',
          image_url: {
            url: `data:${img.file.type};base64,${img.base64Data}`
          }
        })),
        ...uploadedFiles.map(file => ({
          type: 'file',
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
        chatMessages,
        contextTFiles,
        selectedModel,
        chatMode,
        (chunk: string) => {
          // Handle streaming for assistant response content
          console.log('🎯 [DEBUG] Streaming chunk:', chunk);
          setCurrentStreamingContent(prev => prev + chunk);
        },
        (toolCall: any) => {
          // Handle tool call - save current content and create tool call message
          const currentContent = currentStreamingContentRef.current;
          lastToolCallContent = currentContent;
          
          const toolCallMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: currentContent,
            timestamp: new Date(),
            tool_calls: [toolCall]
          };
          
          setMessages(prev => [...prev, toolCallMessage]);
          setCurrentStreamingContent(''); // Reset for new content after tool call
        },
        (finalContent: string) => {
          // Handle completion - create final message with complete content from main.ts
          console.log('🎯 [DEBUG] Completion callback triggered');
          console.log('🎯 [DEBUG] finalContent from main.ts:', finalContent);
          console.log('🎯 [DEBUG] finalContent length:', finalContent.length);
          console.log('🎯 [DEBUG] current messages count:', messages.length);
          
          if (finalContent) {
            const finalMessage: Message = {
              id: generateId(),
              role: 'assistant',
              content: finalContent,
              timestamp: new Date()
            };
            
            console.log('🎯 [DEBUG] Creating final message:', finalMessage);
            
            setMessages(prev => {
              const newMessages = [...prev, finalMessage];
              console.log('🎯 [DEBUG] New messages array length:', newMessages.length);
              console.log('🎯 [DEBUG] Last message:', newMessages[newMessages.length - 1]);
              return newMessages;
            });
          }
          
          // Use setTimeout to ensure the message is rendered before clearing states
          setTimeout(() => {
            console.log('🎯 [DEBUG] Clearing loading states');
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentStreamingContent('');
          }, 50); // Small delay to ensure rendering
          
          console.log(`${chatMode} conversation completed`);
        },
        (error: string) => {
          // Handle error
          console.error(`${chatMode} chat error:`, error);
          
          const errorMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: currentStreamingContentRef.current + `\n\n❌ Error: ${error}`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev, errorMessage]);
          
          setIsLoading(false);
          setStreamingMessageId(null);
          setCurrentStreamingContent('');
        },
        (toolResult: { toolCallId: string; result: string }) => {
          // Handle tool result - add as tool message
          const toolResultMessage: Message = {
            id: generateId(),
            role: 'tool',
            content: toolResult.result,
            timestamp: new Date(),
            tool_call_id: toolResult.toolCallId
          };
          
          setMessages(prev => [...prev, toolResultMessage]);
          
          // Add UI notification for Ask Mode auto-rejection
          if (chatMode === 'Ask' && toolResult.result.includes("I'm currently in Ask Mode")) {
            // Show a subtle notification that editing was blocked
            console.log('🚫 [Ask Mode] Edit operation was automatically blocked');
          }
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
      setMessages(prev => [...prev, errorMessage]);
      
      setIsLoading(false);
      setStreamingMessageId(null);
      setCurrentStreamingContent('');
    }
  };

  const handleNewChat = () => {
    if (messages.length > 0) {
      // Save current chat to history
      const chatTitle = messages[0]?.content.slice(0, 50) + (messages[0]?.content.length > 50 ? '...' : '');
      const newChat: ChatHistory = {
        id: currentChatId || generateId(),
        title: chatTitle,
        messages: [...messages],
        timestamp: new Date()
      };
      setChatHistory(prev => [newChat, ...prev]);
    }
    
    setMessages([]);
    setContextFiles([]);
    setUploadedImages([]);
    setUploadedFiles([]);
    setCurrentChatId(generateId());
  };

  const loadChatFromHistory = (chat: ChatHistory) => {
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
    setContextFiles([]);
    setUploadedImages([]);
    setUploadedFiles([]);
    setShowHistory(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    } else if (e.key === '[' && textareaRef.current) {
      // Check if this is the second [ to trigger wiki link input
      const cursorPos = textareaRef.current.selectionStart || 0;
      const beforeCursor = inputText.slice(0, cursorPos);
      
      // Check if the previous character is also [
      if (beforeCursor.endsWith('[')) {
        // This will be the second [, trigger file selection after the keystroke is processed
        setTimeout(() => {
          const newCursorPos = cursorPos + 1; // +1 because the [ key will be added
          setPendingWikiLinkPosition(newCursorPos);
          handleWikiLinkInput(newCursorPos);
        }, 0);
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    const maxSize = 50 * 1024 * 1024; // 50MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      // Check file type
      if (!supportedTypes.includes(file.type)) {
        new Notice(`File "${file.name}" is not a supported image format. Supported formats: JPG, PNG, GIF, WebP, BMP`);
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

    const handleNativeDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      setDragFileCount(0);

      console.log('Drop event triggered');
      console.log('DataTransfer types:', e.dataTransfer?.types);

      // Log all available data types for debugging
      if (e.dataTransfer?.types) {
        e.dataTransfer.types.forEach(type => {
          const data = e.dataTransfer?.getData(type);
          console.log(`Data type "${type}":`, data);
        });
      }

      // Handle Obsidian's native file drag data
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        console.log('Found files in dataTransfer:', files);
        Array.from(files).forEach(file => {
          console.log('Processing file:', file.name);
          if (file.name.endsWith('.md')) {
            const abstractFile = app.vault.getAbstractFileByPath(file.name);
            if (abstractFile && abstractFile instanceof TFile) {
              console.log('Adding file via files array:', abstractFile.path);
              addContextFile(abstractFile);
            } else {
              console.log('Could not find TFile for:', file.name);
            }
          }
        });
        return;
      }

      // Try different data transfer formats
      const dataTypes = ['text/plain', 'text/uri-list', 'application/json', 'text/html'];
      let filesAdded = 0;

      for (const type of dataTypes) {
        const data = e.dataTransfer?.getData(type);
        if (data) {
          console.log(`Trying to process data from type "${type}":`, data);
          
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
          
          console.log(`Extracted ${filePaths.length} file paths:`, filePaths);
          
          // Process each file path
          for (const filePath of filePaths) {
            const cleanPath = filePath.trim();
            if (!cleanPath) continue;
            
            // Try to find file by exact path
            let abstractFile = app.vault.getAbstractFileByPath(cleanPath);
            if (abstractFile && abstractFile instanceof TFile && abstractFile.extension === 'md') {
              console.log('Found file by exact path:', abstractFile.path);
              addContextFile(abstractFile);
              filesAdded++;
              continue;
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
              if (abstractFile && abstractFile instanceof TFile && abstractFile.extension === 'md') {
                console.log('Found file by path variation:', abstractFile.path);
                addContextFile(abstractFile);
                filesAdded++;
                break;
              }
            }

            if (abstractFile && abstractFile instanceof TFile && abstractFile.extension === 'md') continue;

            // Try to find by basename
            const allFiles = app.vault.getMarkdownFiles();
            const foundFile = allFiles.find(f => 
              f.basename === cleanPath || 
              f.name === cleanPath ||
              f.path.endsWith('/' + cleanPath) ||
              f.path.endsWith('\\' + cleanPath) ||
              cleanPath.includes(f.basename)
            );
            
            if (foundFile) {
              console.log('Found file by basename search:', foundFile.path);
              addContextFile(foundFile);
              filesAdded++;
            }
          }
          
          // If we found files in this data type, we can stop trying other types
          if (filesAdded > 0) {
            console.log(`Successfully added ${filesAdded} files from data type "${type}"`);
            break;
          }
        }
      }

      if (filesAdded === 0) {
        console.log('No files could be resolved from drop data');
        // Try to access Obsidian's internal drag state
        try {
          const workspace = app.workspace as any;
          
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
            let obj = workspace;
            for (const part of parts) {
              obj = obj?.[part];
            }
            
            if (obj) {
              console.log(`Found data at ${path}:`, obj);
              if (Array.isArray(obj)) {
                obj.forEach((file: any) => {
                  if (file && file.extension === 'md') {
                    console.log('Adding file from', path, ':', file.path);
                    addContextFile(file);
                    filesAdded++;
                  }
                });
              } else if (obj.extension === 'md') {
                console.log('Adding single file from', path, ':', obj.path);
                addContextFile(obj);
                filesAdded++;
              }
            }
          }
          
          // Also try to get the currently selected files from file explorer
          const fileExplorer = app.workspace.getLeavesOfType('file-explorer')[0];
          if (fileExplorer && fileExplorer.view && filesAdded === 0) {
            const view = fileExplorer.view as any;
            console.log('File explorer view:', view);
            
            // Try to get selected files
            if (view.tree && view.tree.selectedDoms) {
              console.log('Found selectedDoms:', view.tree.selectedDoms);
              view.tree.selectedDoms.forEach((dom: any) => {
                if (dom.file && dom.file.extension === 'md') {
                  console.log('Adding file from selectedDoms:', dom.file.path);
                  addContextFile(dom.file);
                  filesAdded++;
                }
              });
            }
          }
        } catch (error) {
          console.log('Could not access internal drag state:', error);
        }
      }

      if (filesAdded === 0) {
        console.log('No markdown files could be added from drop operation');
        
        // Final fallback: try to parse any text data as a file path
        const allDataTypes = Array.from(e.dataTransfer?.types || []);
        console.log('All available data types:', allDataTypes);
        
        for (const type of allDataTypes) {
          try {
            const data = e.dataTransfer?.getData(type);
            if (data && typeof data === 'string') {
              console.log(`Final attempt with type "${type}":`, data);
              
              // Try to find any markdown file that matches
              const allFiles = app.vault.getMarkdownFiles();
              const matchingFile = allFiles.find(file => {
                return data.includes(file.basename) || 
                       data.includes(file.name) || 
                       data.includes(file.path) ||
                       file.path.includes(data) ||
                       file.basename.includes(data);
              });
              
              if (matchingFile) {
                console.log('Found matching file in final attempt:', matchingFile.path);
                addContextFile(matchingFile);
                filesAdded++;
                break;
              }
            }
          } catch (error) {
            console.log(`Error processing type "${type}":`, error);
          }
        }
        
        if (filesAdded === 0) {
          console.log('All file resolution attempts failed');
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
    } catch (error: any) {
      console.error('Login failed:', error);
      new Notice(`Login failed: ${error.message}`);
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

    console.log('React drop event triggered');
    // Let the native handler take care of this
    // This prevents duplicate handling
  };

  const renderMessage = (message: Message) => {
    const isUser = message.role === 'user';
    const isStreaming = streamingMessageId === message.id;
    const isToolResult = message.role === 'tool';
    const isToolResultExpanded = expandedToolResults.has(message.id);
    
    return (
      <div
        key={message.id}
        className={`message ${isUser ? 'user' : 'assistant'}`}
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
            className={isToolResult ? 'tool-result-header' : ''}
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
                <span className="streaming-cursor" style={{
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

          {/* Timestamp */}
          <div style={{
            fontSize: '11px',
            color: 'var(--text-muted)',
            opacity: 0.7,
            marginTop: '4px',
            textAlign: isUser ? 'right' : 'left',
          }}>
            {message.timestamp.toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  };

  // Add wiki link parsing functions
  const parseWikiLinks = (text: string): WikiLink[] => {
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    const matches: WikiLink[] = [];
    let match;
    
    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const path = match[1];
      const file = app.vault.getAbstractFileByPath(path);
      
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        path: path,
        isValid: !!(file && file instanceof TFile),
        fullMatch: match[0]
      });
    }
    
    return matches;
  };

  // Update wiki links when input text changes
  useEffect(() => {
    const links = parseWikiLinks(inputText);
    setWikiLinks(links);
  }, [inputText, app.vault]);

  // Handle [[ input detection and file selection
  const handleWikiLinkInput = (position: number) => {
    const modal = new FilePickerModal(app, (file: TFile) => {
      // Insert the file path at the specified position
      const beforeCursor = inputText.slice(0, position);
      const afterCursor = inputText.slice(position);
      const relativePath = file.path;
      
      // Remove the [[ that triggered this modal
      const beforeWithoutBrackets = beforeCursor.slice(0, -2);
      const newText = beforeWithoutBrackets + `[[${relativePath}]]` + afterCursor;
      
      setInputText(newText);
      
      // Set cursor position after the inserted link
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = beforeWithoutBrackets.length + `[[${relativePath}]]`.length;
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          textareaRef.current.focus();
        }
      }, 0);
      
      setPendingWikiLinkPosition(null);
    });
    modal.open();
  };

  // Add scroll sync for syntax highlighting
  useEffect(() => {
    const textarea = textareaRef.current;
    const highlightLayer = highlightLayerRef.current;
    
    if (!textarea || !highlightLayer) return;
    
    const syncScroll = () => {
      highlightLayer.scrollTop = textarea.scrollTop;
      highlightLayer.scrollLeft = textarea.scrollLeft;
    };
    
    textarea.addEventListener('scroll', syncScroll);
    
    return () => {
      textarea.removeEventListener('scroll', syncScroll);
    };
  }, []);

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
            tooltip="New Chat"
            onClick={handleNewChat}
          />
          <IconButton
            icon="history"
            tooltip="History"
            onClick={() => setShowHistory(!showHistory)}
          />
          <IconButton
            icon="image"
            tooltip="Upload Image"
            onClick={handleImageUpload}
          />
          <IconButton
            icon="paperclip"
            tooltip="Upload File"
            onClick={handleFileUpload}
          />
          <IconButton
            icon="link"
            tooltip="Add Context"
            onClick={handleAddContext}
          />
        </div>
      </div>

      {/* History Sidebar */}
      {showHistory && (
        <div style={{
          position: 'absolute',
          top: '60px',
          right: '16px',
          width: '300px',
          maxHeight: '400px',
          backgroundColor: 'var(--background-secondary)',
          border: '1px solid var(--background-modifier-border)',
          borderRadius: '8px',
          padding: '12px',
          zIndex: 1000,
          overflowY: 'auto'
        }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>Chat History</h3>
          {chatHistory.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No chat history yet</p>
          ) : (
            chatHistory.map(chat => (
              <div
                key={chat.id}
                onClick={() => loadChatFromHistory(chat)}
                style={{
                  padding: '8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  marginBottom: '4px',
                  backgroundColor: 'var(--background-primary)',
                  fontSize: '14px'
                }}
              >
                <div style={{ fontWeight: '500' }}>{chat.title}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                  {chat.timestamp.toLocaleDateString()}
                </div>
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
                <span className="streaming-cursor" style={{
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: 'var(--background-modifier-success)',
                  borderRadius: '12px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  color: 'var(--text-on-accent)',
                  gap: '4px',
                  border: '1px solid var(--background-modifier-success-border)',
                  transition: 'background-color 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-modifier-success-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-modifier-success)';
                }}
              >
                <span>🖼️ {image.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeUploadedImage(image.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1',
                    marginLeft: '2px',
                    borderRadius: '50%',
                    width: '16px',
                    height: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--background-modifier-error)';
                    e.currentTarget.style.color = 'var(--text-on-accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: 'var(--background-modifier-info)',
                  borderRadius: '12px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  color: 'var(--text-on-accent)',
                  gap: '4px',
                  border: '1px solid var(--background-modifier-info-border)',
                  transition: 'background-color 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-modifier-info-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-modifier-info)';
                }}
              >
                <span>📎 {file.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeUploadedFile(file.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1',
                    marginLeft: '2px',
                    borderRadius: '50%',
                    width: '16px',
                    height: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--background-modifier-error)';
                    e.currentTarget.style.color = 'var(--text-on-accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: 'var(--background-secondary)',
                  borderRadius: '12px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  color: 'var(--text-normal)',
                  gap: '4px',
                  border: '1px solid var(--background-modifier-border)',
                  transition: 'background-color 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-modifier-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--background-secondary)';
                }}
              >
                <span>📄 {contextFile.displayName}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeContextFile(contextFile.id);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '2px',
                    fontSize: '14px',
                    lineHeight: '1',
                    marginLeft: '2px',
                    borderRadius: '50%',
                    width: '16px',
                    height: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--background-modifier-error)';
                    e.currentTarget.style.color = 'var(--text-on-accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }}
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            ))}
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

            {/* Main Textarea */}
            <div style={{
              position: 'relative',
              width: '100%'
            }}>
              {/* Syntax highlight background layer can remain here */}
              <div
                ref={highlightLayerRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  minHeight: '44px',
                  maxHeight: '120px',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid transparent',
                  backgroundColor: 'transparent',
                  color: 'transparent',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  lineHeight: '1.5',
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordWrap: 'break-word',
                  pointerEvents: 'none',
                  zIndex: 1
                }}
              >
                {/* Rendering logic for wiki links */}
                {(() => {
                  const chars = inputText.split('');
                  const result = [];
                  let currentHighlight = null;
                  
                  for (let i = 0; i < chars.length; i++) {
                    const wikiLink = wikiLinks.find(link => 
                      i >= link.start && i < link.end
                    );
                    
                    if (wikiLink && wikiLink !== currentHighlight) {
                      if (currentHighlight) {
                        result.push('</span>');
                      }
                      result.push(
                        `<span style="background-color: ${
                          wikiLink.isValid 
                            ? 'var(--background-modifier-success-hover)' 
                            : 'var(--background-modifier-error-hover)'
                        }; color: ${
                          wikiLink.isValid ? 'var(--text-success)' : 'var(--text-error)'
                        }; border-radius: 3px; padding: 1px 2px;">`
                      );
                      currentHighlight = wikiLink;
                    } else if (!wikiLink && currentHighlight) {
                      result.push('</span>');
                      currentHighlight = null;
                    }
                    
                    result.push(chars[i]);
                  }
                  
                  if (currentHighlight) {
                    result.push('</span>');
                  }
                  
                  return <div dangerouslySetInnerHTML={{ __html: result.join('') }} />;
                })()}
              </div>
              
              {/* Actual textarea */}
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={chatMode === 'Ask' 
                  ? "Ask something... Use [[]] to link notes" 
                  : "Give instructions to the agent... Use [[]] to link notes"
                }
                className="chat-textarea"
                style={{
                  position: 'relative',
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
                  resize: 'none',
                  fontFamily: 'inherit',
                  width: '100%',
                  zIndex: 2
                }}
              />
            </div>

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
                  onClick={handleSendMessage}
                  disabled={!inputText.trim() || isLoading}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    backgroundColor: inputText.trim() && !isLoading ? 'var(--interactive-accent)' : 'var(--background-modifier-border)',
                    color: 'var(--text-on-accent)',
                    cursor: inputText.trim() && !isLoading ? 'pointer' : 'not-allowed',
                    fontSize: '14px',
                    fontWeight: '500',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  {isLoading ? (
                    <div style={{
                      width: '16px',
                      height: '16px',
                      border: '2px solid var(--interactive-accent-border)',
                      borderTop: '2px solid var(--text-on-accent)',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite'
                    }} />
                  ) : (
                    'Send'
                  )}
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