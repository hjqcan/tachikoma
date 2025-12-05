/**
 * 配置模块测试
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_CONFIG,
  DEFAULT_ORCHESTRATOR_MODEL,
  DEFAULT_WORKER_MODEL,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_CONTEXT_THRESHOLDS,
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_AGENTOPS_CONFIG,
  loadConfig,
  loadFromEnv,
  validateConfig,
  deepMerge,
  createConfigBuilder,
  ConfigValidationError,
} from '../src/config';
// types are used for test assertions

describe('默认配置', () => {
  describe('DEFAULT_CONFIG', () => {
    it('应包含所有必需的配置节', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('models');
      expect(DEFAULT_CONFIG).toHaveProperty('context');
      expect(DEFAULT_CONFIG).toHaveProperty('sandbox');
      expect(DEFAULT_CONFIG).toHaveProperty('agentops');
    });

    it('模型配置应包含三种角色', () => {
      expect(DEFAULT_CONFIG.models).toHaveProperty('orchestrator');
      expect(DEFAULT_CONFIG.models).toHaveProperty('worker');
      expect(DEFAULT_CONFIG.models).toHaveProperty('planner');
    });
  });

  describe('模型默认配置', () => {
    it('orchestrator 模型配置正确', () => {
      expect(DEFAULT_ORCHESTRATOR_MODEL.provider).toBe('anthropic');
      expect(DEFAULT_ORCHESTRATOR_MODEL.model).toBe('claude-opus-4');
      expect(DEFAULT_ORCHESTRATOR_MODEL.maxTokens).toBe(8192);
    });

    it('worker 模型配置正确', () => {
      expect(DEFAULT_WORKER_MODEL.provider).toBe('anthropic');
      expect(DEFAULT_WORKER_MODEL.model).toBe('claude-sonnet-4');
      expect(DEFAULT_WORKER_MODEL.maxTokens).toBe(4096);
    });

    it('planner 模型配置正确', () => {
      expect(DEFAULT_PLANNER_MODEL.provider).toBe('anthropic');
      expect(DEFAULT_PLANNER_MODEL.model).toBe('claude-haiku-3.5');
      expect(DEFAULT_PLANNER_MODEL.maxTokens).toBe(2048);
    });
  });

  describe('上下文阈值配置', () => {
    it('应包含所有阈值字段', () => {
      expect(DEFAULT_CONTEXT_THRESHOLDS.hardLimit).toBe(1_000_000);
      expect(DEFAULT_CONTEXT_THRESHOLDS.rotThreshold).toBe(200_000);
      expect(DEFAULT_CONTEXT_THRESHOLDS.compactionTrigger).toBe(128_000);
      expect(DEFAULT_CONTEXT_THRESHOLDS.summarizationTrigger).toBe(150_000);
      expect(DEFAULT_CONTEXT_THRESHOLDS.preserveRecentToolCalls).toBe(5);
    });

    it('阈值逻辑关系正确', () => {
      // compactionTrigger < rotThreshold
      expect(DEFAULT_CONTEXT_THRESHOLDS.compactionTrigger).toBeLessThan(
        DEFAULT_CONTEXT_THRESHOLDS.rotThreshold
      );
      // summarizationTrigger < hardLimit
      expect(DEFAULT_CONTEXT_THRESHOLDS.summarizationTrigger).toBeLessThan(
        DEFAULT_CONTEXT_THRESHOLDS.hardLimit
      );
    });
  });

  describe('沙盒配置', () => {
    it('应包含正确的运行时配置', () => {
      expect(DEFAULT_SANDBOX_CONFIG.runtime).toBe('bun');
      expect(DEFAULT_SANDBOX_CONFIG.timeout).toBe(1800_000); // 30 分钟
    });

    it('资源配置正确', () => {
      expect(DEFAULT_SANDBOX_CONFIG.resources.cpu).toBe('2');
      expect(DEFAULT_SANDBOX_CONFIG.resources.memory).toBe('4G');
      expect(DEFAULT_SANDBOX_CONFIG.resources.storage).toBe('10G');
    });

    it('网络配置正确', () => {
      expect(DEFAULT_SANDBOX_CONFIG.network.mode).toBe('restricted');
      expect(Array.isArray(DEFAULT_SANDBOX_CONFIG.network.allowlist)).toBe(true);
    });
  });

  describe('AgentOps 配置', () => {
    it('追踪配置正确', () => {
      expect(DEFAULT_AGENTOPS_CONFIG.tracing.enabled).toBe(true);
      expect(DEFAULT_AGENTOPS_CONFIG.tracing.endpoint).toBe('http://localhost:4317');
      expect(DEFAULT_AGENTOPS_CONFIG.tracing.serviceName).toBe('tachikoma');
    });

    it('日志配置正确', () => {
      expect(DEFAULT_AGENTOPS_CONFIG.logging.level).toBe('info');
      expect(DEFAULT_AGENTOPS_CONFIG.logging.format).toBe('json');
    });

    it('指标配置正确', () => {
      expect(DEFAULT_AGENTOPS_CONFIG.metrics.enabled).toBe(true);
      expect(DEFAULT_AGENTOPS_CONFIG.metrics.endpoint).toBe('/metrics');
    });
  });
});

describe('deepMerge', () => {
  it('应正确合并简单对象', () => {
    const target = { a: 1, b: 2, c: 0 };
    const source = { b: 3, c: 4 };
    const result = deepMerge(target, source);

    expect(result.a).toBe(1);
    expect(result.b).toBe(3);
    expect(result.c).toBe(4);
  });

  it('应正确合并嵌套对象', () => {
    const target = { a: { b: 1, c: 2 }, d: 3, e: 0 };
    const source = { a: { c: 4 }, e: 5 };
    const result = deepMerge(target, source);

    expect(result.a.b).toBe(1);
    expect(result.a.c).toBe(4);
    expect(result.d).toBe(3);
    expect(result.e).toBe(5);
  });

  it('应忽略 undefined 值但保留已有值', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3 };
    const result = deepMerge(target, source);

    expect(result.a).toBe(1);
    expect(result.b).toBe(3);
  });

  it('不应修改原始对象', () => {
    const target = { a: 1, b: 0 };
    const source = { b: 2 };
    const result = deepMerge(target, source);

    expect(target.a).toBe(1);
    expect(target.b).toBe(0);
    expect(result).not.toBe(target);
  });
});

describe('loadFromEnv', () => {
  it('应从环境变量加载模型配置', () => {
    const env = {
      TACHIKOMA_ORCHESTRATOR_PROVIDER: 'openai',
      TACHIKOMA_ORCHESTRATOR_MODEL: 'gpt-4',
      TACHIKOMA_ORCHESTRATOR_MAX_TOKENS: '16384',
    };

    const overrides = loadFromEnv(env);

    expect(overrides.models?.orchestrator?.provider).toBe('openai');
    expect(overrides.models?.orchestrator?.model).toBe('gpt-4');
    expect(overrides.models?.orchestrator?.maxTokens).toBe(16384);
  });

  it('应从环境变量加载上下文配置', () => {
    const env = {
      TACHIKOMA_CONTEXT_HARD_LIMIT: '500000',
      TACHIKOMA_CONTEXT_ROT_THRESHOLD: '100000',
    };

    const overrides = loadFromEnv(env);

    expect(overrides.context?.hardLimit).toBe(500000);
    expect(overrides.context?.rotThreshold).toBe(100000);
  });

  it('应从环境变量加载布尔值', () => {
    const env = {
      TACHIKOMA_TRACING_ENABLED: 'false',
      TACHIKOMA_METRICS_ENABLED: 'true',
    };

    const overrides = loadFromEnv(env);

    expect(overrides.agentops?.tracing?.enabled).toBe(false);
    expect(overrides.agentops?.metrics?.enabled).toBe(true);
  });

  it('应从环境变量加载网络允许列表', () => {
    const env = {
      TACHIKOMA_SANDBOX_NETWORK_ALLOWLIST: 'api.example.com,api.test.com',
    };

    const overrides = loadFromEnv(env);

    expect(overrides.sandbox?.network?.allowlist).toEqual([
      'api.example.com',
      'api.test.com',
    ]);
  });

  it('应忽略空环境变量', () => {
    const env = {
      TACHIKOMA_ORCHESTRATOR_PROVIDER: '',
    };

    const overrides = loadFromEnv(env);

    expect(overrides.models?.orchestrator?.provider).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('应返回默认配置（不使用环境变量）', () => {
    const config = loadConfig(undefined, { loadFromEnvironment: false });

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('应合并运行时覆盖', () => {
    const config = loadConfig(
      {
        models: {
          orchestrator: { model: 'custom-model' },
        },
      },
      { loadFromEnvironment: false }
    );

    expect(config.models.orchestrator.model).toBe('custom-model');
    expect(config.models.orchestrator.provider).toBe('anthropic'); // 默认值保持
  });

  it('应合并环境变量覆盖', () => {
    const config = loadConfig(undefined, {
      loadFromEnvironment: true,
      env: {
        TACHIKOMA_WORKER_MODEL: 'env-model',
      },
    });

    expect(config.models.worker.model).toBe('env-model');
  });

  it('运行时覆盖优先于环境变量', () => {
    const config = loadConfig(
      {
        models: {
          worker: { model: 'runtime-model' },
        },
      },
      {
        loadFromEnvironment: true,
        env: {
          TACHIKOMA_WORKER_MODEL: 'env-model',
        },
      }
    );

    expect(config.models.worker.model).toBe('runtime-model');
  });

  it('应验证配置', () => {
    expect(() =>
      loadConfig(
        {
          models: {
            orchestrator: { maxTokens: -1 },
          },
        },
        { loadFromEnvironment: false }
      )
    ).toThrow(ConfigValidationError);
  });

  it('应支持跳过验证', () => {
    const config = loadConfig(
      {
        models: {
          orchestrator: { maxTokens: -1 },
        },
      },
      { loadFromEnvironment: false, skipValidation: true }
    );

    expect(config.models.orchestrator.maxTokens).toBe(-1);
  });
});

describe('validateConfig', () => {
  it('应通过有效配置', () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it('应拒绝无效的模型配置', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.models.orchestrator.provider = '';

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow('provider must be a non-empty string');
  });

  it('应拒绝无效的 maxTokens', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.models.orchestrator.maxTokens = 0;

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow('maxTokens must be a positive number');
  });

  it('应拒绝无效的阈值逻辑', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    // compactionTrigger > rotThreshold
    config.context.compactionTrigger = 300_000;
    config.context.rotThreshold = 200_000;

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow('compactionTrigger should not exceed rotThreshold');
  });

  it('应拒绝无效的网络模式', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    (config.sandbox.network.mode as string) = 'invalid';

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow('network.mode must be one of');
  });

  it('应拒绝无效的日志级别', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    (config.agentops.logging.level as string) = 'invalid';

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow('logging.level must be one of');
  });
});

describe('ConfigBuilder', () => {
  it('应支持链式调用', () => {
    const config = createConfigBuilder()
      .orchestratorModel({ model: 'custom-orchestrator' })
      .workerModel({ model: 'custom-worker' })
      .plannerModel({ model: 'custom-planner' })
      .withoutEnv()
      .build();

    expect(config.models.orchestrator.model).toBe('custom-orchestrator');
    expect(config.models.worker.model).toBe('custom-worker');
    expect(config.models.planner.model).toBe('custom-planner');
  });

  it('应支持设置上下文阈值', () => {
    const config = createConfigBuilder()
      .contextThresholds({ hardLimit: 500_000 })
      .withoutEnv()
      .build();

    expect(config.context.hardLimit).toBe(500_000);
  });

  it('应支持设置沙盒配置', () => {
    const config = createConfigBuilder()
      .sandbox({ timeout: 3600_000 })
      .withoutEnv()
      .build();

    expect(config.sandbox.timeout).toBe(3600_000);
  });

  it('应支持设置 AgentOps 配置', () => {
    const config = createConfigBuilder()
      .agentOps({ tracing: { enabled: false } })
      .withoutEnv()
      .build();

    expect(config.agentops.tracing.enabled).toBe(false);
  });

  it('应支持自定义环境变量', () => {
    const config = createConfigBuilder()
      .withEnv({
        TACHIKOMA_ORCHESTRATOR_MODEL: 'env-model',
      })
      .build();

    expect(config.models.orchestrator.model).toBe('env-model');
  });
});

describe('配置快照测试', () => {
  it('DEFAULT_CONFIG 应与预期一致', () => {
    // 使用结构化的断言代替快照
    expect(DEFAULT_CONFIG.models.orchestrator.provider).toBe('anthropic');
    expect(DEFAULT_CONFIG.models.orchestrator.model).toBe('claude-opus-4');
    expect(DEFAULT_CONFIG.models.worker.model).toBe('claude-sonnet-4');
    expect(DEFAULT_CONFIG.models.planner.model).toBe('claude-haiku-3.5');
    expect(DEFAULT_CONFIG.context.hardLimit).toBe(1_000_000);
    expect(DEFAULT_CONFIG.sandbox.runtime).toBe('bun');
    expect(DEFAULT_CONFIG.agentops.tracing.serviceName).toBe('tachikoma');
  });
});

