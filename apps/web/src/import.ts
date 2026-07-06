import { expandEntry, stagingRowToEntry } from '@app/core';
import type { ImportDraftRow, StagingPostDecision, StagingRow } from '@app/core';
import type { Repository, StoredBook, StoredStagingBatch, StoredStagingRow } from '@app/store';
import { genId } from './db';
import { removeSettlement, settleStagingRow } from './biz';
import type { SettleTarget } from './biz';
import { APP_SCOPE } from './settings';

/**
 * 账单导入编排层（增量1·②b）：解析器产出的 `ImportDraftRow[]` → staging 暂存 → 复核台逐笔落库 →
 * 整批撤销。范式同 docs.ts/biz.ts——core 保持纯（stagingRowToEntry + expandEntry），去重/落库/撤销/
 * 对方记忆这些带 Repository 的编排都在这一层。
 *
 * 红线（数据层兜不了、由本层做对，见 store/types.ts Repository 注释）：
 * - 去重按 **(source, biz_no) 复合键**（biz_no 仅在同 source 内唯一）；
 * - 撤销时把该批 posted 行退出 posted（清 txnId），否则死交易的 biz_no 污染去重集致重导被吞；
 * - 落库自愈：txnId 确定性派生自草稿行 id，重跑命中即已落、不重复落（绕过无跨表事务原语）；
 * - unknown/双关行必须复核台显式定夺 kind 才能 post（stagingRowToEntry 不按 direction 兜底）。
 */

/** 由草稿行 id 确定性派生交易 id：落库中断重跑时据此判「已落」、不重复落。 */
function txnIdForRow(rowId: string): string {
  return `imp_${rowId}`;
}

/** 由草稿行 id 确定性派生核销 Settlement id：整批撤销据此定位（无孤儿）、自愈重跑不重复建。 */
function settlementIdForRow(rowId: string): string {
  return `set_${rowId}`;
}

/** 已 posted 且属于该 source 的 biz_no 集合（复合键去重 + 崩溃自愈共用）。 */
async function postedBizNos(repo: Repository, source: string, bizNos: string[]): Promise<Set<string>> {
  if (bizNos.length === 0) return new Set();
  const posted = await repo.listStagingRows({ status: 'posted', bizNos });
  if (posted.length === 0) return new Set();
  // listStagingRows 只按 biz_no 匹配、不含 source —— 在此按 batch.source 二次过滤成复合键
  const batches = await repo.listStagingBatches();
  const sourceOf = new Map(batches.map((b) => [b.id, b.source]));
  const out = new Set<string>();
  for (const r of posted) if (sourceOf.get(r.batchId) === source) out.add(r.bizNo);
  return out;
}

export interface NewBatchInfo {
  /** 进料来源标识，如 'alipay-fund-flow'。 */
  source: string;
  /** 整批选定的全局源账户（支付宝/微信/银行…）id。 */
  accountId: string;
  /** 文件名 / 描述。 */
  label: string;
}

export interface CreateBatchResult {
  /** 新建的复核批次；若解析出的行全部已导入过则为 null（不建空批次）。 */
  batch: StoredStagingBatch | null;
  /** 实际入暂存的新行数。 */
  added: number;
  /** 因 (source, biz_no) 已 posted 被跳过的行数。 */
  skipped: number;
}

