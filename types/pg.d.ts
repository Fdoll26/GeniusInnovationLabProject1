declare module 'pg' {
  export class Pool {
    constructor(config?: unknown);
    query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  }
}

