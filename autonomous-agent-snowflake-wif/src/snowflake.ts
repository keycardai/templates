import { createRequire } from "node:module";
import type { KeycardTokenProvider } from "./tokenProvider.js";

const require = createRequire(import.meta.url);
const snowflakeSdk = require("snowflake-sdk") as SnowflakeSdk;

// ---------------------------------------------------------------------------
// Minimal type shims for snowflake-sdk (CJS, no .d.ts)
// ---------------------------------------------------------------------------

interface SnowflakeConnection {
  connect(
    cb: (err: Error | undefined, conn: SnowflakeConnection) => void,
  ): void;
  execute(options: {
    sqlText: string;
    complete: (
      err: Error | undefined,
      stmt: unknown,
      rows: unknown[],
    ) => void;
  }): void;
  destroy(cb: (err: Error | undefined) => void): void;
  getId(): string;
}

interface SnowflakeSdk {
  createConnection(options: Record<string, unknown>): SnowflakeConnection;
  configure(options: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const SNOWFLAKE_RESOURCE = "snowflakecomputing.com";

export interface SnowflakeClientConfig {
  account: string;
  user?: string;
  database?: string;
  warehouse?: string;
  role?: string;
}

// ---------------------------------------------------------------------------
// Backoff (mirrors AgentSession._handleRetryableError pattern)
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;

function backoffDelay(attempt: number): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return delay + Math.random() * delay * 0.1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SnowflakeClient — manages connection lifecycle with token refresh
// ---------------------------------------------------------------------------

export class SnowflakeClient {
  private connection: SnowflakeConnection | null = null;

  constructor(
    private tokenProvider: KeycardTokenProvider,
    private config: SnowflakeClientConfig,
  ) {}

  async connect(): Promise<void> {
    const accessToken = await this.tokenProvider.getToken(SNOWFLAKE_RESOURCE);
    this.connection = await this.openConnection(accessToken);
  }

  async execute(sql: string): Promise<unknown[]> {
    if (!this.connection) {
      await this.connect();
    }

    try {
      return await this.runQuery(this.connection!, sql);
    } catch (err) {
      if (!this.isConnectionError(err)) throw err;

      console.warn("Snowflake connection lost, reconnecting...");
      await this.reconnect();
      return this.runQuery(this.connection!, sql);
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      await this.runQuery(this.connection, "SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    if (!this.connection) return;
    const conn = this.connection;
    this.connection = null;
    await new Promise<void>((resolve, reject) => {
      conn.destroy((err) => (err ? reject(err) : resolve()));
    });
  }

  private async reconnect(): Promise<void> {
    this.tokenProvider.invalidate(SNOWFLAKE_RESOURCE);

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        await this.destroy().catch(() => {});
        const accessToken = await this.tokenProvider.getToken(
          SNOWFLAKE_RESOURCE,
        );
        this.connection = await this.openConnection(accessToken);
        console.log("Snowflake reconnected successfully.");
        return;
      } catch (err) {
        const delay = backoffDelay(attempt);
        console.warn(
          `Reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} failed, ` +
            `retrying in ${Math.round(delay)}ms: ${err}`,
        );
        if (attempt < MAX_RECONNECT_ATTEMPTS - 1) {
          await sleep(delay);
        }
      }
    }

    throw new Error(
      `Failed to reconnect to Snowflake after ${MAX_RECONNECT_ATTEMPTS} attempts`,
    );
  }

  private openConnection(accessToken: string): Promise<SnowflakeConnection> {
    const options: Record<string, unknown> = {
      account: this.config.account,
      authenticator: "WORKLOAD_IDENTITY",
      workloadIdentityProvider: "OIDC",
      token: accessToken,
    };

    if (this.config.user) options.username = this.config.user;
    if (this.config.database) options.database = this.config.database;
    if (this.config.warehouse) options.warehouse = this.config.warehouse;
    if (this.config.role) options.role = this.config.role;

    const connection = snowflakeSdk.createConnection(options);

    return new Promise<SnowflakeConnection>((resolve, reject) => {
      connection.connect((err, conn) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
  }

  private runQuery(conn: SnowflakeConnection, sql: string): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve(rows);
        },
      });
    });
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("connection") ||
      msg.includes("network") ||
      msg.includes("socket") ||
      msg.includes("timeout") ||
      msg.includes("token") ||
      msg.includes("auth")
    );
  }
}
