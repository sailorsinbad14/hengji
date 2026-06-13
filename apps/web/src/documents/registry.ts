import type { DocumentType } from '@app/core';

/**
 * 内置单据类型注册表（插件地基 Step 1）。
 * 此期单据类型（DocumentType）硬编码于此、不入库；store 只存填好的实例（plugin_documents）。
 * 待 L1 可视化编辑器落地，DocumentType 才转为可持久化、可分享的配置。
 *
 * 「平台电商销售单」= 吃狗粮目标（ARCHITECTURE 平台销售例）：
 * 小老板在平台卖货，平台抽佣金 + 扣物流费。一张单声明式展开成 4 腿：
 *   贷 营业收入(商品额) / 借 平台佣金(费用) / 借 物流费(费用) / 借 平台应收款(平衡腿=实际可收)
 * 佣金/物流引用账本级 FeeDefinition（声明式阶梯，复用 computeFees）。
 */
export const PLATFORM_SALE: DocumentType = {
  id: 'builtin.platformSale',
  name: '平台电商销售单',
  fields: [
    { key: 'shop', label: '店铺 / 平台', type: 'text' },
    { key: 'date', label: '日期', type: 'date' },
    { key: 'lines', label: '商品', type: 'lines' },
    { key: 'commissionFeeId', label: '平台佣金', type: 'fee' },
    { key: 'shippingFeeId', label: '物流费', type: 'fee' },
  ],
  entries: [
    {
      legs: [
        { account: { kind: 'named', name: '营业收入', type: 'income' }, side: 'credit', amount: { src: 'lineTotal' } },
        { account: { kind: 'named', name: '平台佣金', type: 'expense' }, side: 'debit', amount: { src: 'feeField', key: 'commissionFeeId' } },
        { account: { kind: 'named', name: '物流费', type: 'expense' }, side: 'debit', amount: { src: 'feeField', key: 'shippingFeeId' } },
        // 平衡腿：商品额 − 佣金 − 物流 = 平台实际打给你的钱（平台应收款，独立顶层资产，不入按客户 AR 体系）
        { account: { kind: 'named', name: '平台应收款', type: 'asset' }, side: 'debit', balance: true },
      ],
    },
  ],
};

/** docType.id → 定义。v1 仅生意账本可用平台销售单。 */
export const DOCUMENT_REGISTRY: Record<string, DocumentType> = {
  [PLATFORM_SALE.id]: PLATFORM_SALE,
};
