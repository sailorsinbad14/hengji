import type { Account, Book, Posting } from '@app/core';
import type { StoredAccount, StoredBook, StoredBudget, StoredTransaction } from './types';

/**
 * 行映射（浏览器安全，无驱动依赖）。
 * 建表与演进见 ./migrations —— node:sqlite 与 tauri-plugin-sql 两实现共用，
 * 保证桌面与测试环境的数据形状完全一致。
 */

export interface BookRow {
  id: string;
  name: string;
  type: string;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}
export interface AccountRow {
  id: string;
  book_id: string;
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
  book_id: string;
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
  book_id: string;
  account_id: string;
  monthly_limit: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}

/** 把数组按 size 切片，避免 `IN (?,?,…)` 占位符超过 SQLite 变量上限（旧版 999/新版 32766）。 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 安全解析 tags JSON：坏数据降级为空数组，避免单行损坏炸掉整个列表查询。 */
export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function toBook(r: BookRow): StoredBook {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Book['type'],
    archived: r.archived !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}

export function toAccount(r: AccountRow): StoredAccount {
  return {
    id: r.id,
    bookId: r.book_id,
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
    bookId: r.book_id,
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
    bookId: r.book_id,
    date: r.date,
    payee: r.payee,
    note: r.note,
    tags: parseTags(r.tags),
    postings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted !== 0,
  };
}
