import type { ContextMessage } from './types';

export type LanguageCode = 'zh' | 'en';

const CJK_REGEX =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function detectLanguageFromText(text: string): LanguageCode {
  return CJK_REGEX.test(text) ? 'zh' : 'en';
}

/**
 * Detect the preferred user-facing language from the latest user message.
 * Falls back to scanning other messages; defaults to English.
 */
export function detectUserLanguage(messages: ContextMessage[]): LanguageCode {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      return detectLanguageFromText(msg.content ?? '');
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && detectLanguageFromText(msg.content ?? '') === 'zh') {
      return 'zh';
    }
  }

  return 'en';
}

