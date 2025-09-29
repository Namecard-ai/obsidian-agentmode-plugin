import React, { useEffect, forwardRef, useImperativeHandle } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'

interface TiptapEditorProps {
  value: string
  onChange: (value: string) => void
  onKeyPress?: (event: React.KeyboardEvent) => void
  onPaste?: (event: React.ClipboardEvent) => void
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  chatMode?: 'Ask' | 'Agent'
}

export interface TiptapEditorRef {
  focus: () => void
  getCursorPosition: () => number
  setCursorPosition: (position: number) => void
  insertText: (text: string, position?: number) => void
  insertWikilink: (linkText: string, position?: number) => void
  replaceRangeWithWikilink: (startPos: number, endPos: number, linkText: string) => void
  clear: () => void
}

const TiptapEditor = forwardRef<TiptapEditorRef, TiptapEditorProps>(({
  value,
  onChange,
  onKeyPress,
  onPaste,
  placeholder,
  className,
  style,
  chatMode
}, ref) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable some extensions that might interfere with simple text input
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Type something...',
      }),
      Mention.configure({
        HTMLAttributes: {
          class: 'wikilink-mention',
        },
        renderText({ options, node }) {
          return `[[${node.attrs.label || node.attrs.id}]]`
        },
        // We'll manually create mention nodes for wikilinks, so disable auto-suggestion
        suggestion: {
          char: '\u0000', // Use a null character that won't be typed
          items: () => [],
          render: () => ({
            onStart: () => {},
            onUpdate: () => {},
            onKeyDown: () => false,
            onExit: () => {},
          }),
        },
      })
    ],
    content: value || '',
    editorProps: {
      attributes: {
        class: className || 'tiptap-editor',
        style: `
          min-height: 44px;
          max-height: 250px;
          overflow-y: auto;
          padding: 12px;
          border-radius: 8px;
          border: 1px solid var(--background-modifier-border);
          background-color: var(--background-secondary);
          color: var(--text-normal);
          font-size: 14px;
          font-family: inherit;
          width: 100%;
          box-sizing: border-box;
          outline: none;
          ${style ? Object.entries(style).map(([key, value]) => `${key.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${value};`).join(' ') : ''}
        `.trim()
      },
      handleKeyDown: (view, event) => {
        if (onKeyPress) {
          // Create a simplified event object that matches the expected interface
          const reactEvent = {
            key: event.key,
            code: event.code,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            currentTarget: view.dom,
            target: view.dom,
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
            nativeEvent: event,
            isDefaultPrevented: () => event.defaultPrevented,
            isPropagationStopped: () => false,
            persist: () => {},
          } as unknown as React.KeyboardEvent
          onKeyPress(reactEvent)
          
          // If Enter key without Shift was pressed, prevent TipTap from handling it
          if (event.key === 'Enter' && !event.shiftKey) {
            return true // Prevent TipTap from handling the event
          }
        }
        return false // Let TipTap handle the event
      },
      handlePaste: (view, event) => {
        if (onPaste) {
          // Create a simplified event object that matches the expected interface
          const reactEvent = {
            currentTarget: view.dom,
            target: view.dom,
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
            clipboardData: event.clipboardData,
            nativeEvent: event,
            isDefaultPrevented: () => event.defaultPrevented,
            isPropagationStopped: () => false,
            persist: () => {},
          } as unknown as React.ClipboardEvent
          onPaste(reactEvent)
        }
        return false // Let TipTap handle the event
      }
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      const text = editor.getText()
      // For simple text input, we prefer plain text
      onChange(text)
    },
  })

  // Function to convert wikilinks in text to mention nodes
  const convertWikilinksToMentions = (text: string) => {
    if (!text) return text
    
    // Parse wikilinks and convert to HTML with mention nodes
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g
    let html = text
    let match
    const mentions: Array<{ id: string, label: string }> = []
    
    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const fullMatch = match[0]
      const linkText = match[1]
      mentions.push({ id: linkText, label: linkText })
      
      // Replace with mention node HTML
      html = html.replace(fullMatch, `<span data-type="mention" data-id="${linkText}" data-label="${linkText}">[[${linkText}]]</span>`)
    }
    
    return html
  }

  // Update editor content when value prop changes
  useEffect(() => {
    if (editor && value !== editor.getText()) {
      const htmlContent = convertWikilinksToMentions(value || '')
      editor.commands.setContent(htmlContent)
    }
  }, [value, editor])

  // Expose methods through ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      editor?.commands.focus()
    },
    getCursorPosition: () => {
      if (!editor) return 0
      return editor.state.selection.from
    },
    setCursorPosition: (position: number) => {
      if (!editor) return
      editor.commands.focus()
      editor.commands.setTextSelection(position)
    },
    insertText: (text: string, position?: number) => {
      if (!editor) return
      if (position !== undefined) {
        editor.commands.focus()
        editor.commands.setTextSelection(position)
      }
      editor.commands.insertContent(text)
    },
    insertWikilink: (linkText: string, position?: number) => {
      if (!editor) return
      editor.commands.focus()
      
      if (position !== undefined) {
        // Set cursor to the specific position
        editor.commands.setTextSelection(position)
      }
      
      // Insert as a mention node with a space after it for better UX
      editor.commands.insertContent([
        {
          type: 'mention',
          attrs: {
            id: linkText,
            label: linkText,
          },
        },
        {
          type: 'text',
          text: ' ', // Add a space after the mention for better typing experience
        }
      ])
    },
    replaceRangeWithWikilink: (startPos: number, endPos: number, linkText: string) => {
      if (!editor) return
      editor.commands.focus()
      
      // Select the range to be replaced
      editor.commands.setTextSelection({ from: startPos, to: endPos })
      
      // Delete the selected content and insert the mention
      editor.commands.deleteSelection()
      editor.commands.insertContent([
        {
          type: 'mention',
          attrs: {
            id: linkText,
            label: linkText,
          },
        },
        {
          type: 'text',
          text: ' ',
        }
      ])
    },
    clear: () => {
      if (!editor) return
      editor.commands.clearContent()
      onChange('')
    }
  }), [editor, onChange])

  if (!editor) {
    return null
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <EditorContent editor={editor} />
    </div>
  )
})

TiptapEditor.displayName = 'TiptapEditor'

export default TiptapEditor
