/**
 * 智能体笔记系统
 *
 * 来自 Manus + Anthropic：创建 todo.md 是一种操控注意力的刻意机制
 * 通过不断重写待办事项，将目标复述到上下文末尾
 *
 * @module context/memory/note-taking
 */

import type {
  ContextMessage,
  TodoItem,
  TodoStatus,
  AgentNotes,
} from '../types';
import type { LanguageCode } from '../language';

// ============================================================================
// 笔记管理器
// ============================================================================

/**
 * 笔记管理器
 *
 * 管理智能体的待办事项和笔记，通过复述操控注意力
 */
export class NoteManager {
  /**
   * 创建新笔记
   */
  createNotes(): AgentNotes {
    return {
      todos: [],
      findings: [],
      decisions: [],
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * 添加待办事项
   */
  addTodo(notes: AgentNotes, description: string): AgentNotes {
    const todo: TodoItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description,
      status: 'pending',
      createdAt: Date.now(),
    };

    return {
      ...notes,
      todos: [...notes.todos, todo],
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * 更新待办事项状态
   */
  updateTodoStatus(
    notes: AgentNotes,
    todoId: string,
    status: TodoStatus
  ): AgentNotes {
    const todos = notes.todos.map((todo) => {
      if (todo.id !== todoId) {
        return todo;
      }

      return {
        ...todo,
        status,
        ...(status === 'completed' && { completedAt: Date.now() }),
      };
    });

    return {
      ...notes,
      todos,
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * 标记待办事项完成
   */
  completeTodo(notes: AgentNotes, todoId: string): AgentNotes {
    return this.updateTodoStatus(notes, todoId, 'completed');
  }

  /**
   * 添加发现
   */
  addFinding(notes: AgentNotes, finding: string): AgentNotes {
    return {
      ...notes,
      findings: [...notes.findings, finding],
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * 添加决策
   */
  addDecision(notes: AgentNotes, decision: string): AgentNotes {
    return {
      ...notes,
      decisions: [...notes.decisions, decision],
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * 生成笔记内容（用于文件持久化）
   */
  formatAsMarkdown(notes: AgentNotes): string {
    const sections: string[] = [];

    // 待办事项
    sections.push('# 待办事项\n');

    const pendingTodos = notes.todos.filter((t) => t.status !== 'completed');
    const completedTodos = notes.todos.filter((t) => t.status === 'completed');

    if (pendingTodos.length > 0) {
      sections.push('## 进行中\n');
      for (const todo of pendingTodos) {
        const marker = todo.status === 'in-progress' ? '🔄' : '⬜';
        sections.push(`- ${marker} ${todo.description}`);
      }
      sections.push('');
    }

    if (completedTodos.length > 0) {
      sections.push('## 已完成\n');
      for (const todo of completedTodos) {
        sections.push(`- ✅ ${todo.description}`);
      }
      sections.push('');
    }

    // 关键发现
    if (notes.findings.length > 0) {
      sections.push('# 关键发现\n');
      for (const finding of notes.findings) {
        sections.push(`- ${finding}`);
      }
      sections.push('');
    }

    // 重要决策
    if (notes.decisions.length > 0) {
      sections.push('# 重要决策\n');
      for (const decision of notes.decisions) {
        sections.push(`- ${decision}`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * 将笔记注入上下文末尾
   *
   * 通过复述目标到上下文末尾，操控模型注意力
   */
  injectIntoContext(
    notes: AgentNotes,
    messages: ContextMessage[],
    language: LanguageCode = 'zh'
  ): ContextMessage[] {
    const pendingTodos = notes.todos.filter((t) => t.status !== 'completed');

    if (pendingTodos.length === 0 && notes.findings.length === 0) {
      return messages;
    }

    // 生成简洁的状态提醒
    const reminder = this.generateReminder(notes, language);

    const reminderMessage: ContextMessage = {
      id: `reminder-${Date.now()}`,
      role: 'system',
      content: reminder,
      timestamp: Date.now(),
      format: 'full',
    };

    return [...messages, reminderMessage];
  }

  /**
   * 从 Markdown 解析笔记
   */
  parseFromMarkdown(content: string): AgentNotes {
    const notes = this.createNotes();
    const lines = content.split('\n');

    let currentSection = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // 检测章节
      if (trimmed.startsWith('# ')) {
        currentSection = trimmed.slice(2).trim();
        continue;
      }

      if (trimmed.startsWith('## ')) {
        continue; // 跳过子章节标题
      }

      // 解析列表项
      if (trimmed.startsWith('- ')) {
        const item = trimmed.slice(2).trim();

        if (currentSection === '待办事项') {
          const todo = this.parseTodoItem(item);
          notes.todos.push(todo);
        } else if (currentSection === '关键发现') {
          notes.findings.push(item);
        } else if (currentSection === '重要决策') {
          notes.decisions.push(item);
        }
      }
    }

    return notes;
  }

  // ========================================
  // 私有方法
  // ========================================

  private generateReminder(notes: AgentNotes, language: LanguageCode): string {
    if (language === 'en') {
      return this.generateReminderEn(notes);
    }
    return this.generateReminderZh(notes);
  }

  private generateReminderZh(notes: AgentNotes): string {
    const parts: string[] = [];

    parts.push('## 当前状态提醒\n');

    // 待办事项摘要
    const pendingTodos = notes.todos.filter((t) => t.status !== 'completed');
    if (pendingTodos.length > 0) {
      parts.push('### 待完成任务');
      for (const todo of pendingTodos.slice(0, 5)) {
        const marker = todo.status === 'in-progress' ? '🔄' : '⬜';
        parts.push(`${marker} ${todo.description}`);
      }
      if (pendingTodos.length > 5) {
        parts.push(`...还有 ${pendingTodos.length - 5} 项待完成`);
      }
      parts.push('');
    }

    // 最近发现
    if (notes.findings.length > 0) {
      const recentFindings = notes.findings.slice(-3);
      parts.push('### 最近发现');
      for (const finding of recentFindings) {
        parts.push(`• ${finding}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private generateReminderEn(notes: AgentNotes): string {
    const parts: string[] = [];

    parts.push('## Status Reminder\n');

    const pendingTodos = notes.todos.filter((t) => t.status !== 'completed');
    if (pendingTodos.length > 0) {
      parts.push('### Pending Tasks');
      for (const todo of pendingTodos.slice(0, 5)) {
        const marker = todo.status === 'in-progress' ? '🔄' : '⬜';
        parts.push(`${marker} ${todo.description}`);
      }
      if (pendingTodos.length > 5) {
        parts.push(`... and ${pendingTodos.length - 5} more pending`);
      }
      parts.push('');
    }

    if (notes.findings.length > 0) {
      const recentFindings = notes.findings.slice(-3);
      parts.push('### Recent Findings');
      for (const finding of recentFindings) {
        parts.push(`• ${finding}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private parseTodoItem(item: string): TodoItem {
    let status: TodoStatus = 'pending';
    let description = item;

    // 检测状态标记
    if (item.startsWith('✅ ') || item.startsWith('[x] ')) {
      status = 'completed';
      description = item.slice(item.indexOf(' ') + 1);
    } else if (item.startsWith('🔄 ') || item.startsWith('[/] ')) {
      status = 'in-progress';
      description = item.slice(item.indexOf(' ') + 1);
    } else if (item.startsWith('⬜ ') || item.startsWith('[ ] ')) {
      status = 'pending';
      description = item.slice(item.indexOf(' ') + 1);
    } else if (item.startsWith('🚫 ')) {
      status = 'blocked';
      description = item.slice(item.indexOf(' ') + 1);
    }

    return {
      id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description,
      status,
      createdAt: Date.now(),
      ...(status === 'completed' && { completedAt: Date.now() }),
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建笔记管理器
 */
export function createNoteManager(): NoteManager {
  return new NoteManager();
}
