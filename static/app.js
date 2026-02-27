// Configuration — replace with your API Gateway endpoint after deploying
const API_URL = 'https://YOUR_API_GW_ID.execute-api.YOUR_REGION.amazonaws.com/prod/invocations';

// State
let selectedWorkflow = 'quick-response';
let conversations = [];
let currentConversationId = null;
let isProcessing = false;

// DOM Elements
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const newChatBtn = document.getElementById('newChatBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const workflowSelect = document.getElementById('workflowSelect');
const workflowIndicator = document.getElementById('workflowIndicator');
const messagesContainer = document.getElementById('messagesContainer');
const messages = document.getElementById('messages');
const emptyState = document.getElementById('emptyState');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const errorBanner = document.getElementById('errorBanner');
const errorMessage = document.getElementById('errorMessage');
const dismissError = document.getElementById('dismissError');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadConversations();
    createNewConversation();
});

// Event Listeners
function setupEventListeners() {
    sidebarToggle.addEventListener('click', toggleSidebar);
    newChatBtn.addEventListener('click', createNewConversation);
    clearAllBtn.addEventListener('click', clearAllConversations);
    workflowSelect.addEventListener('change', handleWorkflowChange);
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('input', handleInputChange);
    messageInput.addEventListener('keydown', handleKeyPress);
    dismissError.addEventListener('click', hideError);

    // Example prompts
    document.querySelectorAll('.example-prompt').forEach(btn => {
        btn.addEventListener('click', () => {
            messageInput.value = btn.dataset.prompt;
            handleInputChange();
            sendMessage();
        });
    });
}

function toggleSidebar() {
    sidebar.classList.toggle('hidden');
}

function handleWorkflowChange(e) {
    selectedWorkflow = e.target.value;
    const workflowNames = {
        'chain-of-thought': 'Chain-of-Thought',
        'quick-response': 'Quick Response'
    };
    workflowIndicator.textContent = workflowNames[selectedWorkflow];
}

function handleInputChange() {
    const hasText = messageInput.value.trim().length > 0;
    sendBtn.disabled = !hasText || isProcessing;

    // Auto-resize textarea
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

function handleKeyPress(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!sendBtn.disabled) {
            sendMessage();
        }
    }
}

// Conversations
function loadConversations() {
    const saved = localStorage.getItem('conversations');
    if (saved) {
        conversations = JSON.parse(saved);
        renderConversations();
    }
}

function saveConversations() {
    localStorage.setItem('conversations', JSON.stringify(conversations));
}

function createNewConversation() {
    const conversation = {
        id: Date.now().toString(),
        title: 'New Chat',
        messages: [],
        createdAt: new Date().toISOString(),
        workflow: selectedWorkflow,
        sessionId: null  // Will be generated on first message
    };

    conversations.unshift(conversation);
    currentConversationId = conversation.id;
    saveConversations();
    renderConversations();
    clearMessages();
}

function clearAllConversations() {
    if (confirm('Are you sure you want to delete all conversations? This cannot be undone.')) {
        conversations = [];
        currentConversationId = null;
        localStorage.removeItem('conversations');
        renderConversations();
        clearMessages();
        createNewConversation();
    }
}

function renderConversations() {
    const list = document.getElementById('conversationsList');
    list.innerHTML = conversations.map(conv => `
        <div class="conversation-item ${conv.id === currentConversationId ? 'active' : ''}"
             data-id="${conv.id}">
            <div class="conversation-title">${escapeHtml(conv.title)}</div>
            <div class="conversation-date">${formatDate(conv.createdAt)}</div>
        </div>
    `).join('');

    // Add click listeners
    list.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => loadConversation(item.dataset.id));
    });
}

function loadConversation(id) {
    currentConversationId = id;
    const conversation = conversations.find(c => c.id === id);
    if (conversation) {
        clearMessages();
        if (conversation.messages.length > 0) {
            hideEmptyState();
            conversation.messages.forEach(msg => {
                if (msg.role === 'user') {
                    addUserMessage(msg.content, false);
                } else {
                    addAssistantMessage(msg.content, false);
                }
            });
        }
        renderConversations();
    }
}

// Messages
function clearMessages() {
    messages.innerHTML = '';
    emptyState.style.display = 'flex';
}

function hideEmptyState() {
    emptyState.style.display = 'none';
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    sendBtn.disabled = true;
    hideEmptyState();

    // Add user message
    addUserMessage(text);
    messageInput.value = '';
    handleInputChange();

    // Save to conversation
    const conversation = conversations.find(c => c.id === currentConversationId);
    if (conversation) {
        conversation.messages.push({ role: 'user', content: text });
        if (conversation.title === 'New Chat') {
            conversation.title = text.substring(0, 50) + (text.length > 50 ? '...' : '');
        }
        saveConversations();
        renderConversations();
    }

    try {
        await streamResponse(text);
    } catch (error) {
        showError(error.message);
    } finally {
        isProcessing = false;
        sendBtn.disabled = false;
    }
}

