import type { Account, Posting } from '@app/core';
import type { StoredAccount, StoredBudget, StoredTransaction } from './types';

/**
 * 三表规范化 schema + 索引（浏览器安全，无任何驱动依赖）。
 * node:sqlite（SqliteRepository）与 tauri-plugin-sql（TauriSqlRepository）两个实现共用，
 * 保证桌面与测试环境的数据形状完全一致。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  currency TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  FOREIGN KEY (txn_id) REFERENCES transactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_postings_txn ON postings(txn_id);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  monthly_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
)
`;

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  currency: string;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface TxnRow {
  id: string;
  date: string;
  payee: string;
  note: string;
  tags: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface PostingRow {
  id: string;
  txn_id: string;
  account_id: string;
  amount: number;
  currency: string;
}
export interface BudgetRow {
  id: string;
  account_id: string;
  monthly_limit: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}

export function toAccount(r: AccountRow): StoredAccount {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Account['type'],
    parentId: r.parent_id,
    currency: r.currency,
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toPosting(r: PostingRow): Posting {
  return { id: r.id, txnId: r.txn_id, accountId: r.account_id, amount: r.amount, currency: r.currency };
}

export function toBudget(r: BudgetRow): StoredBudget {
  return {
    id: r.id,
    accountId: r.account_id,
    monthlyLimit: r.monthly_limit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toTxn(r: TxnRow, postings: Posting[]): StoredTransaction {
  return {
    id: r.id,
    date: r.date,
    payee: r.payee,
    note: r.note,
    tags: JSON.parse(r.tags) as string[],
    postings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}
