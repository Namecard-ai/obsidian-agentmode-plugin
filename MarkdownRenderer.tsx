import React, { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { Notice } from 'obsidian';
import type AgentPlugin from './main';

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
      window.setTimeout(() => setCopied(false), 2000);
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
          onClick={() => {
            handleCopy().catch((error) => {
              console.error('Failed to copy code:', error);
              new Notice('Failed to copy code');
            });
          }}
          className="agentmode-copy-button-styled"
          style={{
            color: copied ? 'var(--text-success)' : undefined,
            fontFamily: 'inherit'
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
  const [style, setStyle] = useState<Record<string, unknown>>({});

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
      }).catch((error) => {
        console.error('Failed to load light theme style:', error);
      });
    } else {
      import('react-syntax-highlighter/dist/esm/styles/prism').then(module => {
        setStyle(module.oneDark);
      }).catch((error) => {
        console.error('Failed to load dark theme style:', error);
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
  plugin?: AgentPlugin;
}

// Helper function to detect and convert table-like content to proper markdown tables
const preprocessTableContent = (content: string): string => {
  // First, handle tables inside code blocks
  // Pattern to match code blocks with optional language specifier
  const codeBlockPattern = /```(?:markdown|md|)?\n([\s\S]*?)```/g;

  const processedContent = content.replace(codeBlockPattern, (match, codeContent) => {
    // Check if this code block contains a table
    const lines = codeContent.split('\n');
    let hasTable = false;

    // Check if any line looks like a table (has 2+ pipes)
    for (const line of lines) {
      const pipesCount = (line.match(/\|/g) || []).length;
      if (pipesCount >= 2) {
        hasTable = true;
        break;
      }
    }

    // If it's a table in a code block, extract and process it
    if (hasTable) {
      // Check if it's already a well-formed markdown table
      const hasHeaderSeparator = lines.some((line: string) =>
        line.match(/^\s*\|?\s*[-\s]+\|[-\s|]+\s*\|?\s*$/)
      );

      if (hasHeaderSeparator) {
        // It's already a properly formatted table, just return it without code block
        return codeContent.trim();
      } else {
        // Process it as a table
        return processTableLines(lines);
      }
    }

    // Not a table, keep the code block as is
    return match;
  });

  // Then process any remaining tables not in code blocks
  const lines = processedContent.split('\n');
  const processedLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip if this line is part of a code block (remaining ones)
    if (line.startsWith('```')) {
      processedLines.push(line);
      i++;
      // Copy all lines until the closing ```
      while (i < lines.length && !lines[i].startsWith('```')) {
        processedLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        processedLines.push(lines[i]); // Add the closing ```
        i++;
      }
      continue;
    }

    // Check if this line looks like a table row (has 2+ pipe separators)
    const pipesCount = (line.match(/\|/g) || []).length;

    if (pipesCount >= 2) {
      // This might be a table, collect all consecutive table-like lines
      const tableLines: string[] = [];
      let j = i;

      while (j < lines.length) {
        const currentLine = lines[j];
        const currentPipes = (currentLine.match(/\|/g) || []).length;

        // Check if it's part of the table (has pipes or is a separator line)
        if (currentPipes >= 2 || currentLine.match(/^\s*[|\s-]+$/)) {
          tableLines.push(currentLine);
          j++;
        } else {
          break;
        }
      }

      // Process the table if we found table-like content
      if (tableLines.length > 0) {
        const processedTable = formatAsMarkdownTable(tableLines);
        processedLines.push(...processedTable);
        i = j; // Skip the lines we just processed
      } else {
        processedLines.push(line);
        i++;
      }
    } else {
      processedLines.push(line);
      i++;
    }
  }

  return processedLines.join('\n');
};

// Helper function to process table lines and return formatted string
const processTableLines = (lines: string[]): string => {
  const tableLines = lines.filter(line => {
    const pipesCount = (line.match(/\|/g) || []).length;
    return pipesCount >= 2 || line.match(/^\s*[|\s-]+$/);
  });

  if (tableLines.length === 0) {
    return lines.join('\n');
  }

  const formattedTable = formatAsMarkdownTable(tableLines);
  return formattedTable.join('\n');
};

// Helper function to format table lines as proper markdown table
const formatAsMarkdownTable = (tableLines: string[]): string[] => {
  if (tableLines.length === 0) return tableLines;

  const result: string[] = [];

  // Parse all rows to find the structure
  const rows = tableLines.map(line => {
    // Split by pipe and clean up each cell
    const cells = line.split('|').map(cell => cell.trim());

    // Remove empty cells at the beginning and end
    while (cells.length > 0 && cells[0] === '') cells.shift();
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();

    return cells;
  });

  // Filter out empty rows
  const nonEmptyRows = rows.filter(row => row.length > 0);
  if (nonEmptyRows.length === 0) return tableLines;

  // Determine the maximum number of columns
  const maxColumns = Math.max(...nonEmptyRows.map(row => row.length));

  // Normalize all rows to have the same number of columns
  const normalizedRows = nonEmptyRows.map(row => {
    while (row.length < maxColumns) {
      row.push('');
    }
    return row;
  });

  // Check if there's already a separator line (line with only dashes and pipes)
  let hasSeparator = false;
  let separatorIndex = -1;

  for (let i = 0; i < normalizedRows.length; i++) {
    const row = normalizedRows[i];
    if (row.every(cell => cell.match(/^[\s-]*$/))) {
      hasSeparator = true;
      separatorIndex = i;
      break;
    }
  }

  // If there's no separator, treat the first row as header and add separator
  if (!hasSeparator && normalizedRows.length > 0) {
    // Format the header row
    result.push('| ' + normalizedRows[0].join(' | ') + ' |');

    // Add separator
    const separator = normalizedRows[0].map(() => '---').join(' | ');
    result.push('| ' + separator + ' |');

    // Add data rows
    for (let i = 1; i < normalizedRows.length; i++) {
      result.push('| ' + normalizedRows[i].join(' | ') + ' |');
    }
  } else if (hasSeparator) {
    // There's already a separator, format accordingly
    for (let i = 0; i < normalizedRows.length; i++) {
      if (i === separatorIndex) {
        // Replace the separator with a proper one
        const separator = normalizedRows[0].map(() => '---').join(' | ');
        result.push('| ' + separator + ' |');
      } else {
        result.push('| ' + normalizedRows[i].join(' | ') + ' |');
      }
    }
  } else {
    // Just format as is
    for (const row of normalizedRows) {
      result.push('| ' + row.join(' | ') + ' |');
    }
  }

  return result;
};

// Component that loads and uses remarkGfm
const MarkdownWithGfm: React.FC<{ content: string; plugin?: AgentPlugin; components: Record<string, React.ComponentType<unknown>> }> = ({ content, plugin: _plugin, components }) => {
  const [remarkGfm, setRemarkGfm] = useState<((options?: unknown) => void) | null>(null);

  useEffect(() => {
    import('remark-gfm').then(module => {
      setRemarkGfm(() => module.default);
    }).catch((error) => {
      console.error('Failed to load remark-gfm:', error);
    });
  }, []);

  if (!remarkGfm) {
    // Fallback while loading
    return (
      <div style={{
        whiteSpace: 'pre-wrap',
        lineHeight: '1.5',
        color: 'var(--text-normal)'
      }}>
        {content}
      </div>
    );
  }

  return (
    <LazyMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
    >
      {content}
    </LazyMarkdown>
  );
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = '',
  style = {},
  plugin
}) => {
  // Process content to make file paths clickable and format tables
  const processedContent = React.useMemo(() => {
    let processed = content;

    // First, preprocess table content
    processed = preprocessTableContent(processed);

    // Then, process file paths if plugin is available
    if (plugin) {
      // Pattern to match file paths like Personal/daily_journals/2025-07-27.md
      const filePathPattern = /(?:^|\s)((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md)(?=\s|$)/g;

      // Convert file paths to markdown links
      processed = processed.replace(filePathPattern, (match, path) => {
        return match.replace(path, `[${path}](${path})`);
      });
    }

    return processed;
  }, [content, plugin]);

  // Helper function to safely extract text content from children
  const extractTextContent = (children: React.ReactNode): string => {
    if (children === null || children === undefined) {
      return '';
    }
    if (typeof children === 'string' || typeof children === 'number') {
      return String(children);
    }
    if (Array.isArray(children)) {
      return children.map(extractTextContent).join('');
    }
    // For React elements or other objects, return empty string to avoid [object Object]
    return '';
  };

  const markdownComponents = React.useMemo(() => ({
    code: ({ node, inline, className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown; inline?: boolean }) => (
      <CodeBlock
        inline={inline}
        className={className}
        {...props}
      >
        {extractTextContent(children).replace(/\n$/, '')}
      </CodeBlock>
    ),
    h1: ({ children, ...props }: React.ComponentPropsWithoutRef<'h1'>) => (
      <h1 {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, ...props }: React.ComponentPropsWithoutRef<'h2'>) => (
      <h2 {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }: React.ComponentPropsWithoutRef<'h3'>) => (
      <h3 {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, ...props }: React.ComponentPropsWithoutRef<'h4'>) => (
      <h4 {...props}>
        {children}
      </h4>
    ),
    h5: ({ children, ...props }: React.ComponentPropsWithoutRef<'h5'>) => (
      <h5 {...props}>
        {children}
      </h5>
    ),
    h6: ({ children, ...props }: React.ComponentPropsWithoutRef<'h6'>) => (
      <h6 {...props}>
        {children}
      </h6>
    ),
    p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => (
      <p style={{ lineHeight: '1.6', marginBottom: '16px' }} {...props}>
        {children}
      </p>
    ),
    strong: ({ children, ...props }: React.ComponentPropsWithoutRef<'strong'>) => (
      <strong style={{ fontWeight: '600' }} {...props}>
        {children}
      </strong>
    ),
    em: ({ children, ...props }: React.ComponentPropsWithoutRef<'em'>) => (
      <em {...props}>
        {children}
      </em>
    ),
    blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<'blockquote'>) => (
      <blockquote style={{
        borderLeft: '4px solid var(--background-modifier-border)',
        paddingLeft: '16px',
        color: 'var(--text-muted)',
        margin: '0 0 16px 0'
      }} {...props}>
        {children}
      </blockquote>
    ),
    ul: ({ children, ...props }: React.ComponentPropsWithoutRef<'ul'>) => (
      <ul style={{ marginBottom: '16px', paddingLeft: '24px' }} {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }: React.ComponentPropsWithoutRef<'ol'>) => (
      <ol style={{ marginBottom: '16px', paddingLeft: '24px' }} {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
      <li style={{ marginBottom: '8px' }} {...props}>
        {children}
      </li>
    ),
    a: ({ children, href, ...props }: React.ComponentPropsWithoutRef<'a'>) => {
      // Check if this is a file path or wiki link
      const isFilePath = href && (href.endsWith('.md') || href.includes('/'));
      const isWikiLink = href && href.startsWith('[[') && href.endsWith(']]');

      const handleClick = (e: React.MouseEvent) => {
        if ((isFilePath || isWikiLink) && plugin) {
          e.preventDefault();
          const path = isWikiLink ? href.slice(2, -2) : href;
          // Use Obsidian's API to open the file
          plugin.app.workspace.openLinkText(path, '', false).catch((error: unknown) => {
            console.error('Failed to open link:', error);
          });
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
    table: ({ children, ...props }: React.ComponentPropsWithoutRef<'table'>) => (
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
    th: ({ children, ...props }: React.ComponentPropsWithoutRef<'th'>) => (
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
    td: ({ children, ...props }: React.ComponentPropsWithoutRef<'td'>) => (
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
  }), [plugin]);

  return (
    <div className={className} style={style}>
      <Suspense fallback={
        <div style={{
          whiteSpace: 'pre-wrap',
          lineHeight: '1.5',
          color: 'var(--text-normal)'
        }}>
          {processedContent}
        </div>
      }>
        <MarkdownWithGfm
          content={processedContent}
          plugin={plugin}
          components={markdownComponents}
        />
      </Suspense>
    </div>
  );
};

export default MarkdownRenderer; 