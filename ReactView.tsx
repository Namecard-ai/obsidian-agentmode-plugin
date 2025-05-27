import { useState, useRef, useEffect } from 'react';
import { FuzzySuggestModal, TFile, App } from 'obsidian';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
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
}

export const ReactView = ({ app }: ReactViewProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0]);
  const [chatMode, setChatMode] = useState<'Ask' | 'Agent'>('Ask');
  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const generateId = () => Math.random().toString(36).substr(2, 9);

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

    // Simulate AI response
    setTimeout(() => {
      let responseContent = chatMode === 'Ask' 
        ? `This is a simulated response from ${selectedModel} in Ask mode. In a real implementation, this would connect to the actual AI service to answer your question.`
        : `This is a simulated response from ${selectedModel} in Agent mode. In a real implementation, the agent would execute tasks and provide updates on the progress.`;
      
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

  const handleAddContext = () => {
    const modal = new FilePickerModal(app, (file: TFile) => {
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
    });
    modal.open();
  };

  const removeContextFile = (fileId: string) => {
    setContextFiles(prev => prev.filter(cf => cf.id !== fileId));
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#1e1e1e',
      color: '#ffffff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
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
          messages.map(message => (
            <div
              key={message.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: message.type === 'user' ? 'flex-end' : 'flex-start'
              }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  backgroundColor: message.type === 'user' ? '#0066cc' : '#3a3a3a',
                  color: '#fff',
                  fontSize: '14px',
                  lineHeight: '1.4'
                }}
              >
                {message.content}
              </div>
              <div style={{
                fontSize: '12px',
                color: '#888',
                marginTop: '4px',
                marginLeft: message.type === 'user' ? 'auto' : '0',
                marginRight: message.type === 'user' ? '0' : 'auto'
              }}>
                {message.timestamp.toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        
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
              Thinking...
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
                  onClick={() => removeContextFile(contextFile.id)}
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
    </div>
  );
};