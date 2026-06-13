import type { AccountType, Posting, Transaction } from './types';
import { assertBalanced } from './ledger';
import { assertMinor } from './money';

/**
 * 插件地基（north-star 第一步）：声明式单据 → 候选平衡分录的确定性运行时。
 *
 * 范式与 `business.ts` 一致——core 吃「已解析好的 accountId」，账户的 ensure-or-create 留在 web 编排层。
 * core 只做两件事：① 按声明的「金额来源」对单据数据求值；② 建分录、过 `assertBalanced` 防火墙。
 * 插件因此只能产出**候选**分录，碰不到 store、破坏不了账本（ARCHITECTURE「插件/可组合账本」L-2）。
 *
 * v1 有意从简（见 ARCHITECTURE）：
 * - 金额用「来源枚举」而非完整表达式树（lineTotal / 费用 / 字段 / 常量）；一条「平衡腿」吃差额。
 * - 单据类型（DocumentType）此期硬编码在 web 注册表、不入库；store 只存单据实例（PluginDocument）。
 * - 单一币种（CNY）。表达式树 / 多币种 / 子科目自动建 等留待后续切片。
 */

/** 单据字段类型（v1：表单渲染与求值用）。 */
export type FieldType = 'text' | 'number' | 'money' | 'date' | 'account' | 'fee' | 'lines';

/** 一个单据字段（用户要填的输入）。 */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
}

/**
 * 分录腿的账户引用（声明式，web 负责解析成 accountId）：
 * - `named`：命名科目（如「营业收入」），web `ensure-or-create` 顶层科目；
 * - `field`：用户在某字段里选的账户 id（data[key] 即 accountId）。
 */
export type AccountRef =
  | { kind: 'named'; name: string; type: AccountType }
  | { kind: 'field'; key: string };

/**
 * 金额来源（v1 枚举，非表达式树）。返回**非负**最小单位金额（分），符号由腿的 `side` 决定：
 * - `lineTotal`：Σ 商品行金额；
 * - `feeField`：某 fee 字段选中的额外费用的计算结果（web 用 `computeFees` 预先算入 scope）；
 * - `field`：某数值字段（分）；
 * - `fixed`：常量（分）。
 */
export type AmountSource =
  | { src: 'lineTotal' }
  | { src: 'feeField'; key: string }
  | { src: 'field'; key: string }
  | { src: 'fixed'; value: number };

/** 一条分录腿（声明式）。`balance` 腿不指定金额，吃「使本笔平衡」所需的差额。 */
export interface PostingLeg {
  account: AccountRef;
  /** 借（金额取正）/ 贷（金额取负）。平衡腿的符号由差额决定，此字段仅作意图标注。 */
  side: 'debit' | 'credit';
  /** 显式金额来源（与 balance 二选一）。 */
  amount?: AmountSource;
  /** 平衡腿：金额 = −（其余腿有符号金额之和），保证整笔求和=0。一笔至多一条。 */
  balance?: boolean;
}

/** 一笔分录（一组必须平衡的腿）。一个单据可声明多笔（如收入 + 成本）。 */
export interface DocumentEntry {
  legs: PostingLeg[];
}

/** 单据类型（声明式 schema）：字段 + 记账规则。v1 硬编码在 web 注册表。 */
export interface DocumentType {
  /** pluginId.docType，如 'builtin.platformSale' */
  id: string;
  name: string;
  fields: FieldDef[];
  entries: DocumentEntry[];
}

/**
 * 单据实例（持久化于 store `plugin_documents`）：用户填的字段值 + 生成的交易 id。
 * `data` 的结构由对应 DocumentType.fields 决定；引擎只读其中的数值与费用结果。
 */
export interface PluginDocument {
  id: string;
  bookId: string;
  /** 插件标识（内置为 'builtin'） */
  pluginId: string;
  /** 单据类型 docType（如 'platformSale'） */
  docType: string;
  data: Record<string, unknown>;
  /** 生成的交易 id（作废单据时反向这些交易） */
  txnIds: string[];
}

/** 求值上下文（由 web 从单据数据 + computeFees 结果组装；全为最小单位/分）。 */
export interface EvalScope {
  /** Σ 商品行金额（分） */
  lineTotal: number;
  /** fee 字段 key → 该费用算出的合计（分） */
  feeFields: Record<string, number>;
  /** 数值字段 key → 值（分） */
  fields: Record<string, number>;
}

/** 已把 AccountRef 解析成 accountId 的分录腿（web 解析后交给 core）。 */
export interface ResolvedLeg {
  accountId: string;
  side: 'debit' | 'credit';
  amount?: AmountSource;
  balance?: boolean;
}

/** 对一个「金额来源」求值，返回非负最小单位金额（缺省/缺失按 0）。 */
export function evalAmount(src: AmountSource, scope: EvalScope): number {
  switch (src.src) {
    case 'lineTotal':
      return scope.lineTotal;
    case 'feeField':
      return scope.feeFields[src.key] ?? 0;
    case 'field':
      return scope.fields[src.key] ?? 0;
    case 'fixed':
      return src.value;
    default: {
      const _exhaustive: never = src;
      throw new Error(`未知的金额来源：${String(_exhaustive)}`);
    }
  }
}

/**
 * 把一笔单据分录展开成一笔平衡的复式交易：
 * - 非平衡腿：金额 = evalAmount（借取正、贷取负）；**金额为 0 的非平衡腿丢弃**（如未选的费用、包邮）。
 * - 平衡腿（至多一条）：金额 = −（其余腿有符号之和），把差额塞进该科目（如应收）。
 * 最后过 `assertBalanced` 防火墙（与 expandEntry 等所有构造器同一道关），不平直接抛错。
 * genId 由调用方注入（store 传 randomUUID、测试传计数器），保持 core 纯。
 */
export function expandDocumentEntry(
  legs: ReadonlyArray<ResolvedLeg>,
  scope: EvalScope,
  opts: { bookId: string; date: string; currency?: string; payee?: string; note?: string; tags?: string[] },
  genId: () => string,
): Transaction {
  const balanceLegs = legs.filter((l) => l.balance);
  if (balanceLegs.length > 1) throw new Error('一笔分录至多一条平衡腿');

  const currency = opts.currency ?? 'CNY';
  const txnId = genId();
  // 防火墙自守整数最小单位：fixed/field 来源是给插件作者透传金额的入口，core 不能假设 web 已 round。
  const mk = (accountId: string, amount: number): Posting => {
    assertMinor(amount, 'posting amount');
    return { id: genId(), txnId, accountId, amount, currency };
  };

  const postings: Posting[] = [];
  let runningSum = 0;
  for (const leg of legs) {
    if (leg.balance) continue;
    if (!leg.amount) throw new Error('非平衡腿必须指定金额来源');
    const magnitude = evalAmount(leg.amount, scope);
    if (magnitude === 0) continue; // 0 额腿丢弃（未选费用/包邮等）
    const signed = leg.side === 'debit' ? magnitude : -magnitude;
    runningSum += signed;
    postings.push(mk(leg.accountId, signed));
  }
  if (balanceLegs.length === 1 && runningSum !== 0) {
    postings.push(mk(balanceLegs[0]!.accountId, -runningSum));
  }
  if (postings.length === 0) throw new Error('单据展开后无任何分录（金额全为 0）');

  assertBalanced(postings); // 防火墙：单一币种求和必须=0
  return {
    id: txnId,
    bookId: opts.bookId,
    date: opts.date,
    payee: opts.payee ?? '',
    note: opts.note ?? '',
    tags: opts.tags ?? [],
    postings,
  };
}
