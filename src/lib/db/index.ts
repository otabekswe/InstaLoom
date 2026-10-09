import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { ConfigurationError } from "@/lib/config";
import { migrate } from "./schema";
import { createPool, migratePostgres, postgresSql, TRANSACTION_LOCK } from "./postgres";

type ChangeResult = { changes: number; lastInsertRowid: number | bigint };
type TransactionContext = { database: AppDatabase; client?: PoolClient; active: boolean };
const context = new AsyncLocalStorage<TransactionContext>();

export class AppDatabase {
  readonly kind: "sqlite" | "postgres";
  private sqlite?: Database.Database;
  private pool?: Pool;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(url?: string) {
    this.kind = url ? "postgres" : "sqlite";
    if (url) this.pool = createPool(url);
    else {
      const defaultPath = path.join(process.cwd(), "data", "instaloom.db");
      const legacyPath = path.join(process.cwd(), "data", "chatplace.db");
      const filename = process.env.DATABASE_PATH || (!existsSync(defaultPath) && existsSync(legacyPath) ? legacyPath : defaultPath);
      if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
      this.sqlite = new Database(filename);
      try { this.sqlite.pragma("busy_timeout = 3000"); migrate(this.sqlite); }
      catch (error) { this.sqlite.close(); throw error; }
    }
  }

  private initialize() {
    return this.ready ??= this.pool ? migratePostgres(this.pool).catch((error) => { this.ready = undefined; throw error; }) : Promise.resolve();
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private transactionContext() {
    const current = context.getStore();
    if (current?.database !== this) return undefined;
    if (!current.active) throw new Error("Database work escaped its transaction. Await all queries before returning.");
    return current;
  }

  private async query(sql: string, params: unknown[], operation: "all" | "get" | "run" | "exec"): Promise<unknown> {
    await this.initialize();
    const current = this.transactionContext();
    if (this.pool) {
      const result = await (current?.client ?? this.pool).query(postgresSql(sql), params.length ? params : undefined);
      if (operation === "exec") return;
      if (operation === "run") return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
      return operation === "get" ? result.rows[0] : result.rows;
    }
    const execute = async () => {
      if (operation === "exec") { this.sqlite!.exec(sql); return; }
      return this.sqlite!.prepare(sql)[operation](...params);
    };
    return current ? execute() : this.locked(execute);
  }

  prepare(sql: string) {
    return {
      all: (...params: unknown[]) => this.query(sql, params, "all") as Promise<unknown[]>,
      get: (...params: unknown[]) => this.query(sql, params, "get") as Promise<unknown>,
      run: (...params: unknown[]) => this.query(sql, params, "run") as Promise<ChangeResult>,
    };
  }

  async exec(sql: string): Promise<void> { await this.query(sql, [], "exec"); }

  transaction<T>(operation: () => T | Promise<T>) {
    const execute = async (): Promise<T> => {
      await this.initialize();
      if (this.transactionContext()) return operation();
      const transact = async () => {
        const client = await this.pool?.connect();
        const state: TransactionContext = { database: this, client, active: true };
        try {
          if (client) {
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = '20s'");
            // Serialize database-only work across serverless instances. Never
            // perform Instagram requests while holding this transaction lock.
            await client.query("SELECT pg_advisory_xact_lock($1)", [TRANSACTION_LOCK]);
          } else this.sqlite!.exec("BEGIN IMMEDIATE");
          const value = await context.run(state, operation);
          if (client) await client.query("COMMIT");
          else this.sqlite!.exec("COMMIT");
          return value;
        } catch (error) {
          if (client) await client.query("ROLLBACK").catch(() => {});
          else this.sqlite!.exec("ROLLBACK");
          throw error;
        } finally { state.active = false; client?.release(); }
      };
      return this.pool ? transact() : this.locked(transact);
    };
    return Object.assign(execute, { immediate: execute });
  }

  async close() {
    await this.queue;
    await this.ready?.catch(() => {});
    await this.pool?.end();
    this.sqlite?.close();
  }
}

let db: AppDatabase | null = null;
export function getDb(): AppDatabase {
  if (!db) {
    const url = process.env.DATABASE_URL?.trim();
    if (process.env.VERCEL && !url) throw new ConfigurationError("Set DATABASE_URL to your Postgres connection string before deploying.");
    if (url && !/^postgres(?:ql)?:\/\//.test(url)) throw new ConfigurationError("DATABASE_URL must be a Postgres connection string.");
    db = new AppDatabase(url);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  const previous = db;
  db = null;
  await previous?.close();
}

export async function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  return await getDb().prepare(sql).all(...params) as T[];
}
export async function first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  return await getDb().prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: unknown[]): Promise<ChangeResult> { return getDb().prepare(sql).run(...params); }
export function exec(sql: string): Promise<void> { return getDb().exec(sql); }
