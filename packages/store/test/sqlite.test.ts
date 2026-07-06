import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { expandEntry } from '@app/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { MIGRATIONS } from '../src/index';
import { SqliteRepository } from '../src/sqlite';
import { runRepositoryContract, fakeClock, counter, books, accounts, B1 } from './contract';

runRepositoryContract('SqliteRepository(:memory:)', (now) => new SqliteRepository(':memory:', { now }));

function tmpFile(name: string): { file: string; cleanup: () => void } {
  const file = join(tmpdir(), name);
  const cleanup = (): void => {
    for (const ext of ['', '-wal', '-shm']) if (existsSync(file + ext)) rmSync(file + ext);
  };
  return { file, cleanup };
}

describe('SqliteRepository · 文件持久化', () => {
  it('写入文件 → close → 重开仍在', async () => {
    const { file, cleanup } = tmpFile('app-store-persist-test.db');
    cleanup();
    try {
      const repo1 = new SqliteRepository(file, { now: fakeClock() });
      await repo1.addBook(books[0]!);
      await repo1.addAccount(accounts[0]!);
      await repo1.addAccount(accounts[4]!);
      await repo1.addTransaction(
        expandEntry(
          { kind: 'expense', bookId: B1, date: '2026-05-03', amount: 3000, accountId: 'bank', categoryId: 'food' },
          counter(),
        ),
      );
      repo1.close();

      const repo2 = new SqliteRepository(file, { now: fakeClock() });
      expect((await repo2.getBook(B1))!.name).toBe('我的日常');
      expect((await repo2.getAccount('bank'))!.bookId).toBe(B1);
      expect((await repo2.listTransactions({ bookId: B1 })).length).toBe(1);
      repo2.close();
    } finally {
      cleanup();
    }
  });
});

describe('SqliteRepository · 遗留库迁移（m1 库 → m2 多账本）', () => {
  it('无 book_id 的旧库打开即迁移：建 books 表、回填 default 账本', async () => {
    const { file, cleanup } = tmpFile('app-store-migration-test.db');
    cleanup();
    try {
      // 用 m1 语句手工造一个 v0.1 旧库（user_version=1），插入旧数据
      const raw = new DatabaseSync(file);
      for (const stmt of MIGRATIONS[0]!) raw.exec(stmt);
      raw.exec('PRAGMA user_version = 1');
      raw
        .prepare(
          `INSERT INTO accounts (id, name, type, parent_id, currency, archived, created_at, updated_at, deleted)
           VALUES ('bank', '招行卡', 'asset', NULL, 'CNY', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO transactions (id, date, payee, note, tags, created_at, updated_at, deleted)
           VALUES ('t1', '2026-05-01', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`,
        )
        .run();
      raw
        .prepare(`INSERT INTO budgets (id, account_id, monthly_limit, created_at, updated_at, deleted)
           VALUES ('bg1', 'bank', 1000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`)
        .run();
      raw.close();

      // 打开仓库 → 自动迁移
      const repo = new SqliteRepository(file, { now: fakeClock() });
      const allBooks = await repo.listBooks();
      expect(allBooks.length).toBe(1);
      expect(allBooks[0]!.id).toBe('default');
      expect(allBooks[0]!.type).toBe('personal');
      expect((await repo.getAccount('bank'))!.bookId).toBe('default');
      expect((await repo.getTransaction('t1'))!.bookId).toBe('default');
      expect((await repo.getTransaction('t1'))!.orderId).toBeNull(); // M18a：旧库 ALTER 加列、既有行回落 NULL
      expect((await repo.listBudgets({ bookId: 'default' })).length).toBe(1);
      repo.close();

      // 重开不再重复迁移（user_version 已到位、default 账本唯一）
      const repo2 = new SqliteRepository(file, { now: fakeClock() });
      expect((await repo2.listBooks()).length).toBe(1);
      repo2.close();
    } finally {
      cleanup();
    }
  });

  it('空白新库迁移后没有自动账本（由应用首启创建）', async () => {
    const repo = new SqliteRepository(':memory:', { now: fakeClock() });
    expect((await repo.listBooks()).length).toBe(0);
    repo.close();
  });
});
