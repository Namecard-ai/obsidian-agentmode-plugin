import React, { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { Notice } from 'obsidian';

// 懶加載語法高亮組件
const LazyMarkdown = lazy(() => import('react-markdown'));
const LazySyntaxHighlighter = lazy(() => 
  import('react-syntax-highlighter').then(module => ({
    default: module.Prism
  }))
);

interface CodeBlockProps {
  children: string;
  className?: string;
  inline?: boolean;
}

// 自定義代碼區塊組件，支援行號和複製按鈕
const CodeBlock: React.FC<CodeBlockProps> = ({ children, className, inline }) => {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      new Notice('Code copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
      new Notice('Copy failed');
    }
  }, [children]);

  // 如果是行內代碼
  if (inline) {
    return (
      <code 
        style={{
          backgroundColor: '#3a3a3a',
          color: '#e1e1e1',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.9em',
          fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace'
        }}
      >
        {children}
      </code>
    );
  }

  // 提取語言
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';

  return (
    <div style={{
      position: 'relative',
      marginBottom: '16px',
      borderRadius: '8px',
      overflow: 'hidden',
      backgroundColor: '#1e1e1e',
      border: '1px solid #444'
    }}>
      {/* 代碼區塊頭部 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        backgroundColor: '#2d2d2d',
        borderBottom: '1px solid #444',
        fontSize: '13px',
        color: '#bbb'
      }}>
        <span style={{ fontWeight: '500' }}>{language}</span>
        <button
          onClick={handleCopy}
          style={{
            background: 'none',
            border: '1px solid #555',
            borderRadius: '4px',
            color: copied ? '#4ade80' : '#bbb',
            cursor: 'pointer',
            padding: '4px 8px',
            fontSize: '12px',
            transition: 'all 0.2s ease',
            fontFamily: 'inherit'
          }}
          onMouseEnter={(e) => {
            if (!copied) {
              e.currentTarget.style.borderColor = '#777';
              e.currentTarget.style.color = '#fff';
            }
          }}
          onMouseLeave={(e) => {
            if (!copied) {
              e.currentTarget.style.borderColor = '#555';
              e.currentTarget.style.color = '#bbb';
            }
          }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>

      {/* 語法高亮代碼區塊 */}
      <Suspense fallback={
        <div style={{
          padding: '16px',
          fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
          fontSize: '14px',
          lineHeight: '1.5',
          color: '#e1e1e1',
          backgroundColor: '#1e1e1e',
          whiteSpace: 'pre-wrap'
        }}>
          {children}
        </div>
      }>
        <LazyCodeHighlighter language={language} code={children} />
      </Suspense>
    </div>
  );
};

