import React, { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { Notice } from 'obsidian';

// Lazy load syntax highlighting components
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

// Custom code block component with line numbers and copy button support
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

  // If it's inline code
  if (inline) {
    return (
      <code 
        style={{
          backgroundColor: 'var(--background-secondary-alt)',
          color: 'var(--text-normal)',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.9em',
          fontFamily: 'var(--font-monospace)'
        }}
      >
        {children}
      </code>
    );
  }

  // Extract language
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';

  return (
    <div style={{
      position: 'relative',
      marginBottom: '16px',
      borderRadius: '8px',
      overflow: 'hidden',
      backgroundColor: 'var(--background-secondary)',
      border: '1px solid var(--background-modifier-border)'
    }}>
      {/* Code block header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        backgroundColor: 'var(--background-secondary-alt)',
        borderBottom: '1px solid var(--background-modifier-border)',
        fontSize: '13px',
        color: 'var(--text-muted)'
      }}>
        <span style={{ fontWeight: '500' }}>{language}</span>
        <button
          onClick={handleCopy}
          style={{
            background: 'none',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            color: copied ? 'var(--text-success)' : 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px 8px',
            fontSize: '12px',
            transition: 'all 0.2s ease',
            fontFamily: 'inherit'
          }}
          onMouseEnter={(e) => {
            if (!copied) {
              e.currentTarget.style.borderColor = 'var(--background-modifier-border-hover)';
              e.currentTarget.style.color = 'var(--text-normal)';
            }
          }}
          onMouseLeave={(e) => {
            if (!copied) {
              e.currentTarget.style.borderColor = 'var(--background-modifier-border)';
              e.currentTarget.style.color = 'var(--text-muted)';
            }
          }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>

      {/* Syntax highlighted code block */}
      <Suspense fallback={
        <div style={{
          padding: '16px',
          fontFamily: 'var(--font-monospace)',
          fontSize: '14px',
          lineHeight: '1.5',
          color: 'var(--text-normal)',
          backgroundColor: 'var(--background-secondary)',
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

// Lazy loaded syntax highlighting component
const LazyCodeHighlighter: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [isLightTheme, setIsLightTheme] = useState(false);
  const [style, setStyle] = useState<any>({});

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLightTheme(document.body.classList.contains('theme-light'));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    setIsLightTheme(document.body.classList.contains('theme-light')); // Initial check

    return () => observer.disconnect();
  }, []);
  
  useEffect(() => {
    if (isLightTheme) {
      import('react-syntax-highlighter/dist/esm/styles/prism').then(module => {
        setStyle(module.oneLight);
      });
    } else {
      import('react-syntax-highlighter/dist/esm/styles/prism').then(module => {
        setStyle(module.oneDark);
      });
    }
  }, [isLightTheme]);
  
  return (
    <Suspense fallback={
      <div style={{
        padding: '16px',
        fontFamily: 'var(--font-monospace)',
        fontSize: '14px',
        lineHeight: '1.5',
        color: 'var(--text-normal)',
        backgroundColor: 'var(--background-secondary)',
        whiteSpace: 'pre-wrap'
      }}>
        {code}
      </div>
    }>
      <LazySyntaxHighlighter
        language={language}
        style={style}
        showLineNumbers={true}
        wrapLines={true}
        customStyle={{
          margin: 0,
          padding: '16px',
          backgroundColor: 'transparent', // Let parent handle background
          fontSize: '14px',
          lineHeight: '1.5'
        }}
        lineNumberStyle={{
          minWidth: '3em',
          paddingRight: '1em',
          color: 'var(--text-muted)',
          backgroundColor: 'transparent',
          borderRight: '1px solid var(--background-modifier-border)',
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
  plugin?: any; // ObsidianCopilot plugin instance
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ 
  content, 
  className = '', 
  style = {},
  plugin
}) => {
  // Process content to make file paths clickable
  const processedContent = React.useMemo(() => {
    if (!plugin) return content;
    
    // Pattern to match file paths like Personal/daily_journals/2025-07-27.md
    const filePathPattern = /(?:^|\s)((?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-]+\.md)(?=\s|$)/g;
    
    // Convert file paths to markdown links
    return content.replace(filePathPattern, (match, path) => {
      return match.replace(path, `[${path}](${path})`);
    });
  }, [content, plugin]);
  return (
    <div className={className} style={style}>
      <Suspense fallback={
        <div style={{
          whiteSpace: 'pre-wrap',
          lineHeight: '1.5',
          color: '#ffffff'
        }}>
          {processedContent}
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
            h1: ({ children, ...props }) => (
              <h1 {...props}>
                {children}
              </h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 {...props}>
                {children}
              </h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 {...props}>
                {children}
              </h3>
            ),
            h4: ({ children, ...props }) => (
              <h4 {...props}>
                {children}
              </h4>
            ),
            h5: ({ children, ...props }) => (
              <h5 {...props}>
                {children}
              </h5>
            ),
            h6: ({ children, ...props }) => (
              <h6 {...props}>
                {children}
              </h6>
            ),
            p: ({ children, ...props }) => (
              <p style={{ lineHeight: '1.6', marginBottom: '16px' }} {...props}>
                {children}
              </p>
            ),
            strong: ({ children, ...props }) => (
              <strong style={{ fontWeight: '600' }} {...props}>
                {children}
              </strong>
            ),
            em: ({ children, ...props }) => (
              <em {...props}>
                {children}
              </em>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote style={{ 
                borderLeft: '4px solid var(--background-modifier-border)',
                paddingLeft: '16px',
                color: 'var(--text-muted)',
                margin: '0 0 16px 0'
              }} {...props}>
                {children}
              </blockquote>
            ),
            ul: ({ children, ...props }) => (
              <ul style={{ marginBottom: '16px', paddingLeft: '24px' }} {...props}>
                {children}
              </ul>
            ),
            ol: ({ children, ...props }) => (
              <ol style={{ marginBottom: '16px', paddingLeft: '24px' }} {...props}>
                {children}
              </ol>
            ),
            li: ({ children, ...props }) => (
              <li style={{ marginBottom: '8px' }} {...props}>
                {children}
              </li>
            ),
            a: ({ children, href, ...props }) => {
              // Check if this is a file path or wiki link
              const isFilePath = href && (href.endsWith('.md') || href.includes('/'));
              const isWikiLink = href && href.startsWith('[[') && href.endsWith(']]');
              
              const handleClick = (e: React.MouseEvent) => {
                if ((isFilePath || isWikiLink) && plugin) {
                  e.preventDefault();
                  const path = isWikiLink ? href.slice(2, -2) : href;
                  // Use Obsidian's API to open the file
                  plugin.app.workspace.openLinkText(path, '', false);
                }
              };
              
              return (
                <a 
                  style={{ 
                    color: 'var(--text-accent)',
                    cursor: (isFilePath || isWikiLink) ? 'pointer' : 'default',
                    textDecoration: 'underline'
                  }} 
                  onClick={handleClick}
                  href={href}
                  {...props}
                >
                  {children}
                </a>
              );
            },
            table: ({ children, ...props }) => (
              <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  backgroundColor: 'var(--background-secondary)',
                  borderRadius: '6px',
                  overflow: 'hidden'
                }} {...props}>
                  {children}
                </table>
              </div>
            ),
            th: ({ children, ...props }) => (
              <th style={{
                backgroundColor: 'var(--background-secondary-alt)',
                color: 'var(--text-normal)',
                padding: '12px',
                textAlign: 'left',
                borderBottom: '2px solid var(--background-modifier-border)',
                fontWeight: '600'
              }} {...props}>
                {children}
              </th>
            ),
            td: ({ children, ...props }) => (
              <td style={{
                color: 'var(--text-normal)',
                padding: '12px',
                borderBottom: '1px solid var(--background-modifier-border)'
              }} {...props}>
                {children}
              </td>
            ),
            hr: ({ ...props }) => (
              <hr style={{ border: 'none', borderTop: '1px solid var(--background-modifier-border)', margin: '32px 0' }} {...props} />
            )
          }}
        >
          {processedContent}
        </LazyMarkdown>
      </Suspense>
    </div>
  );
};

export default MarkdownRenderer; 