# 衡记 Héng

开源、本地优先（local-first）的**复式记账**应用。深入浅出：**底层复式严谨，表面只是「记一笔」**。一处记清三类账——个人开支、小生意流水利润、投资盈亏。

## 下载

**[⬇ 下载最新版（Windows）](https://github.com/sailorsinbad14/hengji/releases/latest)** — 双击 `Hengji_x64-setup.exe` 安装即用，无需任何开发环境，数据 100% 存本机。

> v0.1.0（alpha）仅 Windows x64、未数字签名；首次运行若 SmartScreen 提示「未知发布者」，点「更多信息 → 仍要运行」即可。

## 特点
- 复式记账内核，借贷恒平衡；金额用整数最小单位（分），无浮点误差
- 单式录入体验，自动生成复式分录（用户感知不到借贷）
- 报表：账户余额、净资产、月度收支、生意利润（按标签）、预算用量
- 本地优先：数据在你设备上；（规划）可选付费云同步
- 跨平台路线：桌面优先（Tauri 2），移动随后；一套 React 前端复用

## 状态
Alpha / 开发中。**后端内核（领域逻辑 + 持久层）已完成、测试覆盖**；UI 与桌面壳进行中。

## 结构（pnpm monorepo）
- `packages/core` — 平台无关复式记账引擎（纯 TS，无 I/O）
- `packages/store` — 持久层：`Repository` 接口 + 内存实现 + SQLite 实现（node:sqlite，经 `@app/store/sqlite` 子路径导出）
- `apps/web` — UI（Vite + React，接 `Repository` 接口；当前内存仓库演示，桌面壳接入后换本地 SQLite）
- `demo/` — 落地页静态样稿

## 开发
前置：Node ≥ 24、pnpm ≥ 9
```sh
pnpm install
pnpm -r test                    # 全部测试
pnpm -r typecheck               # 类型检查
pnpm --filter @app/web dev      # 启动 UI（http://localhost:5173）
```

## 路线图
- **v0.1 MVP**：账户 / 记账 / 报表 + 桌面 UI（已完成骨架）
- **v0.2**：多账本（个人/生意/投资，可多开）+ 生意进销存与客户管理（客户/产品/订单/采购/库存/应收应付/付款凭证），设计见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **v0.3**：账单导入（CSV/表格）+ 预算提醒 + 图表
- **v0.4**：完整投资模块（持仓 / 估值 / 损益 / 多币种）
- **v0.5**：AI / 语音录入、票据 OCR
- **v1.0**：付费云同步

## 许可证
Apache-2.0（见 [`LICENSE`](./LICENSE)）。贡献见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)（DCO 签名）。架构与决策见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
