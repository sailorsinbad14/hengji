# Héng (衡记)

[中文](README.md) · **English**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/sailorsinbad14/hengji)](https://github.com/sailorsinbad14/hengji/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg)](https://github.com/sailorsinbad14/hengji/releases/latest)

Open-source, local-first **double-entry accounting**. Rigorous double-entry underneath, a simple **"log an entry"** on the surface.

> 🎯 **Built for solo merchants drowning in one messy ledger.** One wallet pays both for inventory and groceries, and at month-end you can't tell whether the business actually made money? Héng uses **multiple books + globally-shared real accounts** to keep business and personal money separate — without recording the same wallet twice.

![Héng overview](docs/img/overview.png)

## ⬇️ Download

**[Download the latest release (Windows)](https://github.com/sailorsinbad14/hengji/releases/latest)** — double-click `Hengji_0.5.0_x64-setup.exe`, install, and go. No dev environment required; **your data lives 100% on your machine, never uploaded**.

> Current version v0.5.0, Windows x64 only, unsigned. On the SmartScreen "unknown publisher" prompt, choose **"More info → Run anyway"**. To build from source or contribute, see the [Developer guide](docs/en/development.md).

## 🚀 Get started in 3 minutes

**1. Create a book** — In the sidebar, click "＋ New book", name it, pick "Personal" or "Business", and create.

![New book](docs/img/new-book.png)

**2. Log an entry** — On the Overview page, use the "Log an entry" card: choose Expense / Income / Transfer, enter the amount, pick an account and a category, and save. A balanced double-entry record is generated automatically — you never have to think in debits and credits.

![Log an entry](docs/img/quick-entry.png)

**3. Separate business from personal** — Create a second "Business" book. Your Alipay handles both life and business? On the Accounts page, mark it **"globally shared"** — both books use the same balance, while business flows and personal spending are tallied separately and never pollute each other.

![Separation](docs/img/separation.png)

**4. See the global overview** — The sidebar's "🧮 Global overview" shows your whole net worth at a glance: **shared funds + each book's operating net** — drill into any book for detail.

![Global overview](docs/img/overview.png)

For deeper usage, see the **[User manual](docs/en/README.md)**.

## ✨ Highlights

- **Separate business from personal money**: personal / business / investment books; real cash accounts can be globally shared while virtual operating accounts stay per-book.
- **Minimal mode (default)**: regular users only see Overview / Transactions / Budgets / Accounts; pro features stay hidden until you enable them under "Settings → Enable merchant pro features" — no upfront overwhelm.
- **Double-entry core, single-entry feel**: always balanced, integer-cent amounts with no float errors; you just "log an entry" and the postings are generated for you.
- **Recurring entries**: for monthly-fixed items like salary, rent, or installments — set a rule once and it surfaces as a "pending" card on Overview when due; confirm with one click (amount still editable) or skip this cycle. Never posts silently on your behalf.
- **Merchant pro features** (one toggle): inventory ([products & stock](docs/en/inventory.md) / [purchasing](docs/en/purchases.md)), [orders & A/R](docs/en/orders.md), [extra fees & formula engine](docs/en/fees.md), [monthly reconciliation](docs/en/reconciliation.md), [multi-currency](docs/en/multi-currency.md), [accounting basis](docs/en/settings.md).
- **Bill import + AI entry**: one-click import of Alipay / WeChat statements, on-device OCR for payment screenshots (nothing uploaded); speak an entry into the books (local transcription); optionally bring your own AI key for auto-categorization — **the books are always computed by the deterministic engine**, with a review desk for line-by-line approval and whole-batch undo.
- **Local encryption (security chip)**: set a password and your data is encrypted with a random key sealed by your PC's TPM chip — the database file is useless if copied to another machine.
- **Local-first & private**: data lives in a local SQLite file on your device — no network, no upload. (A future optional paid cloud sync is a separate, end-to-end-encrypted feature.)

## 🧭 Who it's for

Street stalls, small restaurants, tiny online shops, community group-buying — solo merchants and small owners who can't afford an accountant or pro software, yet keep business and personal money tangled in one place.

## 📚 Documentation

- [User manual (docs/)](docs/en/README.md) — organized by feature, for both regular and advanced users.
- [Architecture & key decisions (ARCHITECTURE.md)](ARCHITECTURE.md) — design trade-offs and layering (Chinese).
- [Contributing (CONTRIBUTING.md)](CONTRIBUTING.md) — including DCO sign-off.
- [Developer guide (docs/en/development.md)](docs/en/development.md) — build from source, run tests, package the desktop installer.

## 🛠️ Tech stack

pnpm monorepo · pure-TS double-entry engine (`packages/core`) · `Repository` persistence (in-memory / SQLite / Tauri, `packages/store`) · Vite + React 19 (`apps/web`) · Tauri 2 desktop shell (`apps/desktop`).

## 📄 License

[Apache-2.0](LICENSE). See [ARCHITECTURE.md](ARCHITECTURE.md) for design and [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
