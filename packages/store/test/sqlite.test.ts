import { describe, it, expect } from 'vitest';
import { expandEntry } from '@app/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { SqliteRepository } from '../src/sqlite';
import { runRepositoryContract, fakeClock, counter, accounts } from './contract';

runRepositoryContract('SqliteRepository(:memory:)', (now) => new SqliteRepository(':memory:', { now }));

describe('SqliteRepository · 文件持久化', () => {
  it('写入文件 → close → 重开仍在', async () => {
    const file = join(tmpdir(), 'app-store-persist-test.db');
    const cleanup = (): void => {
      for (const ext of ['', '-wal', '-shm']) if (existsSync(file + ext)) rmSync(file + ext);
    };
    cleanup();
    try {
      const repo1 = new SqliteRepository(file, { now: fakeClock() });
      await repo1.addAccount(accounts[0]!);
      await repo1.addTransaction(
        expandEntry({ kind: 'expense', date: '2026-05-03', amount: 3000, accountId: 'bank', categoryId: 'food' }, counter()),
      );
      repo1.close();

      const repo2 = new SqliteRepository(file, { now: fakeClock() });
      expect((await repo2.getAccount('bank'))!.name).toBe('招行卡');
      expect((await repo2.listTransactions()).length).toBe(1);
      repo2.close();
    } finally {
      cleanup();
    }
  });
});
