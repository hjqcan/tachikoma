/**
 * ACP 冒烟的 faux 注入（--preload 进 spawn 出的 tachikoma-acp）：
 * 一次 write 工具调用（触发审批）+ 收尾文本。
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const modelRuntime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const faux = fauxProvider({
  provider: 'tachikoma-acp-faux',
  models: [{ id: 'chat', reasoning: true, contextWindow: 200_000 }],
});
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('write', { path: 'acp.txt', content: 'ACP-SMOKE-OK' })], {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage([fauxText('Wrote acp.txt.')]),
]);
modelRuntime.registerNativeProvider(faux.provider);

Object.defineProperty(ModelRuntime, 'create', {
  configurable: true,
  value: async () => modelRuntime,
});
