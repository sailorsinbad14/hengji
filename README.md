# 衡记 Héng

**中文** · [English](README.en.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/sailorsinbad14/hengji)](https://github.com/sailorsinbad14/hengji/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg)](https://github.com/sailorsinbad14/hengji/releases/latest)

开源、本地优先的**复式记账**应用。深入浅出：**底层复式严谨，表面只是「记一笔」**。

> 🎯 **专治个体户「一本糊涂账」**：一个支付宝既付货款又买菜，月底分不清生意到底赚没赚？衡记用「**多账本 + 真实账户全局共享**」把生意账和生活账分开统计，又不用把同一个钱包记两遍。

![衡记总览](docs/img/overview.png)

## ⬇️ 下载

**[下载最新版（Windows）](https://github.com/sailorsinbad14/hengji/releases/latest)** — 双击 `Hengji_0.5.1_x64-setup.exe` 安装即用，无需任何开发环境，**数据 100% 存本机、不联网**。

> 当前 v0.5.1，仅 Windows x64、未数字签名。首次运行若 SmartScreen 提示「未知发布者」，点「**更多信息 → 仍要运行**」即可。想体验或参与开发，见 [开发者手册](docs/development.md)。

## 🚀 3 分钟上手

**1. 新建账本** — 侧栏「＋ 新建账本」，起个名、选「个人」或「生意」，点创建。

![新建账本](docs/img/new-book.png)

**2. 记一笔** — 在「总览」页的「记一笔」卡，选 支出 / 收入 / 转账，填金额、选账户和分类，点保存。背后自动生成平衡的复式分录，你不用懂借贷。

![记一笔](docs/img/quick-entry.png)

**3. 分清生意账 / 生活账** — 再建一个「生意」账本。你的支付宝既管生活又管生意？到「账户」页把它设成「**全局共享**」——两个账本共用同一个余额，但生意流水和生活开支各算各的、互不污染。

![分账](docs/img/separation.png)

**4. 看财务总表** — 侧栏「🧮 财务总表」一眼看全部身家：**全局资金 + 各账本经营净额**，点开任一账本看细节。

![财务总表](docs/img/overview.png)

更细的用法见 **[使用手册](docs/README.md)**。

## ✨ 特点

- **分清生意账 / 生活账**：个人 / 生意 / 投资多账本，真实资金账户可全局共享，虚拟经营科目各账本独立。
- **极简模式（默认）**：普通用户只见 总览 / 流水 / 预算 / 账户；专业功能在「设置 → 开启商家进阶功能」后才出现，绝不一上来就劝退。
- **复式内核，单式体验**：借贷恒平衡、金额用整数分无浮点误差；你只管「记一笔」，分录自动生成。
- **周期记账**：工资、房租、分期这类每月固定的收支，设一次规则，到期自动出现在总览「待确认」卡片——一键确认入账（金额仍可改）或跳过本次，绝不替你静默记账。
- **商家进阶功能**（一键开启）：进销存（[商品库存](docs/inventory.md) / [采购](docs/purchases.md)）、[订单与应收](docs/orders.md)、[额外费用与公式引擎](docs/fees.md)、[月度对账](docs/reconciliation.md)、[多币种](docs/multi-currency.md)、[记账口径切换](docs/settings.md)。
- **账单导入 + AI 记账**：支付宝 / 微信账单一键导入，转账截图本地 OCR 识别（不上云）；说一句话语音成账（本地转写）；可选自带 AI Key 自动认列——**算账永远走确定性引擎**，复核台逐笔把关、整批可撤销。
- **本地加密（安全芯片）**：给账本设密码后，数据用随机密钥真加密、密钥由电脑 TPM 芯片封存——数据库文件拷到别的电脑也解不开。
- **本地优先 + 隐私**：数据存在你设备上的 SQLite，不联网、不上传。（未来可选的付费云同步是端到端加密的独立功能。）

## 🧭 适合谁

摆摊、小餐馆、小网店、社区团购……请不起会计、用不起专业软件，但生意账和生活账混在一起、月底算不清的个体户和小老板。

## 📚 文档

- [使用手册（docs/）](docs/README.md) — 按功能分篇，普通用户与进阶用户都能查。
- [架构与关键决策（ARCHITECTURE.md）](ARCHITECTURE.md) — 设计取舍与分层。
- [贡献指南（CONTRIBUTING.md）](CONTRIBUTING.md) — 含 DCO 签名说明。
- [开发者手册（docs/development.md）](docs/development.md) — 从源码构建、跑测试、打桌面安装包。

## 🛠️ 技术栈

pnpm monorepo · 纯 TS 复式引擎（`packages/core`）· `Repository` 持久层（内存 / SQLite / Tauri，`packages/store`）· Vite + React 19（`apps/web`）· Tauri 2 桌面壳（`apps/desktop`）。

## 📄 许可证

[Apache-2.0](LICENSE)。架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)。
