import { useState, useRef, useEffect } from 'react';
import { FuzzySuggestModal, TFile, App, Notice } from 'obsidian';
import MarkdownRenderer from './MarkdownRenderer';

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
    background-color: rgba(0, 0, 0, 0.05);
    border-radius: 4px;
  }
  
  .tool-step {
    transition: all 0.2s ease-in-out;
  }
  
  .tool-step:hover {
    transform: translateX(2px);
  }
  
  .tool-result-header:hover {
    background-color: rgba(255, 255, 255, 0.05);
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
  base64Data: string; // 用於 OpenAI API
  size: number;
}

interface AIModel {
  id: string;
  name: string;
  supportVision: boolean;
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
  { id: 'gpt-4o', name: 'gpt-4o', supportVision: true },
  { id: 'gpt-4o-mini', name: 'gpt-4o-mini', supportVision: true },
  { id: 'gpt-4.1', name: 'gpt-4.1', supportVision: true },
  { id: 'o4-mini', name: 'o4-mini', supportVision: true },
  { id: 'o3', name: 'o3', supportVision: true },
  { id: 'o3-pro', name: 'o3-pro', supportVision: true },
  { id: 'o3-mini', name: 'o3-mini', supportVision: false },
];

interface AgentChatViewProps {
  app: App;
  plugin: any; // Reference to the AgentPlugin
}

// Add new interface for wiki link parsing
interface WikiLink {
  start: number;
  end: number;
  path: string;
  isValid: boolean;
  fullMatch: string;
}

