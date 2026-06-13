import { computeFees, evalAmount, expandDocumentEntry, feesTotal } from '@app/core';
import type { AccountRef, DocumentType, EvalScope, FeeLine, ResolvedLeg } from '@app/core';
import type { Repository, StoredBook, StoredFeeDefinition, StoredPluginDocument } from '@app/store';
import { ensureNamedAccount } from './biz';
import { genId } from './db';

/**
 * 插件单据编排层（插件地基 Step 1）：声明式单据 → 候选平衡分录 → 落库。
 * 范式同 biz.ts——core 保持纯（expandDocumentEntry 吃已解析 accountId + EvalScope），
 * 账户 ensure-or-create、computeFees 预算、落库都在这一层。
 *
 * v1 单一币种 CNY；DocumentType 来自 web 注册表（registry.ts），不入库；store 只存实例。
 */

/** 单据商品行（unitPrice 为最小单位/分）。 */
export interface DocLine {
  name: string;
  qty: number;
  unitPrice: number;
}

function docLines(data: Record<string, unknown>): DocLine[] {
  const raw = data.lines;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return { name: String(o.name ?? ''), qty: Number(o.qty) || 0, unitPrice: Number(o.unitPrice) || 0 };
  });
}

/** 'builtin.platformSale' → { pluginId:'builtin', docType:'platformSale' }。 */
function splitDocTypeId(id: string): { pluginId: string; docType: string } {
  const i = id.indexOf('.');
  return i < 0 ? { pluginId: 'builtin', docType: id } : { pluginId: id.slice(0, i), docType: id.slice(i + 1) };
}

/** 从单据数据 + 账本费用定义组装求值上下文：行合计 + 各 fee 字段算出的费用合计。 */
function buildScope(docType: DocumentType, data: Record<string, unknown>, feeDefs: StoredFeeDefinition[]): EvalScope {
  const lines = docLines(data);
  const lineTotal = lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0);
  const feeFields: Record<string, number> = {};
  for (const f of docType.fields) {
    if (f.type !== 'fee') continue;
    const feeId = data[f.key];
    if (typeof feeId !== 'string' || !feeId) continue;
    const feeDef = feeDefs.find((fd) => fd.id === feeId);
    if (!feeDef) continue;
    // 该费用应用到本单全部商品行（computeFees 按分组合计定阶梯档）
    const feeLines: FeeLine[] = lines.map((l) => ({ amount: Math.round(l.qty * l.unitPrice), qty: l.qty, feeIds: [feeDef.id] }));
    feeFields[f.key] = feesTotal(computeFees(feeLines, [feeDef]));
  }
  return { lineTotal, feeFields, fields: {} };
}

function refName(ref: AccountRef): string {
  return ref.kind === 'named' ? ref.name : `字段:${ref.key}`;
}

/** 预览一腿。 */
export interface PreviewLeg {
  name: string;
  side: 'debit' | 'credit';
  amount: number;
}

/** 单据实时预览（纯函数、无副作用，不 ensure 账户）：算出各腿金额 + 借贷合计 + 是否平衡。 */
export interface DocPreview {
  legs: PreviewLeg[];
  debit: number;
  credit: number;
  balanced: boolean;
  lineTotal: number;
}

export function previewDocument(docType: DocumentType, data: Record<string, unknown>, feeDefs: StoredFeeDefinition[]): DocPreview {
  const scope = buildScope(docType, data, feeDefs);
  const legs: PreviewLeg[] = [];
  for (const entry of docType.entries) {
    let running = 0;
    const balanceLeg = entry.legs.find((l) => l.balance);
    for (const leg of entry.legs) {
      if (leg.balance || !leg.amount) continue;
      const mag = evalAmount(leg.amount, scope);
      if (mag === 0) continue; // 0 额腿不展示（未选费用/包邮）
      running += leg.side === 'debit' ? mag : -mag;
      legs.push({ name: refName(leg.account), side: leg.side, amount: mag });
    }
    if (balanceLeg && running !== 0) {
      const signed = -running;
      legs.push({ name: refName(balanceLeg.account), side: signed >= 0 ? 'debit' : 'credit', amount: Math.abs(signed) });
    }
  }
  const debit = legs.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
  const credit = legs.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
  return { legs, debit, credit, balanced: debit === credit, lineTotal: scope.lineTotal };
}

async function resolveLegAccount(repo: Repository, book: StoredBook, ref: AccountRef, data: Record<string, unknown>): Promise<string> {
  if (ref.kind === 'named') return ensureNamedAccount(repo, book, ref.name, ref.type);
  const v = data[ref.key];
  if (typeof v !== 'string' || !v) throw new Error(`字段「${ref.key}」未选择账户`);
  return v;
}

/** 保存单据：解析账户 → core 展开成平衡分录 → 逐笔落库 → 存单据实例（带 txnIds）。 */
export async function saveDocument(repo: Repository, book: StoredBook, docType: DocumentType, data: Record<string, unknown>): Promise<void> {
  const feeDefs = await repo.listFeeDefinitions({ bookId: book.id, includeArchived: true });
  const scope = buildScope(docType, data, feeDefs);
  if (scope.lineTotal <= 0) throw new Error('商品金额为 0，无法保存');
  const { pluginId, docType: dt } = splitDocTypeId(docType.id);
  const payee = typeof data.shop === 'string' ? data.shop : '';
  const date = typeof data.date === 'string' && data.date ? data.date : new Date().toISOString().slice(0, 10);
  const txnIds: string[] = [];
  for (const entry of docType.entries) {
    const resolved: ResolvedLeg[] = [];
    for (const leg of entry.legs) {
      resolved.push({ accountId: await resolveLegAccount(repo, book, leg.account, data), side: leg.side, amount: leg.amount, balance: leg.balance });
    }
    const txn = expandDocumentEntry(resolved, scope, { bookId: book.id, date, currency: 'CNY', payee, note: docType.name }, genId);
    await repo.addTransaction(txn);
    txnIds.push(txn.id);
  }
  await repo.addPluginDocument({ id: genId(), bookId: book.id, pluginId, docType: dt, data, txnIds });
}

/** 作废单据：软删其生成的交易（余额随之回退）+ 软删单据实例。 */
export async function voidDocument(repo: Repository, doc: StoredPluginDocument): Promise<void> {
  for (const txnId of doc.txnIds) {
    const txn = await repo.getTransaction(txnId);
    if (txn && !txn.deleted) await repo.softDeleteTransaction(txnId);
  }
  await repo.removePluginDocument(doc.id);
}
