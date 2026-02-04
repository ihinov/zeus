/**
 * Chat Component - Reusable chat interface for AI daemons
 *
 * Usage:
 *   const chat = new ChatComponent({
 *     container: document.getElementById('chat-container'),
 *     wsUrl: 'ws://localhost:3001',
 *     provider: 'claude',
 *     model: 'sonnet',
 *     avatarIcon: 'C',
 *     onStreamingChange: (isStreaming) => { ... }
 *   });
 *
 *   chat.connect();
 *   chat.sendMessage('Hello');
 *   chat.destroy();
 */

class ChatComponent {
  constructor(options = {}) {
    this.container = options.container;
    this.wsUrl = options.wsUrl || 'ws://localhost:3001';
    this.provider = options.provider || 'claude';
    this.model = options.model || null;
    this.avatarIcon = options.avatarIcon || this.provider.charAt(0).toUpperCase();
    this.userAvatarIcon = options.userAvatarIcon || 'U';
    this.onStreamingChange = options.onStreamingChange || null;
    this.onError = options.onError || null;
    this.onConnected = options.onConnected || null;
    this.onMessageAdded = options.onMessageAdded || null;

    // Session tracking
    this.sessionId = options.sessionId || null;

    this.socket = null;
    this.messages = [];
    this.currentStreamingMessage = null;
    this.currentStreamingContent = '';
    this.currentStreamingThinking = '';
    this.currentStreamingToolCalls = [];
    this.isStreaming = false;
    this.isConnected = false;

    this.elements = {};

    if (this.container) {
      this.render();
      this.bindEvents();
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  // ============ RENDERING ============

  render() {
    this.container.innerHTML = `
      <div class="chat-container">
        <div class="chat-messages" data-chat-messages>
          <div class="chat-empty">
            <div class="chat-empty-icon">...</div>
            <div>Start a conversation</div>
          </div>
        </div>
        <div class="chat-input-area">
          <div class="chat-input-box">
            <textarea
              class="chat-input-field"
              data-chat-input
              rows="1"
              placeholder="Type a message..."
            ></textarea>
            <div class="chat-input-footer">
              <div class="chat-input-actions">
                <button class="chat-send-btn" data-chat-send>Send</button>
              </div>
              <div class="chat-model-info" data-chat-model>${this.model || this.provider}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Cache element references
    this.elements = {
      messages: this.container.querySelector('[data-chat-messages]'),
      input: this.container.querySelector('[data-chat-input]'),
      sendBtn: this.container.querySelector('[data-chat-send]'),
      modelInfo: this.container.querySelector('[data-chat-model]'),
    };
  }

  bindEvents() {
    const { input, sendBtn } = this.elements;

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendFromInput();
      }
    });

    // Send button click
    sendBtn.addEventListener('click', () => this.sendFromInput());
  }

  sendFromInput() {
    const { input } = this.elements;
    const text = input.value.trim();

    if (text && !this.isStreaming) {
      this.sendMessage(text);
      input.value = '';
      input.style.height = 'auto';
    }
  }

  // ============ CONNECTION ============

  connect() {
    if (this.socket) {
      this.socket.close();
    }

    try {
      this.socket = new WebSocket(this.wsUrl);

      this.socket.onopen = () => {
        console.log('[Chat] Connected to gateway');
        this.isConnected = true;
        if (this.onConnected) this.onConnected();
      };

      this.socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleEvent(msg);
        } catch (err) {
          console.error('[Chat] Failed to parse message:', err);
        }
      };

      this.socket.onclose = () => {
        console.log('[Chat] Disconnected from gateway');
        this.socket = null;
        this.isConnected = false;
      };

      this.socket.onerror = (err) => {
        console.error('[Chat] WebSocket error:', err);
        if (this.onError) this.onError(err);
      };
    } catch (err) {
      console.error('[Chat] Failed to connect:', err);
      if (this.onError) this.onError(err);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  // ============ EVENT HANDLING ============

  handleEvent(msg) {
    console.log('[Chat] Received event:', msg.type, msg.payload);

    switch (msg.type) {
      case 'connected':
        console.log('[Chat] Gateway session:', msg.payload);
        break;

      case 'thinking':
        this.setStreamingState(true);
        // Show thinking indicator if no message yet
        if (!this.currentStreamingMessage) {
          this.currentStreamingMessage = this.addMessage('assistant', '');
          this.currentStreamingContent = '';
          this.currentStreamingThinking = '';
          this.currentStreamingToolCalls = [];
          this.showThinkingIndicator(this.currentStreamingMessage);
        }
        break;

      case 'streaming':
        this.setStreamingState(true);
        if (!this.currentStreamingMessage) {
          this.currentStreamingMessage = this.addMessage('assistant', '');
          this.currentStreamingContent = '';
          this.currentStreamingThinking = '';
          this.currentStreamingToolCalls = [];
          this.showThinkingIndicator(this.currentStreamingMessage);
        }
        break;

      case 'content_delta':
        if (!this.currentStreamingMessage) {
          this.currentStreamingMessage = this.addMessage('assistant', '');
          this.currentStreamingContent = '';
          this.currentStreamingThinking = '';
          this.currentStreamingToolCalls = [];
        }
        // Clear thinking indicator on first content
        if (this.currentStreamingContent === '') {
          this.hideThinkingIndicator(this.currentStreamingMessage);
        }
        const text = msg.payload?.text || '';
        this.currentStreamingContent += text;
        this.appendToMessage(this.currentStreamingMessage, text);
        break;

      case 'thought':
        if (this.currentStreamingMessage) {
          const thought = msg.payload?.text;
          if (thought) {
            this.currentStreamingThinking += thought + '\n';
            this.addThinkingToMessage(this.currentStreamingMessage, thought);
          }
        }
        break;

      case 'tool_call':
        this.setStreamingState(true);
        // Create message if needed
        if (!this.currentStreamingMessage) {
          this.currentStreamingMessage = this.addMessage('assistant', '');
          this.currentStreamingContent = '';
          this.currentStreamingThinking = '';
          this.currentStreamingToolCalls = [];
          this.showThinkingIndicator(this.currentStreamingMessage);
        }
        const toolCall = { ...msg.payload, status: 'running' };
        this.currentStreamingToolCalls.push(toolCall);
        this.addToolCallToMessage(this.currentStreamingMessage, msg.payload, 'running');
        break;

      case 'tool_result':
        if (this.currentStreamingMessage) {
          // Update tool call with result
          const toolId = msg.payload?.id;
          const toolCall = this.currentStreamingToolCalls.find(tc => tc.id === toolId);
          if (toolCall) {
            toolCall.result = msg.payload?.result;
            toolCall.status = 'done';
          }
          this.updateToolCallInMessage(this.currentStreamingMessage, msg.payload);
        }
        break;

      case 'content':
        // Final content - already handled by deltas
        break;

      case 'done':
        this.setStreamingState(false);
        if (this.currentStreamingMessage) {
          this.finalizeMessage(this.currentStreamingMessage);

          // Emit message added event with full content
          if (this.onMessageAdded) {
            this.onMessageAdded({
              role: 'assistant',
              content: this.currentStreamingContent,
              thinking: this.currentStreamingThinking || null,
              toolCalls: this.currentStreamingToolCalls.length > 0 ? this.currentStreamingToolCalls : null
            });
          }

          this.currentStreamingMessage = null;
          this.currentStreamingContent = '';
          this.currentStreamingThinking = '';
          this.currentStreamingToolCalls = [];
        }
        break;

      case 'error':
        this.setStreamingState(false);
        const errorText = `Error: ${msg.payload?.message || 'Unknown error'}`;
        if (this.currentStreamingMessage) {
          this.appendToMessage(this.currentStreamingMessage, `\n\n${errorText}`);
          this.finalizeMessage(this.currentStreamingMessage);
          this.currentStreamingMessage = null;
        } else {
          this.addMessage('assistant', errorText);
        }
        if (this.onError) this.onError(new Error(msg.payload?.message));
        break;

      default:
        console.log('[Chat] Unhandled event type:', msg.type);
    }
  }

  // ============ STATE ============

  setStreamingState(streaming) {
    this.isStreaming = streaming;
    this.elements.sendBtn.disabled = streaming;

    if (this.onStreamingChange) {
      this.onStreamingChange(streaming);
    }
  }

  // ============ MESSAGES ============

  addMessage(role, content) {
    const { messages } = this.elements;
    if (!messages) return null;

    // Remove empty state if present
    const emptyState = messages.querySelector('.chat-empty');
    if (emptyState) emptyState.remove();

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const isUser = role === 'user';

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${role}`;
    messageEl.id = messageId;
    messageEl.innerHTML = `
      <div class="message-avatar">${isUser ? this.userAvatarIcon : this.avatarIcon}</div>
      <div class="message-body">
        <div class="message-content">${this.escapeHtml(content)}${!isUser && this.isStreaming ? '<span class="streaming-cursor"></span>' : ''}</div>
      </div>
    `;

    messages.appendChild(messageEl);
    this.scrollToBottom();

    this.messages.push({ id: messageId, role, content, el: messageEl });
    return messageId;
  }

  appendToMessage(messageId, text) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;

    // Remove cursor, append text, add cursor back
    const cursor = contentEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();

    // Get current text and append
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) {
      msg.content += text;
      contentEl.innerHTML = this.formatContent(msg.content) + '<span class="streaming-cursor"></span>';
    }

    this.scrollToBottom();
  }

