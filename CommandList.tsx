import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react'

interface Command {
  name: string
  prompt: string
}

interface CommandListProps {
  items: Command[]
  command: (item: Command) => void
}

export interface CommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

const CommandList = forwardRef<CommandListRef, CommandListProps>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const selectItem = (index: number) => {
    const item = props.items[index]
    if (item) {
      props.command(item)
    }
  }

  const upHandler = () => {
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length)
  }

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length)
  }

  const enterHandler = () => {
    selectItem(selectedIndex)
  }

  useEffect(() => setSelectedIndex(0), [props.items])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler()
        return true
      }

      if (event.key === 'ArrowDown') {
        downHandler()
        return true
      }

      if (event.key === 'Enter') {
        enterHandler()
        return true
      }

      return false
    },
  }))

  if (props.items.length === 0) {
    return (
      <div className="agentmode-slash-command-list">
        <div className="agentmode-slash-command-empty">
          No commands found
        </div>
      </div>
    )
  }

  return (
    <div className="agentmode-slash-command-list">
      {props.items.map((item, index) => (
        <button
          className={`agentmode-slash-command-item ${index === selectedIndex ? 'is-selected' : ''}`}
          key={item.name}
          onClick={() => selectItem(index)}
        >
          <div className="agentmode-slash-command-name">
            /{item.name}
          </div>
          <div className="agentmode-slash-command-prompt">
            {item.prompt.length > 60 ? item.prompt.substring(0, 60) + '...' : item.prompt}
          </div>
        </button>
      ))}
    </div>
  )
})

CommandList.displayName = 'CommandList'

export default CommandList

