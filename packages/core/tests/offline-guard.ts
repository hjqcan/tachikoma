export const OFFLINE_NETWORK_ERROR = 'Offline Tachikoma tests cannot access the network.';

process.env.OPENAI_API_KEY = 'poison-offline-credential';
process.env.ANTHROPIC_API_KEY = 'poison-offline-credential';
process.env.OPENROUTER_API_KEY = 'poison-offline-credential';
process.env.GOOGLE_API_KEY = 'poison-offline-credential';
process.env.TACHIKOMA_RUN_LIVE_TESTS = '0';

const realFetch = globalThis.fetch.bind(globalThis);

/** 守卫语义是禁"外呼"；被测的本机服务器（@tachikoma/server 测试）走回环放行 */
const LOOPBACK = /^(https?|ws{1,2}):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/u;

const offlineFetch = async (
  ...fetchArguments: Parameters<typeof globalThis.fetch>
): Promise<Response> => {
  const target = fetchArguments[0];
  const url =
    typeof target === 'string'
      ? target
      : target instanceof URL
        ? target.href
        : (target as Request).url;
  if (LOOPBACK.test(url)) {
    return realFetch(...fetchArguments);
  }
  throw new Error(OFFLINE_NETWORK_ERROR);
};
offlineFetch.preconnect = (..._arguments: Parameters<typeof globalThis.fetch.preconnect>): void => {
  throw new Error(OFFLINE_NETWORK_ERROR);
};

globalThis.fetch = offlineFetch;
