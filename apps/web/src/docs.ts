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
  const consumed = new Set<string>(); // 同一 FeeDefinition 被多个 fee 字段选中时只计一次，避免重复扣费
  for (const f of docType.fields) {
    if (f.type !== 'fee') continue;
    const feeId = data[f.key];
    if (typeof feeId !== 'string' || !feeId || consumed.has(feeId)) continue;
    const feeDef = feeDefs.find((fd) => fd.id === feeId);
    if (!feeDef) continue;
    consumed.add(feeId);
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
  let allBalanced = true; // 逐 entry 校验：每笔内部(含平衡腿)借贷相等，才算整体平衡
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
    if (balanceLeg) {
      // 平衡腿吃差额：running<0 落借（如平台应收款），running>0 落贷（费用>商品额=倒欠）；差额 0 不落腿
      if (running !== 0) legs.push({ name: refName(balanceLeg.account), side: running < 0 ? 'debit' : 'credit', amount: Math.abs(running) });
    } else if (running !== 0) {
      allBalanced = false; // 无平衡腿且本笔不配平
    }
  }
  const debit = legs.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
  const credit = legs.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
  return { legs, debit, credit, balanced: allBalanced, lineTotal: scope.lineTotal };
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
  // 逐行校验：负数会被混合行净额绕过聚合校验、污染账本；有金额的行必须有名称
  for (const l of docLines(data)) {
    if (l.qty < 0 || l.unitPrice < 0) throw new Error('商品行的数量、单价不能为负');
    if (!l.name && Math.round(l.qty * l.unitPrice) !== 0) throw new Error('有金额的商品行必须填写名称');
  }
  const scope = buildScope(docType, data, feeDefs);
  if (scope.lineTotal <= 0) throw new Error('商品金额为 0，无法保存');
  const { pluginId, docType: dt } = splitDocTypeId(docType.id);
  // 注：多 entry 非事务——若中途 addTransaction 失败、addPluginDocument 未执行，已落的交易会成为
  // Documents 页够不到的孤儿（需到流水页手删）。与 biz.ts completeOrder 同源取舍；待 Repository 加事务原语统一治。
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