export const AgentChatView = ({ app, plugin }: AgentChatViewProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0].id);
  const [chatMode, setChatMode] = useState<'Ask' | 'Agent'>('Ask');
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
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
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const highlightLayerRef = useRef<HTMLDivElement>(null);

  // Sync ref with state
  useEffect(() => {
    currentStreamingContentRef.current = currentStreamingContent;
  }, [currentStreamingContent]);

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

    // 檢查如果有圖片但模型不支援 Vision，給出警告
    if (uploadedImages.length > 0 && !currentModelSupportsVision) {
      new Notice(`當前模型 "${getCurrentModel()?.name}" 不支援圖片分析。請選擇支援 Vision 的模型（如 GPT-4o）`);
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
    
    // Add the current user message with images if any
    const currentUserMessage: any = {
      role: 'user' as const,
      content: uploadedImages.length > 0 ? [
        {
          type: 'text',
          text: messageContent
        },
        ...uploadedImages.map(img => ({
          type: 'image_url',
          image_url: {
            url: `data:${img.file.type};base64,${img.base64Data}`
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
        () => {
          // Handle completion - create final message for content after tool calls
          console.log('🎯 [DEBUG] Completion callback triggered');
          console.log('🎯 [DEBUG] currentStreamingContent:', currentStreamingContentRef.current);
          console.log('🎯 [DEBUG] current messages count:', messages.length);
          
          if (currentStreamingContentRef.current) {
            const finalMessage: Message = {
              id: generateId(),
              role: 'assistant',
              content: currentStreamingContentRef.current,
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
    setCurrentChatId(generateId());
  };

  const loadChatFromHistory = (chat: ChatHistory) => {
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
    setContextFiles([]);
    setUploadedImages([]);
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

  // 檢查當前模型是否支援 Vision
  const getCurrentModel = () => AI_MODELS.find(model => model.id === selectedModel);
  const currentModelSupportsVision = getCurrentModel()?.supportVision || false;

  const handleImageUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    const maxSize = 50 * 1024 * 1024; // 50MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      // 檢查檔案類型
      if (!supportedTypes.includes(file.type)) {
        new Notice(`檔案 "${file.name}" 不是支援的圖片格式。支援格式：JPG, PNG, GIF, WebP, BMP`);
        continue;
      }

      // 檢查檔案大小
      if (file.size > maxSize) {
        new Notice(`檔案 "${file.name}" 超過 50MB 大小限制`);
        continue;
      }

      // 檢查是否已經上傳過
      if (uploadedImages.some(img => img.name === file.name && img.size === file.size)) {
        new Notice(`圖片 "${file.name}" 已經上傳過了`);
        continue;
      }

      try {
        // 將圖片轉換為 base64
        const base64Data = await fileToBase64(file);
        
        const uploadedImage: UploadedImage = {
          id: generateId(),
          file: file,
          name: file.name,
          base64Data: base64Data,
          size: file.size
        };

        setUploadedImages(prev => [...prev, uploadedImage]);
        new Notice(`圖片 "${file.name}" 上傳成功`);
      } catch (error) {
        console.error('Error processing image:', error);
        new Notice(`處理圖片 "${file.name}" 時發生錯誤`);
      }
    }

    // 清除 input value 以允許重複選擇同一檔案
    e.target.value = '';
  };

  // 將檔案轉換為 base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // 移除 data:image/...;base64, 前綴，只保留 base64 內容
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
            const tfile = app.vault.getAbstractFileByPath(file.name) as TFile;
            if (tfile) {
              console.log('Adding file via files array:', tfile.path);
              addContextFile(tfile);
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
            let file = app.vault.getAbstractFileByPath(cleanPath) as TFile;
            if (file && file.extension === 'md') {
              console.log('Found file by exact path:', file.path);
              addContextFile(file);
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
              file = app.vault.getAbstractFileByPath(path) as TFile;
              if (file && file.extension === 'md') {
                console.log('Found file by path variation:', file.path);
                addContextFile(file);
                filesAdded++;
                break;
              }
            }

            if (file && file.extension === 'md') continue;

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
    
    // 定義不同訊息類型的背景色（深淺不同的灰色階層）
    const getBackgroundColor = () => {
      if (isUser) return '#3a3a3a'; // 用戶訊息 - 中等深灰
      if (message.role === 'tool') return '#2a2a2a'; // 工具訊息 - 最深灰
      return '#4a4a4a'; // 助理訊息 - 稍淺灰
    };
    
    const getTextColor = () => {
      return '#ffffff'; // 統一使用白色文字
    };
    
    return (
      <div
        key={message.id}
        className={`message ${isUser ? 'user' : 'assistant'}`}
        style={{
          width: '100%',
          marginBottom: '2px', // 減少間距讓訊息更緊湊
        }}
      >
        <div
          style={{
            width: '100%',
            padding: '8px 12px',
            backgroundColor: getBackgroundColor(),
            color: getTextColor(),
            border: 'none',
            position: 'relative',
          }}
        >
          {/* Message type indicator */}
          <div 
            className={isToolResult ? 'tool-result-header' : ''}
            style={{
              fontSize: '12px',
              color: '#bbb',
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
                ? '用戶' 
                : message.role === 'tool' 
                  ? '工具結果' 
                  : message.tool_calls 
                    ? `助理 (調用: ${message.tool_calls.map(tc => tc.function.name).join(', ')})` 
                    : '助理'
              }
            </span>
            {/* Ask Mode auto-rejection indicator */}
            {isToolResult && message.content.includes("I'm currently in Ask Mode") && (
              <span style={{
                fontSize: '11px',
                backgroundColor: '#ff6b6b',
                color: '#fff',
                padding: '2px 6px',
                borderRadius: '10px',
                fontWeight: '500',
                marginLeft: '8px'
              }}>
                🚫 Ask Mode 阻止
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
              {/* 工具結果摘要（總是顯示）*/}
              <div style={{
                fontSize: '13px',
                color: '#888',
                marginBottom: '8px',
                fontStyle: 'italic'
              }}>
                點擊展開查看詳細結果 ({message.content.length} 字符)
              </div>
              
              {/* 可收折的內容 */}
              {isToolResultExpanded && (
                <div style={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
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
              {/* 根據消息類型選擇渲染方式 */}
              {message.role === 'assistant' ? (
                <MarkdownRenderer 
                  content={message.content}
                  style={{
                    lineHeight: '1.5'
                  }}
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
                  backgroundColor: '#007acc',
                  marginLeft: '2px',
                  animation: 'blink 1s infinite',
                }} />
              )}
            </div>
          )}

          {/* Timestamp */}
          <div style={{
            fontSize: '11px',
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
        backgroundColor: '#1e1e1e',
        color: '#ffffff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        position: 'relative'
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid #333',
        backgroundColor: '#2d2d2d'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>Chat</h2>
          <button
            onClick={handleNewChat}
            style={{
              background: '#4a4a4a',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            ➕ New Chat
          </button>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              background: 'transparent',
              border: '1px solid #555',
              borderRadius: '6px',
              color: '#fff',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            🕒 History
          </button>
          <button
            onClick={handleImageUpload}
            style={{
              background: 'transparent',
              border: '1px solid #555',
              borderRadius: '6px',
              color: '#fff',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            🖼️ Upload Image
          </button>
          <button
            onClick={handleAddContext}
            style={{
              background: 'transparent',
              border: '1px solid #555',
              borderRadius: '6px',
              color: '#fff',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            🔗 Add Context
          </button>
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
          backgroundColor: '#2d2d2d',
          border: '1px solid #555',
          borderRadius: '8px',
          padding: '12px',
          zIndex: 1000,
          overflowY: 'auto'
        }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>Chat History</h3>
          {chatHistory.length === 0 ? (
            <p style={{ color: '#888', fontSize: '14px' }}>No chat history yet</p>
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
                  backgroundColor: '#3a3a3a',
                  fontSize: '14px'
                }}
              >
                <div style={{ fontWeight: '500' }}>{chat.title}</div>
                <div style={{ color: '#888', fontSize: '12px' }}>
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
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#888'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🤖</div>
            <h3>Ask AI Agent</h3>
            <p>Agent is powered by AI, so mistakes are possible. Review output carefully before use.</p>
          </div>
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
              backgroundColor: '#4a4a4a', // 助理訊息的背景色
              color: '#ffffff',
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
                />
                <span className="streaming-cursor" style={{
                  display: 'inline-block',
                  width: '2px',
                  height: '20px',
                  backgroundColor: '#007acc',
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
        padding: '16px',
        borderTop: '1px solid #333',
        backgroundColor: '#2d2d2d'
      }}>
        <style>
          {`
            @keyframes pulse {
              0% { border-bottom-color: #0066cc; }
              50% { border-bottom-color: #004499; }
              100% { border-bottom-color: #0066cc; }
            }
            @keyframes blink {
              0%, 50% { opacity: 1; }
              51%, 100% { opacity: 0; }
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
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
              color: '#888',
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
                  backgroundColor: '#3a6b3a',
                  borderRadius: '12px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  color: '#fff',
                  gap: '4px',
                  border: '1px solid #4a7c4a',
                  transition: 'background-color 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#4a7c4a';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#3a6b3a';
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
                    color: '#ccc',
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
                    e.currentTarget.style.backgroundColor = '#ff4444';
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#ccc';
                  }}
                  title="Remove image"
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
              color: '#888',
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
                  backgroundColor: '#4a4a4a',
                  borderRadius: '12px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  color: '#fff',
                  gap: '4px',
                  border: '1px solid #555',
                  transition: 'background-color 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#555';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#4a4a4a';
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
                    color: '#ccc',
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
                    e.currentTarget.style.backgroundColor = '#ff4444';
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#ccc';
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
            <div style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center'
              }}>
                <select
                  value={chatMode}
                  onChange={(e) => setChatMode(e.target.value as 'Ask' | 'Agent')}
                  style={{
                    backgroundColor: '#3a3a3a',
                    border: '1px solid #555',
                    borderRadius: '6px',
                    color: '#fff',
                    padding: '6px 12px',
                    fontSize: '14px',
                    minWidth: '80px'
                  }}
                >
                  <option value="Ask">Ask</option>
                  <option value="Agent">Agent</option>
                </select>
                <span style={{ 
                  fontSize: '12px', 
                  color: '#888',
                  fontWeight: '500'
                }}>
                  {chatMode === 'Ask' ? 'Ask mode' : 'Agent mode'}
                </span>
              </div>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{
                  backgroundColor: '#3a3a3a',
                  border: '1px solid #555',
                  borderRadius: '6px',
                  color: '#fff',
                  padding: '6px 12px',
                  fontSize: '14px',
                  minWidth: '140px'
                }}
              >
                                  {AI_MODELS.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} {model.supportVision ? '🖼️' : ''}
                    </option>
                  ))}
                </select>
                {uploadedImages.length > 0 && !currentModelSupportsVision && (
                  <div style={{
                    fontSize: '12px',
                    color: '#ff6b6b',
                    fontWeight: '500',
                    marginLeft: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}>
                    ⚠️ 請選擇支援圖片的模型
                  </div>
                )}
            </div>
            <div style={{
              position: 'relative',
              width: '100%'
            }}>
              {/* Syntax highlight background layer */}
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
                {/* Render text with wiki link highlights only */}
                {(() => {
                  const chars = inputText.split('');
                  const result = [];
                  let currentHighlight = null;
                  
                  for (let i = 0; i < chars.length; i++) {
                    const wikiLink = wikiLinks.find(link => 
                      i >= link.start && i < link.end
                    );
                    
                    if (wikiLink && wikiLink !== currentHighlight) {
                      // Start new highlight group
                      if (currentHighlight) {
                        result.push('</span>');
                      }
                      result.push(
                        `<span style="background-color: ${
                          wikiLink.isValid 
                            ? 'rgba(100, 200, 100, 0.3)' 
                            : 'rgba(255, 100, 100, 0.3)'
                        }; color: ${
                          wikiLink.isValid ? '#4CAF50' : '#f44336'
                        }; border-radius: 3px; padding: 1px 2px;">`
                      );
                      currentHighlight = wikiLink;
                    } else if (!wikiLink && currentHighlight) {
                      // End highlight group
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
                style={{
                  position: 'relative',
                  minHeight: '44px',
                  maxHeight: '120px',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid #555',
                  backgroundColor: 'rgba(58, 58, 58, 0.8)',
                  color: '#fff',
                  fontSize: '14px',
                  resize: 'none',
                  fontFamily: 'inherit',
                  width: '100%',
                  zIndex: 2
                }}
              />
            </div>
          </div>
          <button
            onClick={handleSendMessage}
            disabled={!inputText.trim() || isLoading}
            style={{
              padding: '12px 20px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: inputText.trim() && !isLoading ? '#0066cc' : '#555',
              color: '#fff',
              cursor: inputText.trim() && !isLoading ? 'pointer' : 'not-allowed',
              fontSize: '14px',
              fontWeight: '500',
              alignSelf: 'flex-end',
              minWidth: '80px',
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
                border: '2px solid rgba(255, 255, 255, 0.3)',
                borderTop: '2px solid #fff',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }} />
            ) : (
              'Send'
            )}
          </button>
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

      {/* Create Note Confirmation Modal */}
      {pendingCreateNoteConfirmation && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#2a2a2a',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '800px',
            maxHeight: '80vh',
            width: '100%',
            overflow: 'auto',
            border: '1px solid #555',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)'
          }}>
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid #444'
            }}>
              <div>
                <h3 style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: '600',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  📄 確認創建新筆記
                </h3>
                <p style={{
                  margin: '4px 0 0 0',
                  fontSize: '14px',
                  color: '#bbb'
                }}>
                  路徑: <code style={{ 
                    backgroundColor: '#3a3a3a', 
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
                color: '#fff'
              }}>創建說明:</h4>
              <p style={{
                margin: 0,
                fontSize: '14px',
                color: '#ddd',
                backgroundColor: '#3a3a3a',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid #555'
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
                color: '#fff'
              }}>筆記內容預覽:</h4>
              <div style={{
                backgroundColor: '#1a1a1a',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid #555',
                maxHeight: '400px',
                overflow: 'auto',
                fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                fontSize: '13px',
                lineHeight: '1.5',
                color: '#ddd',
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
                  color: '#fff'
                }}>拒絕原因 (選填):</h4>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="請說明為什麼要拒絕創建這個筆記..."
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid #555',
                    backgroundColor: '#3a3a3a',
                    color: '#fff',
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
              borderTop: '1px solid #444'
            }}>
              {showRejectReasonInput ? (
                <>
                  <button
                    onClick={handleCancelReject}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid #666',
                      backgroundColor: 'transparent',
                      color: '#bbb',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleRejectCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: '#dc2626',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    確認拒絕
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleRejectCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid #dc2626',
                      backgroundColor: 'transparent',
                      color: '#dc2626',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ❌ 拒絕
                  </button>
                  <button
                    onClick={handleAcceptCreateNote}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: '#16a34a',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ✅ 確認創建
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
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#2a2a2a',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '800px',
            maxHeight: '80vh',
            width: '100%',
            overflow: 'auto',
            border: '1px solid #555',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)'
          }}>
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid #444'
            }}>
              <div>
                <h3 style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: '600',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  📝 確認編輯
                </h3>
                <p style={{
                  margin: '4px 0 0 0',
                  fontSize: '14px',
                  color: '#bbb'
                }}>
                  檔案: <code style={{ 
                    backgroundColor: '#3a3a3a', 
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
                color: '#fff'
              }}>編輯說明:</h4>
              <p style={{
                margin: 0,
                fontSize: '14px',
                color: '#ddd',
                backgroundColor: '#3a3a3a',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid #555'
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
                color: '#fff'
              }}>編輯操作:</h4>
              <div style={{
                backgroundColor: '#3a3a3a',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid #555'
              }}>
                {pendingEditConfirmation.edits.map((edit, index) => (
                  <div key={index} style={{
                    fontSize: '13px',
                    color: '#ddd',
                    marginBottom: index < pendingEditConfirmation.edits.length - 1 ? '8px' : '0',
                    padding: '8px',
                    backgroundColor: '#4a4a4a',
                    borderRadius: '4px',
                    border: '1px solid #555'
                  }}>
                    <div style={{ 
                      fontWeight: '600', 
                      marginBottom: '4px',
                      color: edit.operation === 'insert' ? '#4ade80' : 
                             edit.operation === 'delete' ? '#f87171' : '#fbbf24'
                    }}>
                      {edit.operation === 'insert' ? '➕ 插入' : 
                       edit.operation === 'delete' ? '➖ 刪除' : '🔄 替換'} 
                      {edit.operation === 'insert' 
                        ? ` 在第 ${edit.start_line} 行後`
                        : ` 第 ${edit.start_line}${edit.end_line && edit.end_line !== edit.start_line ? `-${edit.end_line}` : ''} 行`
                      }
                    </div>
                    <div style={{ fontSize: '12px', color: '#bbb' }}>
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
                color: '#fff'
              }}>差異預覽:</h4>
              <div style={{
                backgroundColor: '#1a1a1a',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid #555',
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
                      color: line.type === 'deleted' ? '#f87171' : 
                             line.type === 'inserted' ? '#4ade80' : '#bbb',
                      backgroundColor: line.type === 'deleted' ? 'rgba(248, 113, 113, 0.1)' : 
                                      line.type === 'inserted' ? 'rgba(74, 222, 128, 0.1)' : 'transparent',
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
                  color: '#fff'
                }}>拒絕原因 (選填):</h4>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="請說明為什麼要拒絕這個編輯..."
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '12px',
                    borderRadius: '6px',
                    border: '1px solid #555',
                    backgroundColor: '#3a3a3a',
                    color: '#fff',
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
              borderTop: '1px solid #444'
            }}>
              {showRejectReasonInput ? (
                <>
                  <button
                    onClick={handleCancelReject}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid #666',
                      backgroundColor: 'transparent',
                      color: '#bbb',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleRejectEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: '#dc2626',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    確認拒絕
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleRejectEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: '1px solid #dc2626',
                      backgroundColor: 'transparent',
                      color: '#dc2626',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ❌ 拒絕
                  </button>
                  <button
                    onClick={handleAcceptEdit}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: '#16a34a',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500'
                    }}
                  >
                    ✅ 接受編輯
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
          backgroundColor: 'rgba(0, 102, 204, 0.1)',
          border: '2px dashed #0066cc',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          pointerEvents: 'none'
        }}>
                     <div style={{
             backgroundColor: 'rgba(0, 102, 204, 0.9)',
             color: '#fff',
             padding: '20px 40px',
             borderRadius: '12px',
             fontSize: '18px',
             fontWeight: '600',
             textAlign: 'center',
             boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)'
           }}>
             <div style={{ fontSize: '48px', marginBottom: '12px' }}>📁</div>
             Drop {dragFileCount > 1 ? `${dragFileCount} files` : 'file'} here to add as context
           </div>
        </div>
      )}
    </div>
  );
};