import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
export interface TaskContext { id: string; client: pg.PoolClient; database: unknown; active: boolean }
export const taskContext = new AsyncLocalStorage<TaskContext>();
export function currentTaskContext() { const context = taskContext.getStore(); if (context && !context.active) throw new Error("任务运行连接已失效，已停止后续执行。"); return context; }
