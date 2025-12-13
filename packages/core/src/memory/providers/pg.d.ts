declare module 'pg' {
  export class Pool {
    constructor(config: { connectionString: string });
    connect(): Promise<{
      query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      release: () => void;
    }>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  }
}