// 懶加載的語法高亮組件
const LazyCodeHighlighter: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [darkStyle, setDarkStyle] = useState<any>(null);
  
  useEffect(() => {
    import('react-syntax-highlighter/dist/esm/styles/prism').then(module => {
      setDarkStyle(module.oneDark);
    });
  }, []);
  
  return (
    <Suspense fallback={
      <div style={{
        padding: '16px',
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
        fontSize: '14px',
        lineHeight: '1.5',
        color: '#e1e1e1',
        backgroundColor: '#1e1e1e',
        whiteSpace: 'pre-wrap'
      }}>
        {code}
      </div>
    }>
      <LazySyntaxHighlighter
        language={language}
        style={darkStyle || {}}
        showLineNumbers={true}
        wrapLines={true}
        customStyle={{
          margin: 0,
          padding: '16px',
          backgroundColor: '#1e1e1e',
          fontSize: '14px',
          lineHeight: '1.5'
        }}
        lineNumberStyle={{
          minWidth: '3em',
          paddingRight: '1em',
          color: '#666',
          backgroundColor: 'transparent',
          borderRight: '1px solid #444',
          marginRight: '1em'
        }}
      >
        {code}
      </LazySyntaxHighlighter>
    </Suspense>
  );
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ 
  content, 
  className = '', 
  style = {} 
}) => {
  return (
    <div className={className} style={style}>
      <Suspense fallback={
        <div style={{
          whiteSpace: 'pre-wrap',
          lineHeight: '1.5',
          color: '#ffffff'
        }}>
          {content}
        </div>
      }>
        <LazyMarkdown
          components={{
            code: ({ node, inline, className, children, ...props }: any) => (
              <CodeBlock
                inline={inline}
                className={className}
                {...props}
              >
                {String(children).replace(/\n$/, '')}
              </CodeBlock>
            ),
            // 自定義其他元素的樣式以符合深色主題
            h1: ({ children, ...props }) => (
              <h1 style={{ color: '#ffffff', borderBottom: '2px solid #444', paddingBottom: '8px' }} {...props}>
                {children}
              </h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 style={{ color: '#ffffff', borderBottom: '1px solid #444', paddingBottom: '6px' }} {...props}>
                {children}
              </h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 style={{ color: '#ffffff' }} {...props}>
                {children}
              </h3>
            ),
            h4: ({ children, ...props }) => (
              <h4 style={{ color: '#ffffff' }} {...props}>
                {children}
              </h4>
            ),
            h5: ({ children, ...props }) => (
              <h5 style={{ color: '#ffffff' }} {...props}>
                {children}
              </h5>
            ),
            h6: ({ children, ...props }) => (
              <h6 style={{ color: '#ffffff' }} {...props}>
                {children}
              </h6>
            ),
            p: ({ children, ...props }) => (
              <p style={{ color: '#ffffff', lineHeight: '1.6', marginBottom: '16px' }} {...props}>
                {children}
              </p>
            ),
            strong: ({ children, ...props }) => (
              <strong style={{ color: '#ffffff', fontWeight: '600' }} {...props}>
                {children}
              </strong>
            ),
            em: ({ children, ...props }) => (
              <em style={{ color: '#ffffff', fontStyle: 'italic' }} {...props}>
                {children}
              </em>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote style={{
                borderLeft: '4px solid #555',
                paddingLeft: '16px',
                margin: '16px 0',
                color: '#bbb',
                fontStyle: 'italic',
                backgroundColor: '#2a2a2a',
                padding: '12px 16px',
                borderRadius: '4px'
              }} {...props}>
                {children}
              </blockquote>
            ),
            ul: ({ children, ...props }) => (
              <ul style={{ color: '#ffffff', paddingLeft: '20px', marginBottom: '16px' }} {...props}>
                {children}
              </ul>
            ),
            ol: ({ children, ...props }) => (
              <ol style={{ color: '#ffffff', paddingLeft: '20px', marginBottom: '16px' }} {...props}>
                {children}
              </ol>
            ),
            li: ({ children, ...props }) => (
              <li style={{ color: '#ffffff', marginBottom: '4px' }} {...props}>
                {children}
              </li>
            ),
            a: ({ children, href, ...props }) => (
              <a 
                href={href} 
                style={{ 
                  color: '#4fc3f7', 
                  textDecoration: 'underline',
                  transition: 'color 0.2s ease'
                }} 
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#81d4fa';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = '#4fc3f7';
                }}
                {...props}
              >
                {children}
              </a>
            ),
            table: ({ children, ...props }) => (
              <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  backgroundColor: '#2a2a2a',
                  borderRadius: '6px',
                  overflow: 'hidden'
                }} {...props}>
                  {children}
                </table>
              </div>
            ),
            th: ({ children, ...props }) => (
              <th style={{
                backgroundColor: '#3a3a3a',
                color: '#ffffff',
                padding: '12px',
                textAlign: 'left',
                borderBottom: '2px solid #555',
                fontWeight: '600'
              }} {...props}>
                {children}
              </th>
            ),
            td: ({ children, ...props }) => (
              <td style={{
                color: '#ffffff',
                padding: '12px',
                borderBottom: '1px solid #444'
              }} {...props}>
                {children}
              </td>
            ),
            hr: ({ ...props }) => (
              <hr style={{
                border: 'none',
                borderTop: '2px solid #444',
                margin: '24px 0'
              }} {...props} />
            )
          }}
        >
          {content}
        </LazyMarkdown>
      </Suspense>
    </div>
  );
};

export default MarkdownRenderer; 