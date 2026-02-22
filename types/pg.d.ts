declare module 'pg' {
  export type PoolClient = {
    query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    release(): void;
  };

  export class Pool {
    constructor(config?: unknown);
    connect(): Promise<PoolClient>;
    query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
}
