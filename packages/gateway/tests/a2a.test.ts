import { describe, expect, it } from 'bun:test';

import { createA2ARoutes } from '../src/routes/a2a';

describe('A2A v1 routes', () => {
  it('advertises a v1 JSON-RPC interface', async () => {
    const app = createA2ARoutes({ baseUrl: 'https://tachikoma.example' });

    const response = await app.request('/.well-known/agent-card.json');
    const card = (await response.json()) as {
      supportedInterfaces: {
        protocolBinding: string;
        protocolVersion: string;
        url: string;
      }[];
      skills: {
        inputModes: string[];
        outputModes: string[];
      }[];
    };

    expect(response.status).toBe(200);
    expect(card.supportedInterfaces).toEqual([
      {
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        url: 'https://tachikoma.example/a2a',
      },
    ]);
    expect(card.skills[0]).toMatchObject({
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    });
  });

  it('executes a v1 SendMessage request to a terminal task', async () => {
    const app = createA2ARoutes({
      baseUrl: 'https://tachikoma.example',
      executorConfig: {
        executeTask: async function* () {
          yield { type: 'output', content: 'done' };
          yield { type: 'status', status: 'success' };
        },
      },
    });

    const response = await app.request('/a2a', {
      method: 'POST',
      headers: {
        'A2A-Version': '1.0',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          tenant: '',
          message: {
            messageId: 'message-1',
            role: 'ROLE_USER',
            parts: [{ text: 'work', mediaType: 'text/plain' }],
          },
        },
      }),
    });
    const rpc = (await response.json()) as {
      result: {
        task: {
          status: {
            message: { parts: { text: string; mediaType: string }[] };
            state: string;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(rpc.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(rpc.result.task.status.message.parts).toEqual([
      { text: 'done', mediaType: 'text/plain' },
    ]);
  });
});
