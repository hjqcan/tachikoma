import { describe, expect, it } from 'bun:test';
import { IntentAnalyzer } from '../src/conversation/intent-analyzer';
import { UserIntent } from '../src/conversation/types';

describe('IntentAnalyzer', () => {
  it('不应将“1:1还原样式”误判为撤销', () => {
    const analyzer = new IntentAnalyzer();
    const result = analyzer.analyze('在工作目录创建 1:1还原样式开发一个网易云音乐的听歌网站 使用react + tailwindcss');
    expect(result.intent).toBe(UserIntent.NEW_TASK);
  });

  it('不应将英文单词内部的 next 误判为继续', () => {
    const analyzer = new IntentAnalyzer();
    expect(analyzer.analyze('SkipNext').intent).toBe(UserIntent.NEW_TASK);
    expect(analyzer.analyze('context').intent).toBe(UserIntent.NEW_TASK);
  });

  it('应识别包含式中文继续表达', () => {
    const analyzer = new IntentAnalyzer();
    expect(analyzer.analyze('我们继续吧').intent).toBe(UserIntent.CONTINUE);
    expect(analyzer.analyze('继续一下').intent).toBe(UserIntent.CONTINUE);
  });

  it('应识别英文 next 继续表达', () => {
    const analyzer = new IntentAnalyzer();
    expect(analyzer.analyze('next step').intent).toBe(UserIntent.CONTINUE);
  });

  it('应识别明确的撤销意图', () => {
    const analyzer = new IntentAnalyzer();
    expect(analyzer.analyze('撤销').intent).toBe(UserIntent.UNDO);
    expect(analyzer.analyze('回滚到上一步').intent).toBe(UserIntent.UNDO);
    expect(analyzer.analyze('还原到检查点').intent).toBe(UserIntent.UNDO);
  });
});