/** 建复核批次：先文件内按 biz_no 去重 + 按 (source, biz_no) 去重已落库的行，剩余作 pending 草稿入暂存。 */
export async function createImportBatch(repo: Repository, info: NewBatchInfo, rows: ImportDraftRow[]): Promise<CreateBatchResult> {
  // 文件内去重（解析器不保证同文件无重号；保留首条）——否则同号两条草稿都 post＝同一笔真实交易记两遍。
  const fileSeen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (fileSeen.has(r.bizNo)) return false;
    fileSeen.add(r.bizNo);
    return true;
  });
  const seen = await postedBizNos(repo, info.source, deduped.map((r) => r.bizNo));
  const fresh = deduped.filter((r) => !seen.has(r.bizNo));
  if (fresh.length === 0) return { batch: null, added: 0, skipped: rows.length };

  // 注：先建批再插行非事务——addStagingRows 失败会留一个 0 行的 reviewing 空批（无脏交易、可手撤）。
  // 与 docs.ts saveDocument 同源取舍，待 Repository 加跨表事务原语统一治。
  const batch = await repo.addStagingBatch({ id: genId(), source: info.source, accountId: info.accountId, label: info.label, status: 'reviewing' });
  const stagingRows: StagingRow[] = fresh.map((r) => ({
    id: genId(),
    batchId: batch.id,
    bizNo: r.bizNo,
    date: r.date,
    datetime: r.datetime,
    amountMinor: r.amountMinor,
    direction: r.direction,
    payee: r.payee,
    counterpartyAccount: r.counterpartyAccount ?? '',
    note: r.note,
    accountingType: r.accountingType,
    suggestion: r.suggestion,
    assignedBookId: null,
    assignedAccountId: null,
    status: 'pending',
    txnId: null,
  }));
  await repo.addStagingRows(stagingRows);
  return { batch, added: fresh.length, skipped: rows.length - fresh.length };
}

/**
 * 落库一条已复核的草稿行：stagingRowToEntry → expandEntry → addTransaction → 回填 txnId。
 * 自愈：交易 id 由行 id 确定性派生，若该交易已存在（上次落库后崩溃在回填前）则跳过新建、只补回填。
 */
export async function postStagingRow(repo: Repository, batch: StoredStagingBatch, row: StoredStagingRow, decision: StagingPostDecision): Promise<StoredStagingRow> {
  const txnId = txnIdForRow(row.id);
  // 原子：落库 + 回填行同事务——否则「交易已 commit 但行未置 posted」窗口里，用户把该行改走另一出口重 post，
  // 会因 imp_<rowId> 命名空间共用被另一出口误判已落而留 split-brain（账本与行元数据脱钩）。同事务后该窗口不存在。
  return repo.transaction(async () => {
    const existing = await repo.getTransaction(txnId);
    if (!existing) {
      const input = stagingRowToEntry(row, decision, batch.accountId);
      let firstCall = true;
      const gen = (): string => {
        if (firstCall) {
          firstCall = false;
          return txnId; // 交易 id＝确定性派生；分录 id 随机
        }
        return genId();
      };
      await repo.addTransaction(expandEntry(input, gen));
    }
    return repo.updateStagingRow(row.id, {
      assignedBookId: decision.bookId,
      assignedAccountId: decision.accountId,
      suggestion: decision.kind,
      status: 'posted',
      txnId,
    });
  });
}

/**
 * 出口①：核销落库一条已复核的草稿行（对偶撤销在 revertImportBatch 走 removeSettlement）——
 * 不造裸收支 entry，而是把流水核销到已有客户/供应商应收/应付（建核销分录 + Settlement）。
 * 自愈：交易 id 确定性派生（imp_<rowId>）、Settlement id 确定性派生（set_<rowId>）；交易已存在则跳过新建、只补回填。
 * 收/付款资产账户恒取批次源账户（这笔流水本就进出该账户）。
 */
export async function settleImportRow(repo: Repository, batch: StoredStagingBatch, book: StoredBook, row: StoredStagingRow, target: SettleTarget): Promise<StoredStagingRow> {
  const txnId = txnIdForRow(row.id);
  // 原子：核销 + 回填行同事务（与 postStagingRow 同理，消除「已 commit 但行未 posted」窗口致的跨出口 split-brain）。
  return repo.transaction(async () => {
    const existing = await repo.getTransaction(txnId);
    if (!existing) {
      let firstCall = true;
      const gen = (): string => {
        if (firstCall) {
          firstCall = false;
          return txnId; // 交易 id＝确定性派生；分录 id 随机
        }
        return genId();
      };
      await settleStagingRow(repo, book, {
        direction: row.direction,
        target: { ...target, assetAccountId: batch.accountId }, // 资产账户恒＝批次源账户（单一真相）
        amount: row.amountMinor,
        date: row.date,
        note: row.note,
        idGen: gen,
        settlementId: settlementIdForRow(row.id),
      });
    }
    return repo.updateStagingRow(row.id, {
      assignedBookId: book.id,
      assignedAccountId: batch.accountId,
      status: 'posted',
      txnId,
    });
  });
}