function addUserMessage(text, scroll = true) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user';
    messageDiv.innerHTML = `
        <div class="message-avatar">👤</div>
        <div class="message-content">${escapeHtml(text)}</div>
    `;
    messages.appendChild(messageDiv);
    if (scroll) scrollToBottom();
}

function addAssistantMessage(content, scroll = true) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';
    messageDiv.innerHTML = `
        <div class="message-avatar">🤖</div>
        <div class="message-content">
            ${content}
        </div>
    `;
    messages.appendChild(messageDiv);
    if (scroll) scrollToBottom();
    return messageDiv;
}

// Streaming
async function streamResponse(prompt) {
    const messageDiv = addAssistantMessage('', true);
    const contentDiv = messageDiv.querySelector('.message-content');

    const agentData = {
        planning: { text: '', element: null, textDiv: null, statusBadge: null },
        retrieval: { text: '', element: null, textDiv: null, statusBadge: null },
        analysis: { text: '', element: null, textDiv: null, statusBadge: null },
        validation: { text: '', element: null, textDiv: null, statusBadge: null },
        final: { text: '', element: null, textDiv: null, statusBadge: null }
    };

    // Get current conversation and generate session ID if needed
    const conversation = conversations.find(c => c.id === currentConversationId);

    // Generate session ID on first message (must be 33+ characters)
    if (conversation && !conversation.sessionId) {
        conversation.sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2)}-${Math.random().toString(36).substring(2)}`;
        saveConversations();
        console.log('Generated new session ID:', conversation.sessionId);
    }

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                workflow: selectedWorkflow,
                sessionId: conversation?.sessionId  // Include session ID for continuous conversation
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.trim() && line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        handleStreamingEvent(data, agentData, contentDiv);
                    } catch (e) {
                        console.error('Parse error:', e);
                    }
                }
            }
        }

        // Save to conversation (conversation already declared at top of function)
        if (conversation) {
            conversation.messages.push({
                role: 'assistant',
                content: contentDiv.innerHTML
            });
            saveConversations();
        }

    } catch (error) {
        contentDiv.innerHTML = `<div class="error">Error: ${escapeHtml(error.message)}</div>`;
        throw error;
    }
}

function handleStreamingEvent(data, agentData, contentDiv) {
    const { phase, status, agent, chunk } = data;

    if (status === 'starting') {
        updateAgentStatus(phase, 'active');

        // Create agent section if it doesn't exist
        if (!agentData[phase].element) {
            const agentDiv = document.createElement('div');

            // Special styling for final answer
            if (phase === 'final') {
                agentDiv.className = 'final-answer';
                agentDiv.innerHTML = `
                    <div class="final-header">
                        <span class="final-icon">✨</span>
                        <span>Answer</span>
                    </div>
                    <div class="final-text"></div>
                `;
            } else {
                agentDiv.className = 'agent-response background-process';
                agentDiv.innerHTML = `
                    <details>
                        <summary class="agent-header">
                            <div class="agent-name">
                                <span class="agent-icon">${getAgentIcon(phase)}</span>
                                <span>${agent}</span>
                            </div>
                            <span class="agent-status-badge">⏳</span>
                        </summary>
                        <div class="agent-text"></div>
                    </details>
                `;
            }
            contentDiv.appendChild(agentDiv);
            agentData[phase].element = agentDiv;

            // Store reference to text div for this specific message
            agentData[phase].textDiv = agentDiv.querySelector(phase === 'final' ? '.final-text' : '.agent-text');
            agentData[phase].statusBadge = agentDiv.querySelector('.agent-status-badge');
        }
    } else if (status === 'streaming' && chunk) {
        agentData[phase].text += chunk;
        // Use stored reference instead of getElementById
        if (agentData[phase].textDiv) {
            agentData[phase].textDiv.textContent = agentData[phase].text;
            scrollToBottom();
        }
    } else if (status === 'complete') {
        updateAgentStatus(phase, 'complete');
        // Use stored reference instead of getElementById
        if (agentData[phase].statusBadge) {
            agentData[phase].statusBadge.textContent = '✅';
        }
    }
}

function updateAgentStatus(phase, status) {
    const agentMap = {
        planning: 'planner',
        retrieval: 'retriever',
        analysis: 'analyzer',
        validation: 'validator'
    };

    const agentName = agentMap[phase];
    if (!agentName) return;

    const agentItem = document.querySelector(`.agent-item[data-agent="${agentName}"] .agent-badge`);
    if (agentItem) {
        agentItem.className = `agent-badge ${status}`;
    }
}

function getAgentIcon(phase) {
    const icons = {
        planning: '⚙️',
        retrieval: '🗄️',
        analysis: '🔍',
        validation: '✅'
    };
    return icons[phase] || '🤖';
}

// Utility Functions
function scrollToBottom() {
    setTimeout(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 10);
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.style.display = 'flex';
    setTimeout(hideError, 5000);
}

function hideError() {
    errorBanner.style.display = 'none';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}
