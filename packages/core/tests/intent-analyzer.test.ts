import { describe, expect, it } from 'bun:test';
import { IntentAnalyzer } from '../src/conversation/intent-analyzer';
import { UserIntent } from '../src/conversation/types';

describe('IntentAnalyzer', () => {
  it('不应将“1:1还原样式”误判为撤销', () => {
    const analyzer = new IntentAnalyzer();
    const result = analyzer.analyze('在工作目录创建 1:1还原样式开发一个网易云音乐的听歌网站 使用react + tailwindcss');
    expect(result.intent).toBe(UserIntent.NEW_TASK);
  });

  it('应识别明确的撤销意图', () => {
    const analyzer = new IntentAnalyzer();
    expect(analyzer.analyze('撤销').intent).toBe(UserIntent.UNDO);
    expect(analyzer.analyze('回滚到上一步').intent).toBe(UserIntent.UNDO);
    expect(analyzer.analyze('还原到检查点').intent).toBe(UserIntent.UNDO);
  });
});

