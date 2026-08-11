import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const modelRuntime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const faux = fauxProvider({
  provider: 'tachikoma-cli-faux',
  models: [{ id: 'chat', reasoning: true, contextWindow: 200_000 }],
});
faux.setResponses([
  fauxAssistantMessage(process.env.TACHIKOMA_FAUX_RESPONSE ?? 'tachikoma-dist-run-ok'),
]);
modelRuntime.registerNativeProvider(faux.provider);

Object.defineProperty(ModelRuntime, 'create', {
  configurable: true,
  value: async () => modelRuntime,
});
