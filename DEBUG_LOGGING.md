# Debug Logging Guide

這個文檔描述了 Obsidian Agent Plugin 中的詳細調試日志功能，用於追蹤 tool call 的完整 input/output payload。

## 日志分類和符號

### Backend (main.ts)
- `🔧 [TOOL CALL]` - Tool 調用開始
- `📥 Input Payload` - Tool 輸入參數
- `✅ [TOOL RESULT]` - Tool 執行成功
- `📤 Output Payload` - Tool 輸出結果
- `❌ [TOOL ERROR]` - Tool 執行錯誤

### Frontend (ReactView.tsx)
- `🎯 [UI]` - UI 相關的 tool 事件
- Tool call detected - 檢測到 tool 調用
- Adding tool step - 添加 tool 步驟
- Tool result detected - 檢測到 tool 結果

### Individual Tools
- `🔍 [TOOL] vault_search` - 語義搜索工具
- `📖 [TOOL] read_note` - 讀取筆記工具
- `📂 [TOOL] list_vault` - 列出檔案工具
- `✏️ [TOOL] edit_note` - 編輯筆記工具
- `📝 [TOOL] create_note` - 創建筆記工具

## 日志內容詳解

### Tool Call Input Payload
```javascript
console.log('📥 Input Payload:', {
  tool_call_id: toolCall.id,           // OpenAI tool call ID
  function_name: toolCall.function.name, // 工具名稱
  arguments: args                      // 解析後的參數對象
});
```

### Tool Call Output Payload
```javascript
console.log('📤 Output Payload:', {
  tool_call_id: toolCall.id,          // 對應的 tool call ID
  result_length: result.length,       // 結果字符串長度
  result_preview: result.slice(0, 200), // 結果預覽（前200字符）
  full_result: result                  // 完整結果
});
```

### UI Tool Steps Tracking
```javascript
console.log('🎯 [UI] Adding tool step:', {
  id: generateId(),                    // UI 生成的步驟 ID
  type: 'call' | 'result',            // 步驟類型
  toolName: string,                    // 工具名稱
  content: string,                     // 顯示內容
  timestamp: Date,                     // 時間戳
  status: 'pending' | 'completed' | 'error' // 狀態
});
```

## 如何使用調試日志

1. **打開瀏覽器開發者工具**
   - 在 Obsidian 中按 `Ctrl+Shift+I` (Windows/Linux) 或 `Cmd+Opt+I` (Mac)
   - 切換到 Console 標籤

2. **測試 Agent 功能**
   - 在 Agent 模式下發送會觸發工具的消息
   - 觀察控制台中的詳細日志

3. **日志閱讀順序**
   ```
   🎯 [UI] Tool call initiated → 
   🔧 [TOOL CALL] → 
   📥 Input Payload → 
   🔍 [TOOL] specific tool logs → 
   ✅ [TOOL RESULT] → 
   📤 Output Payload → 
   🎯 [UI] Tool result detected
   ```

## 常見調試場景

### Tool Call 沒有觸發
- 檢查是否有 `🎯 [UI] Tool call initiated` 日志
- 確認 OpenAI API 是否正確返回 tool calls

### Tool 執行失敗
- 查看 `❌ [TOOL ERROR]` 日志
- 檢查 Input Payload 是否包含正確參數

### UI 不顯示 Tool Steps
- 確認 `🎯 [UI] Adding tool step` 日志
- 檢查狀態管理是否正確

### 消息消失問題
- 查看 `Creating final message with session` 日志
- 確認 currentToolSessionRef 是否有值

## 性能注意事項

- 調試日志會影響性能，生產環境應考慮移除
- `full_result` 可能包含大量文本，注意控制台性能
- 建議在測試完成後注釋掉不必要的日志

## 移除調試日志

如需移除調試日志，搜索以下模式：
- `console.log('🔧 [TOOL CALL]'`
- `console.log('🎯 [UI]'`
- `console.log('📥 Input Payload'`
- `console.log('📤 Output Payload'`
- 各個工具特定的日志模式

## 添加新的調試日志

遵循現有的命名模式：
1. 使用相應的 emoji 前綴
2. 包含 [分類] 標識
3. 提供結構化的 payload 對象
4. 添加描述性的消息 