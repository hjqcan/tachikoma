export const OFFLINE_NETWORK_ERROR = 'Offline Tachikoma tests cannot access the network.';

process.env.OPENAI_API_KEY = 'poison-offline-credential';
process.env.ANTHROPIC_API_KEY = 'poison-offline-credential';
process.env.OPENROUTER_API_KEY = 'poison-offline-credential';
process.env.GOOGLE_API_KEY = 'poison-offline-credential';
process.env.TACHIKOMA_RUN_LIVE_TESTS = '0';

const offlineFetch = async (
  ..._arguments: Parameters<typeof globalThis.fetch>
): Promise<Response> => {
  throw new Error(OFFLINE_NETWORK_ERROR);
};
offlineFetch.preconnect = (..._arguments: Parameters<typeof globalThis.fetch.preconnect>): void => {
  throw new Error(OFFLINE_NETWORK_ERROR);
};

globalThis.fetch = offlineFetch;
