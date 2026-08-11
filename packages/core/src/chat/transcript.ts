import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { ChatMessage, ChatSessionState, ChatTranscriptEntry } from './types';

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `[image:${part.mimeType}]`))
    .join('\n');
}

/** 将持久化的 pi transcript 投影为 CLI/UI 使用的纯文本消息。 */
export function transcriptEntryToChatMessage(entry: ChatTranscriptEntry): ChatMessage | null {
  const message = entry.message;
  if (message.role === 'toolResult') return null;
  if (message.role === 'user') {
    return {
      id: entry.id,
      role: 'user',
      content: contentText(message.content),
      createdAt: message.timestamp,
      ...(entry.interrupted && { interrupted: true }),
    };
  }

  const content = message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return {
    id: entry.id,
    role: 'assistant',
    content,
    createdAt: message.timestamp,
    model: `${message.provider}/${message.model}`,
    ...(entry.interrupted && { interrupted: true }),
  };
}

export function getChatSessionMessages(session: ChatSessionState): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of session.transcript) {
    const message = transcriptEntryToChatMessage(entry);
    if (!message?.content) continue;
    const previous = messages.at(-1);
    if (message.role === 'assistant' && previous?.role === 'assistant') {
      messages[messages.length - 1] = {
        ...previous,
        ...message,
        content: previous.content + message.content,
        ...((previous.interrupted || message.interrupted) && { interrupted: true }),
      };
    } else {
      messages.push(message);
    }
  }
  return messages;
}
