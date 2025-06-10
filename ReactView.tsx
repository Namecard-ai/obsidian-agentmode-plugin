import { useState, useRef, useEffect } from 'react';
import { FuzzySuggestModal, TFile, App } from 'obsidian';

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
`;

// Inject styles
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);
}

interface ToolStep {
  id: string;
  type: 'call' | 'result';
  toolName: string;
  content: string;
  args?: any;
  timestamp: Date;
  status?: 'pending' | 'completed' | 'error';
}

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'tool-session';
  content: string;
  timestamp: Date;
  toolSteps?: ToolStep[]; // 只有 tool-session 類型才有
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

const AI_MODELS = [
  'Claude 3.5 Sonnet',
  'Claude 3 Opus',
  'Claude 3 Haiku',
  'GPT-4',
  'GPT-3.5 Turbo',
  'Gemini Pro'
];

interface ReactViewProps {
  app: App;
  plugin: any; // Reference to the HelloWorldPlugin
}

export const ReactView = ({ app, plugin }: ReactViewProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0]);
  const [chatMode, setChatMode] = useState<'Ask' | 'Agent'>('Ask');
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragFileCount, setDragFileCount] = useState(0);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [currentToolSession, setCurrentToolSession] = useState<{
    messageId: string;
    toolSteps: ToolStep[];
    assistantContent: string;
  } | null>(null);
  const [expandedToolSessions, setExpandedToolSessions] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const currentToolSessionRef = useRef<{
    messageId: string;
    toolSteps: ToolStep[];
    assistantContent: string;
  } | null>(null);

  // Sync ref with state
  useEffect(() => {
    currentToolSessionRef.current = currentToolSession;
  }, [currentToolSession]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const generateId = () => Math.random().toString(36).substr(2, 9);

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

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    let messageContent = inputText.trim();
    
    // Add context files information if any are selected
    if (contextFiles.length > 0) {
      const contextInfo = contextFiles.map(cf => `[[${cf.file.path}]]`).join(' ');
      messageContent += `\n\nContext files: ${contextInfo}`;
    }

    const userMessage: Message = {
      id: generateId(),
      type: 'user',
      content: messageContent,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    if (chatMode === 'Agent') {
      // Use the Agent mode with OpenAI streaming
      const toolSessionId = generateId();
      setStreamingMessageId(toolSessionId);
      
      // Initialize tool session tracking
      setCurrentToolSession({
        messageId: toolSessionId,
        toolSteps: [],
        assistantContent: ''
      });
      console.log('Initialized tool session with ID:', toolSessionId);

      // Convert messages to plugin format (only user and assistant messages)
      const chatMessages = messages
        .filter(msg => msg.type === 'user' || msg.type === 'assistant')
        .map(msg => ({
          role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
          content: msg.content
        }));
      
      // Add the current user message
      chatMessages.push({
        role: 'user' as const,
        content: messageContent
      });

      // Get context files as TFile objects
      const contextTFiles = contextFiles.map(cf => cf.file);

      try {
        await plugin.streamAgentChat(
          chatMessages,
          contextTFiles,
          (chunk: string) => {
            // Handle streaming chunks - distinguish between tool output and assistant response
            if (chunk.includes('🔧 Using tool:')) {
              // This is a tool call indicator
              const toolName = chunk.match(/🔧 Using tool: (\w+)/)?.[1] || 'unknown';
              const newToolStep: ToolStep = {
                id: generateId(),
                type: 'call',
                toolName: toolName,
                content: chunk,
                timestamp: new Date(),
                status: 'pending'
              };
              
              setCurrentToolSession(prev => prev ? {
                ...prev,
                toolSteps: [...prev.toolSteps, newToolStep]
              } : null);
            } else if (chunk.includes('✅ Tool result:') || chunk.includes('❌ Tool error:')) {
              // This is a tool result
              const isError = chunk.includes('❌ Tool error:');
              setCurrentToolSession(prev => {
                if (!prev || prev.toolSteps.length === 0) return prev;
                
                const updatedSteps = [...prev.toolSteps];
                const lastStep = updatedSteps[updatedSteps.length - 1];
                
                if (lastStep.type === 'call') {
                  // Update the last call step status and add result step
                  lastStep.status = isError ? 'error' : 'completed';
                  
                  const resultStep: ToolStep = {
                    id: generateId(),
                    type: 'result',
                    toolName: lastStep.toolName,
                    content: chunk,
                    timestamp: new Date(),
                    status: isError ? 'error' : 'completed'
                  };
                  
                  updatedSteps.push(resultStep);
                }
                
                return {
                  ...prev,
                  toolSteps: updatedSteps
                };
              });
            } else {
              // This is regular assistant content
              setCurrentToolSession(prev => prev ? {
                ...prev,
                assistantContent: prev.assistantContent + chunk
              } : null);
              console.log('Updated assistant content, total length:', currentToolSessionRef.current?.assistantContent.length);
            }
          },
          (toolCall: any) => {
            // Handle tool calls - just log for now as the plugin handles execution
            console.log('Tool call initiated:', toolCall.function?.name);
          },
          () => {
            // Handle completion - create the final message
            const session = currentToolSessionRef.current;
            if (session) {
              console.log('Creating final message with session:', session);
              const finalMessage: Message = session.toolSteps.length > 0 ? {
                id: session.messageId,
                type: 'tool-session',
                content: session.assistantContent,
                timestamp: new Date(),
                toolSteps: session.toolSteps
              } : {
                id: session.messageId,
                type: 'assistant',
                content: session.assistantContent,
                timestamp: new Date()
              };
              
              setMessages(prev => {
                console.log('Adding final message to messages:', finalMessage);
                return [...prev, finalMessage];
              });
              
              // Auto-expand if there are tool steps
              if (session.toolSteps.length > 0) {
                setExpandedToolSessions(prev => new Set([...prev, session.messageId]));
              }
            } else {
              console.warn('No current tool session found on completion');
            }
            
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentToolSession(null);
            console.log('Agent conversation completed');
          },
          (error: string) => {
            // Handle error
            console.error('Agent chat error:', error);
            
            const session = currentToolSessionRef.current;
            if (session) {
              const errorMessage: Message = {
                id: session.messageId,
                type: 'assistant',
                content: session.assistantContent + `\n\n❌ Error: ${error}`,
                timestamp: new Date()
              };
              setMessages(prev => [...prev, errorMessage]);
            }
            
            setIsLoading(false);
            setStreamingMessageId(null);
            setCurrentToolSession(null);
          }
        );
      } catch (error) {
        console.error('Error starting agent chat:', error);
        
        const errorMessage: Message = {
          id: generateId(),
          type: 'assistant',
          content: `❌ Error: ${error.message || 'Unknown error occurred'}`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errorMessage]);
        
        setIsLoading(false);
        setStreamingMessageId(null);
        setCurrentToolSession(null);
      }
    } else {
      // Original Ask mode - simulate AI response
      setTimeout(() => {
        let responseContent = `This is a simulated response from ${selectedModel} in Ask mode. In a real implementation, this would connect to the actual AI service to answer your question.`;
        
        // Acknowledge context files if any were provided
        if (contextFiles.length > 0) {
          responseContent += `\n\nI can see you've provided ${contextFiles.length} context file${contextFiles.length > 1 ? 's' : ''}: ${contextFiles.map(cf => cf.displayName).join(', ')}. In a real implementation, I would analyze the content of these files to provide more relevant responses.`;
        }
        
        const assistantMessage: Message = {
          id: generateId(),
          type: 'assistant',
          content: responseContent,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, assistantMessage]);
        setIsLoading(false);
      }, 1000);
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
    setCurrentChatId(generateId());
  };

  const loadChatFromHistory = (chat: ChatHistory) => {
    setMessages(chat.messages);
    setCurrentChatId(chat.id);
    setContextFiles([]);
    setShowHistory(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // In a real implementation, you would handle file upload here
      console.log('File selected:', file.name);
      // You could add a message indicating file was uploaded
      const fileMessage: Message = {
        id: generateId(),
        type: 'user',
        content: `📎 Uploaded file: ${file.name}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, fileMessage]);
    }
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

  const renderToolSteps = (toolSteps: ToolStep[], messageId: string) => {
    const isExpanded = expandedToolSessions.has(messageId);
    
    return (
      <div className="tool-session-container" style={{
        marginTop: '8px',
        padding: '12px',
        backgroundColor: '#f8f9fa',
        borderRadius: '8px',
        border: '1px solid #e1e5e9'
      }}>
        <div 
          className="tool-session-header"
          onClick={() => toggleToolSession(messageId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: '14px',
            fontWeight: 500,
            color: '#6c757d',
            marginBottom: isExpanded ? '8px' : '0'
          }}
        >
          <span style={{ marginRight: '8px' }}>
            {isExpanded ? '🔽' : '▶️'}
          </span>
          <span>
            🔧 Used {toolSteps.filter(step => step.type === 'call').length} tool{toolSteps.filter(step => step.type === 'call').length > 1 ? 's' : ''}
          </span>
        </div>
        
        {isExpanded && (
          <div className="tool-steps">
            {toolSteps.map((step, index) => (
              <div 
                key={step.id}
                className={`tool-step tool-step-${step.type}`}
                style={{
                  padding: '8px 12px',
                  marginBottom: '6px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  backgroundColor: step.type === 'call' 
                    ? (step.status === 'error' ? '#fff5f5' : '#f0f9ff')
                    : (step.status === 'error' ? '#fef2f2' : '#f0fdf4'),
                  borderLeft: `3px solid ${
                    step.type === 'call' 
                      ? (step.status === 'error' ? '#ef4444' : '#3b82f6')
                      : (step.status === 'error' ? '#ef4444' : '#10b981')
                  }`
                }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '4px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: '#64748b'
                }}>
                  <span style={{ marginRight: '6px' }}>
                    {step.type === 'call' 
                      ? (step.status === 'pending' ? '⏳' : step.status === 'error' ? '❌' : '🔧')
                      : (step.status === 'error' ? '❌' : '✅')
                    }
                  </span>
                  <span>
                    {step.type === 'call' ? `Calling ${step.toolName}` : `Result from ${step.toolName}`}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.7 }}>
                    {step.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <div style={{
                  color: '#374151',
                  lineHeight: '1.4',
                  whiteSpace: 'pre-wrap'
                }}>
                  {step.content.replace(/^\*[🔧✅❌][^*]*\*/g, '').trim()}
                </div>
                {step.args && (
                  <details style={{ marginTop: '6px' }}>
                    <summary style={{ 
                      fontSize: '11px', 
                      color: '#6b7280', 
                      cursor: 'pointer'
                    }}>
                      Parameters
                    </summary>
                    <pre style={{
                      fontSize: '11px',
                      color: '#4b5563',
                      backgroundColor: '#f9fafb',
                      padding: '6px',
                      borderRadius: '4px',
                      margin: '4px 0 0 0',
                      overflow: 'auto'
                    }}>
                      {JSON.stringify(step.args, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderMessage = (message: Message) => {
    const isUser = message.type === 'user';
    const isStreaming = streamingMessageId === message.id;
    
    return (
      <div
        key={message.id}
        className={`message ${isUser ? 'user' : 'assistant'}`}
        style={{
          display: 'flex',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            maxWidth: '70%',
            padding: '12px 16px',
            borderRadius: '12px',
            backgroundColor: isUser 
              ? '#007acc' 
              : message.type === 'tool-session' 
                ? '#ffffff'
                : '#f0f0f0',
            color: isUser ? 'white' : '#333',
            border: message.type === 'tool-session' ? '1px solid #e1e5e9' : 'none',
            position: 'relative',
          }}
        >
          {/* Main message content */}
          <div style={{
            whiteSpace: 'pre-wrap',
            lineHeight: '1.5',
          }}>
            {message.content}
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

          {/* Tool steps for tool-session type */}
          {message.type === 'tool-session' && message.toolSteps && (
            renderToolSteps(message.toolSteps, message.id)
          )}

          {/* Timestamp */}
          <div style={{
            fontSize: '11px',
            opacity: 0.7,
            marginTop: '8px',
            textAlign: isUser ? 'right' : 'left',
          }}>
            {message.timestamp.toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div 
      ref={chatContainerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
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
            onClick={handleFileUpload}
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
            📎 Upload
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
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px'
      }}>
        {isLoading && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start'
          }}>
            <div style={{
              padding: '12px 16px',
              borderRadius: '12px',
              backgroundColor: '#3a3a3a',
              color: '#fff',
              fontSize: '14px'
            }}>
              {chatMode === 'Agent' ? 'Agent thinking...' : 'Thinking...'}
            </div>
          </div>
        )}

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
            <h3>Ask Copilot</h3>
            <p>Copilot is powered by AI, so mistakes are possible. Review output carefully before use.</p>
          </div>
        ) : (
          messages.map(message => renderMessage(message))
        )}
        
        {/* Real-time tool session display */}
        {currentToolSession && (
          <div style={{
            display: 'flex',
            justifyContent: 'flex-start',
            marginBottom: '16px',
          }}>
            <div style={{
              maxWidth: '70%',
              padding: '12px 16px',
              borderRadius: '12px',
              backgroundColor: '#ffffff',
              color: '#333',
              border: '1px solid #e1e5e9',
              position: 'relative',
            }}>
              {/* Current assistant content being streamed */}
              <div style={{
                whiteSpace: 'pre-wrap',
                lineHeight: '1.5',
              }}>
                {currentToolSession.assistantContent}
                <span className="streaming-cursor" style={{
                  display: 'inline-block',
                  width: '2px',
                  height: '20px',
                  backgroundColor: '#007acc',
                  marginLeft: '2px',
                  animation: 'blink 1s infinite',
                }} />
              </div>

              {/* Live tool steps */}
              {currentToolSession.toolSteps.length > 0 && (
                <div className="tool-session-container" style={{
                  marginTop: '8px',
                  padding: '12px',
                  backgroundColor: '#f8f9fa',
                  borderRadius: '8px',
                  border: '1px solid #e1e5e9'
                }}>
                  <div style={{
                    fontSize: '14px',
                    fontWeight: 500,
                    color: '#6c757d',
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center'
                  }}>
                    <span style={{ marginRight: '8px' }}>🔧</span>
                    <span>Tool execution in progress...</span>
                  </div>
                  
                  <div className="tool-steps">
                    {currentToolSession.toolSteps.map((step, index) => (
                      <div 
                        key={step.id}
                        className={`tool-step tool-step-${step.type}`}
                        style={{
                          padding: '8px 12px',
                          marginBottom: '6px',
                          borderRadius: '6px',
                          fontSize: '13px',
                          backgroundColor: step.type === 'call' 
                            ? (step.status === 'error' ? '#fff5f5' : '#f0f9ff')
                            : (step.status === 'error' ? '#fef2f2' : '#f0fdf4'),
                          borderLeft: `3px solid ${
                            step.type === 'call' 
                              ? (step.status === 'error' ? '#ef4444' : '#3b82f6')
                              : (step.status === 'error' ? '#ef4444' : '#10b981')
                          }`
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          marginBottom: '4px',
                          fontSize: '12px',
                          fontWeight: 500,
                          color: '#64748b'
                        }}>
                          <span style={{ marginRight: '6px' }}>
                            {step.type === 'call' 
                              ? (step.status === 'pending' ? '⏳' : step.status === 'error' ? '❌' : '🔧')
                              : (step.status === 'error' ? '❌' : '✅')
                            }
                          </span>
                          <span>
                            {step.type === 'call' ? `Calling ${step.toolName}` : `Result from ${step.toolName}`}
                          </span>
                          <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.7 }}>
                            {step.timestamp.toLocaleTimeString()}
                          </span>
                        </div>
                        <div style={{
                          color: '#374151',
                          lineHeight: '1.4',
                          whiteSpace: 'pre-wrap'
                        }}>
                          {step.content.replace(/^\*[🔧✅❌][^*]*\*/g, '').trim()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Timestamp */}
              <div style={{
                fontSize: '11px',
                opacity: 0.7,
                marginTop: '8px',
                textAlign: 'left',
              }}>
                {new Date().toLocaleTimeString()} • Processing...
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
          `}
        </style>
        {/* Model Selection */}
        <div style={{ marginBottom: '12px' }}>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            style={{
              backgroundColor: '#3a3a3a',
              border: '1px solid #555',
              borderRadius: '6px',
              color: '#fff',
              padding: '8px 12px',
              fontSize: '14px',
              width: '200px'
            }}
          >
            {AI_MODELS.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>

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
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={chatMode === 'Ask' 
                ? "Ask GitHub Copilot something... Use [[]] to link notes" 
                : "Give instructions to the agent... Use [[]] to link notes"
              }
              style={{
                minHeight: '44px',
                maxHeight: '120px',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid #555',
                backgroundColor: '#3a3a3a',
                color: '#fff',
                fontSize: '14px',
                resize: 'none',
                fontFamily: 'inherit',
                width: '100%'
              }}
            />
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
              alignSelf: 'flex-end'
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
        multiple
      />

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