  addThinkingToMessage(messageId, thought) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const bodyEl = messageEl.querySelector('.message-body');
    if (!bodyEl) return;

    // Check if thinking panel already exists
    let thinkingEl = bodyEl.querySelector('.thinking-panel');
    if (!thinkingEl) {
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking-panel';
      thinkingEl.innerHTML = `
        <div class="thinking-header">
          <span class="thinking-icon">v</span>
          <span class="thinking-label">Thinking...</span>
        </div>
        <div class="thinking-content"></div>
      `;

      // Add click handler
      const header = thinkingEl.querySelector('.thinking-header');
      header.addEventListener('click', () => thinkingEl.classList.toggle('collapsed'));

      // Insert before message content
      const contentEl = bodyEl.querySelector('.message-content');
      bodyEl.insertBefore(thinkingEl, contentEl);
    }

    // Append thought
    const thinkingContent = thinkingEl.querySelector('.thinking-content');
    if (thinkingContent) {
      const thoughtText = typeof thought === 'object' ? thought.description : thought;
      thinkingContent.textContent += thoughtText + '\n';
    }

    this.scrollToBottom();
  }

  addToolCallToMessage(messageId, toolCall, status) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const bodyEl = messageEl.querySelector('.message-body');
    if (!bodyEl) return;

    const toolId = toolCall.id || `tool-${Date.now()}`;
    const toolName = toolCall.name || 'Tool';
    const input = toolCall.input || toolCall.args || {};

    // Format the tool call display based on tool type
    let displayText = '';
    let icon = '⚙';

    if (toolName === 'Bash') {
      icon = '$';
      displayText = input.command || JSON.stringify(input, null, 2);
    } else if (toolName === 'Read') {
      icon = '📄';
      displayText = input.file_path || JSON.stringify(input, null, 2);
    } else if (toolName === 'Edit' || toolName === 'Write') {
      icon = '✏';
      displayText = input.file_path || JSON.stringify(input, null, 2);
    } else if (toolName === 'Glob' || toolName === 'Grep') {
      icon = '🔍';
      displayText = input.pattern || JSON.stringify(input, null, 2);
    } else {
      displayText = JSON.stringify(input, null, 2);
    }

    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call';
    toolEl.dataset.toolId = toolId;
    toolEl.innerHTML = `
      <div class="tool-call-header">
        <span class="tool-call-icon">${icon}</span>
        <span class="tool-call-name">${this.escapeHtml(toolName)}</span>
        <span class="tool-call-status ${status}">${status === 'running' ? 'Running...' : 'Done'}</span>
      </div>
      <div class="tool-call-content">${this.escapeHtml(displayText)}</div>
    `;

    // Add click handler to toggle collapse
    const header = toolEl.querySelector('.tool-call-header');
    header.addEventListener('click', () => toolEl.classList.toggle('collapsed'));

    // Insert before message content
    const contentEl = bodyEl.querySelector('.message-content');
    bodyEl.insertBefore(toolEl, contentEl);

    this.scrollToBottom();
  }

  updateToolCallInMessage(messageId, result) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const toolId = result.id;
    const toolEl = messageEl.querySelector(`[data-tool-id="${toolId}"]`) ||
                   messageEl.querySelector('.tool-call:last-of-type');

    if (toolEl) {
      const statusEl = toolEl.querySelector('.tool-call-status');
      if (statusEl) {
        statusEl.className = `tool-call-status ${result.isError ? 'error' : 'done'}`;
        statusEl.textContent = result.isError ? 'Error' : 'Done';
      }

      const contentEl = toolEl.querySelector('.tool-call-content');
      if (contentEl && result.result) {
        let resultText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
        // Truncate long results for display
        if (resultText.length > 500) {
          resultText = resultText.substring(0, 500) + '\n... (truncated)';
        }
        contentEl.innerHTML += `<div class="tool-call-result">${this.escapeHtml(resultText)}</div>`;
      }
    }
  }

  finalizeMessage(messageId) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    // Remove streaming cursor
    const cursor = messageEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();

    // Update thinking panel label
    const thinkingLabel = messageEl.querySelector('.thinking-label');
    if (thinkingLabel) thinkingLabel.textContent = 'Thinking (click to expand)';

    // Collapse thinking and tool panels by default
    const thinkingPanel = messageEl.querySelector('.thinking-panel');
    if (thinkingPanel) thinkingPanel.classList.add('collapsed');

    messageEl.querySelectorAll('.tool-call').forEach(tc => tc.classList.add('collapsed'));
  }

  showThinkingIndicator(messageId) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;

    // Simple thinking indicator - just animated dots
    contentEl.innerHTML = `<span class="thinking-indicator">Thinking<span class="dots"><span>.</span><span>.</span><span>.</span></span></span>`;
  }

  hideThinkingIndicator(messageId) {
    const messageEl = document.getElementById(messageId);
    if (!messageEl) return;

    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;

    // Remove thinking indicator if present, prepare for content
    const indicator = contentEl.querySelector('.thinking-indicator');
    if (indicator) {
      contentEl.innerHTML = '';
    }
  }

  // ============ SEND ============

  sendMessage(text) {
    if (!text.trim() || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.log('[Chat] Cannot send - socket not ready:', {
        hasText: !!text.trim(),
        hasSocket: !!this.socket,
        readyState: this.socket?.readyState
      });
      return false;
    }

    if (this.isStreaming) {
      console.log('[Chat] Already streaming, ignoring');
      return false;
    }

    // Add user message to UI
    this.addMessage('user', text);

    // Emit message added event
    if (this.onMessageAdded) {
      this.onMessageAdded({
        role: 'user',
        content: text
      });
    }

    // Send to gateway
    const message = {
      type: 'chat',
      payload: {
        text: text,
        provider: this.provider,
        model: this.model,
        sessionId: this.sessionId,
      }
    };
    console.log('[Chat] Sending message:', message);
    this.socket.send(JSON.stringify(message));

    return true;
  }

  // ============ UTILITIES ============

  formatContent(text) {
    let html = this.escapeHtml(text);

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    return html;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    const { messages } = this.elements;
    if (messages) {
      messages.scrollTop = messages.scrollHeight;
    }
  }

  // ============ CONFIGURATION ============

  setProvider(provider) {
    this.provider = provider;
    this.avatarIcon = provider.charAt(0).toUpperCase();
  }

  setModel(model) {
    this.model = model;
    if (this.elements.modelInfo) {
      this.elements.modelInfo.textContent = model || this.provider;
    }
  }

  // ============ HISTORY ============

  /**
   * Load message history into the chat
   * @param {Array} messages - Array of message objects with role and content
   */
  loadHistory(messages) {
    if (!messages || !Array.isArray(messages)) return;

    // Clear empty state
    const { messages: messagesEl } = this.elements;
    if (!messagesEl) return;

    const emptyState = messagesEl.querySelector('.chat-empty');
    if (emptyState) emptyState.remove();

    // Add each historical message
    for (const msg of messages) {
      const messageId = this.addMessage(msg.role, msg.content || '');

      // If message has thinking, add it
      if (msg.thinking && messageId) {
        this.addThinkingToMessage(messageId, msg.thinking);
        // Collapse thinking for history
        const messageEl = document.getElementById(messageId);
        const thinkingPanel = messageEl?.querySelector('.thinking-panel');
        if (thinkingPanel) {
          thinkingPanel.classList.add('collapsed');
          const label = thinkingPanel.querySelector('.thinking-label');
          if (label) label.textContent = 'Thinking (click to expand)';
        }
      }

      // If message has tool calls, add them
      if (msg.toolCalls && messageId) {
        for (const toolCall of msg.toolCalls) {
          this.addToolCallToMessage(messageId, toolCall, 'done');
          if (toolCall.result) {
            this.updateToolCallInMessage(messageId, {
              id: toolCall.id,
              result: toolCall.result
            });
          }
        }
        // Collapse tool calls for history
        const messageEl = document.getElementById(messageId);
        messageEl?.querySelectorAll('.tool-call').forEach(tc => tc.classList.add('collapsed'));
      }
    }

    this.scrollToBottom();
  }

  /**
   * Get all messages for saving
   */
  getMessages() {
    return this.messages.map(m => ({
      role: m.role,
      content: m.content
    }));
  }

  // ============ CLEANUP ============

  clearMessages() {
    this.messages = [];
    if (this.elements.messages) {
      this.elements.messages.innerHTML = `
        <div class="chat-empty">
          <div class="chat-empty-icon">...</div>
          <div>Start a conversation</div>
        </div>
      `;
    }
  }

  destroy() {
    this.disconnect();
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.elements = {};
    this.messages = [];
  }
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatComponent };
}