/** 跳过一条草稿行（不落库），置 skipped。 */
export function skipStagingRow(repo: Repository, rowId: string): Promise<StoredStagingRow> {
  return repo.updateStagingRow(rowId, { status: 'skipped' });
}

/**
 * 整批撤销：软删该批所有 posted 行生成的交易（余额回退）+ 逐行退出 posted（置 skipped、清 txnId）+ 批次置 reverted。
 * - 裸收支行：软删其交易。**核销行（出口①）**：走 `removeSettlement`（反向分录 + 软删 Settlement，原子）——
 *   不可裸软删交易，否则留指向已撤分录的 Settlement 孤儿、应收/应付回退不净。核销行据 `set_<rowId>` 定位。
 * - 退出 posted 是红线——否则死交易的 biz_no 仍在去重集，重导同账单会被误判已落而吞掉。
 * - 行置 **skipped 终态**（非回 pending）：撤销后该批草稿不再复核/重 post；要重做请**重新导入**——
 *   生成全新行 + 全新确定性交易 id，避开 `imp_<rowId>` 与已软删墓碑相撞致 addTransaction 报「已存在」。
 * @param today 撤销当期日期：核销行若已对账(cleared)走红冲、冲正落此日（裸收支/未对账行不用）。
 */
export async function revertImportBatch(repo: Repository, batchId: string, today: string): Promise<void> {
  const posted = await repo.listStagingRows({ batchId, status: 'posted' });
  for (const r of posted) {
    // 每行整段撤销（分类 + 回退 + 退出 posted）同事务——否则在「Settlement 已软删但行仍 posted」的中断窗口里，
    // 重入会因 getSettlement(set_<id>) 返 null 把核销行误判为裸收支行，对已对账(cleared)行的红冲后存活原交易再软删＝二次回退。
    await repo.transaction(async () => {
      if (r.txnId) {
        const settlement = await repo.getSettlement(settlementIdForRow(r.id));
        if (settlement) {
          // 核销行：撤核销（reverseTxn 软删/红冲 + 软删 Settlement，原子、幂等）
          await removeSettlement(repo, settlement.id, { date: today });
        } else {
          // 裸收支行：软删其交易
          const txn = await repo.getTransaction(r.txnId);
          if (txn && !txn.deleted) await repo.softDeleteTransaction(r.txnId);
        }
      }
      await repo.updateStagingRow(r.id, { status: 'skipped', txnId: null });
    });
  }
  await repo.updateStagingBatch(batchId, { status: 'reverted' });
}

// —— 对方记忆（对方 → 上次落入的账本 + 分类科目）——
// 存 app 级单条 JSON map（payee → {bookId, accountId}）。复核台据此预选、用户可改；落库后回写。

const CPMEM_KEY = 'importCounterpartyMemory';

/** 对方 → 上次分类。 */
export type CounterpartyMemory = Record<string, { bookId: string; accountId: string }>;

/** 读对方记忆（坏 JSON 降级为空）。 */
export async function loadCounterpartyMemory(repo: Repository): Promise<CounterpartyMemory> {
  const row = await repo.getSetting(APP_SCOPE, CPMEM_KEY);
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CounterpartyMemory) : {};
  } catch {
    return {};
  }
}

/** 纯查：对方上次分类（无记忆返 null）。空对方名不记忆。 */
export function recallCounterparty(mem: CounterpartyMemory, payee: string): { bookId: string; accountId: string } | null {
  const p = payee.trim();
  return p ? (mem[p] ?? null) : null;
}

/** 批量回写对方记忆（一次读改写、避免逐行 N 次写）。空对方名跳过。 */
export async function rememberCounterparties(repo: Repository, entries: Array<{ payee: string; bookId: string; accountId: string }>): Promise<void> {
  const fresh = entries.filter((e) => e.payee.trim() !== '');
  if (fresh.length === 0) return;
  const mem = await loadCounterpartyMemory(repo);
  for (const e of fresh) mem[e.payee.trim()] = { bookId: e.bookId, accountId: e.accountId };
  await repo.setSetting(APP_SCOPE, CPMEM_KEY, JSON.stringify(mem));
}
