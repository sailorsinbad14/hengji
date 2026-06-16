# 衡记 · 软路实现计划（本地未提交草稿）

> 配套 `encryption.md`（设计 v4）+ `spike-results.md`（四项 Spike 实测）。Spike 已定案＝**软路**。
> 本文是实现契约，按用户工作流「**每步：实现 → code review 修 bug → 提交** 再下一步」推进。
> 推送纪律：安全功能（v3）全部做完前**只本地 commit、绝不 push**。

## 0. 目标 / 范围 / 不做

**目标**：opt-in 本地加密。随机 256-bit DEK 真加密 SQLCipher 库；DEK 由 NCrypt PCP 非导出 TPM 密钥 + 口令封装（芯片强制口令 + DA 限速，Spike #2 已证）。错 N 次销毁＝**软路**（app 自管计数 → `NCryptDeleteKey`），诚实标注其局限。

**范围**：仅 Windows 桌面（Tauri）。浏览器演示版（InMemory）、node:sqlite 测试实现**不涉及加密**。core / 业务逻辑 / SQL 形状**不动**。

**不做（本期）**：硬路（Spike 定 NO-GO）、端到端云同步（后置留接口）、Mac/Linux 加密、恢复码/后门（用户拍板「真硬、忘密=没了」）。

## 1. 现状（grounding，已读代码核实）

- **契约** `packages/store/src/types.ts`：`Repository` 接口 ~50 个 async 方法；3 实现：`memory.ts`（浏览器/测试）、`sqlite.ts`（`node:sqlite`，`?` 占位，真事务）、`tauri.ts`（`@tauri-apps/plugin-sql`，`$N` 占位，顺序 autocommit）。
- **`tauri.ts` 只用两个原语**：`db.select<Row[]>(sql, params)`（返回 `{列名:值}[]`）和 `db.execute(sql, params)`（**返回值从不读**）；外加 `Database.load(path)` / `db.close()`。占位符 `$1..$N`。迁移走 `migrate({run,getVersion,setVersion})`（`migrations.ts`，已到 **M16**，`PRAGMA user_version` 版本化）。
- **桌面 bootstrap 单一入口** `apps/web/src/db.ts:43` `bootstrapDesktop()` → `TauriSqlRepository.load('sqlite:heng.db')`（`isDesktop` 探测 `__TAURI_INTERNALS__`，否则 `InMemoryRepository`）。**解锁门就插在这里**。
- **Rust 侧** `apps/desktop/src-tauri/src/lib.rs`：仅 `.plugin(tauri_plugin_sql::Builder::default().build())`。`capabilities/default.json` 授 `sql:default/allow-load/execute/select/close`。`Cargo.toml` 有 `tauri-plugin-sql = { version="2", features=["sqlite"] }`。
- **关键洞察**：换桥＝把 `@tauri-apps/plugin-sql`（JS `Database` + Rust 插件）换成**自写 rusqlite+SQLCipher 桥**（Rust `#[tauri::command]` + 一个 `Database` 形状的 JS adapter）。**`tauri.ts` 的 SQL 全部不变**，只换它怎么拿到 `db`。

## 2. 总体策略：先换桥（明文）后加密，每阶段独立可验收可提交

最大的机械改动（换 store 桥）与加密**解耦**：先把 tauri-plugin-sql 换成 rusqlite 桥、**仍开明文库**，证明所有现有流程不回归；再「用同一把桥、开库时带 PRAGMA key」加上加密。这样回归风险集中在一个纯基建阶段、与 crypto 隔离。

---

## 阶段 0 · Spike 收尾探针（小，先除未知）

动手大改前补两个 Spike 研究点名的探针（都在 `D:\hengji-spike` 仓库外做）：
1. **`PCP_CHANGEPASSWORD` — 已验，结论：不用它**。实测在现有密钥上「set USAGEAUTH(旧) → set PCP_CHANGEPASSWORD(新摘要)」返回 `0x80090027 NTE_INVALID_PARAMETER`（格式未文档化，要继续试错且有 DA 成本）。**改密改用 §6 已规定的「重封 under 新密钥」原子协议**：create 新密钥(新口令) → wrap 同一 DEK → 用新密钥解出校验 → 删旧密钥。这条全由 Spike #2 已验原语组成（create/wrap/跨进程 unwrap/delete 全 PASS），更稳更原子。**教训**：探针里 unwrap-with-new 没 gate 在 changepw 成功上 → 多吃了 1 次 DA（现 2/32，未锁）。
2. **真 SQLCipher 库的开句柄/WAL sidecar 处理 — 已验 PASS**。实测：连接开着换文件 → `PermissionDenied / os error 5 (ACCESS_DENIED)`（证实**迁移必须先关所有连接**）；关连接 + 清 `-wal/-shm` 后，同卷原子 rename 成功、重开读到 `migrated` 内容。→ **§9 迁移纪律确证**：关连接 → `wal_checkpoint(TRUNCATE)` → 清 `-wal/-shm`（残留 sidecar 会损坏新库）→ 同卷原子 rename；`os error 5` 视为可重试（AV/索引器持锁时）。

**阶段 0 验收：完成 ✅**（probe1 → 改密走重封；probe2 → 迁移纪律确证）。下一步＝阶段 1。

---

## 阶段 1 · rusqlite+SQLCipher 桥（明文，纯基建，可单独提交）

把 tauri-plugin-sql 整体替换为自写桥，**先不加密**（开库不带 key），行为与现状一致。

**Rust（`apps/desktop/src-tauri/`）**：
- `Cargo.toml`：删 `tauri-plugin-sql`；加 `rusqlite = { features=["bundled-sqlcipher-vendored-openssl"] }` + `serde_json`。**构建前提：Strawberry Perl + vcvars，无需 nasm**（Spike #1 已证；写进 README/CI）。
- 新 `src/db.rs`：`Mutex<Connection>`（**单连接**，顺带修掉连接池下放弃事务的老债）。命令：
  - `db_open(path, key: Option<String>)`：若有 key 先 `PRAGMA key`（**必须开库第一条**），再 `journal_mode=WAL`/`foreign_keys=ON`/`busy_timeout`，再交给 JS 跑迁移。
  - `db_select(sql, params) -> Vec<serde_json::Map>`：`$1..$N → ?1..?N` 翻译；按 **column_name** 映射 `{列名:值}`（INTEGER/REAL/TEXT/NULL 对齐 tauri-plugin-sql 形状，让 `schema.ts` 的 `toX` 零改）。
  - `db_execute(sql, params)`：返回可忽略（现有代码不读返回值）。
  - `db_batch(stmts: [{sql, params}])`：单连接 BEGIN/COMMIT 一把事务（给多写方法用）。
  - `db_close()`。
- `lib.rs`：去 `tauri_plugin_sql`，`invoke_handler![db_open, db_select, db_execute, db_batch, db_close]`。
- `capabilities/default.json`：去 `sql:*`，加这些命令的权限。

**JS（`packages/store/`）**：
- 新 `tauri-bridge.ts`：`Database` 形状的薄 adapter（`.select`/`.execute`/`.batch`/`.close` → `invoke(...)`）。
- `tauri.ts`：仅把 `import Database from '@tauri-apps/plugin-sql'` + `Database.load` 换成新 adapter；**所有 SQL 方法不动**。多写方法（`addTransaction`/`updateTransaction`/`addOrder`/`addPurchase`/`updatePurchase`/`setPostingsCleared`）改走 `db_batch` 恢复原子性（去掉「顺序 autocommit 非原子」老债注释）。

**Rust 测试**：`$N→?N` 翻译、column_name→JSON（含 NULL/INTEGER bool/REAL）、事务回滚。**JS 契约测试不变**（仍跑 memory/node:sqlite）；桥靠「同 SQL 形状 + 新增 Rust 测 + 桌面实测」背书。

**验收**：桌面 app 起得来；现有全流程（多账本/流水/订单/采购/库存/对账/设置）无回归；`heng.db` 仍明文 SQLite（旧库无缝打开，因同文件格式）；多写崩溃中断不再留半截交易。**风险**：高（最大机械改动）——故独立成阶段、先行验收。

> **拆 1a/1b 推进**：
> - **1a（行为保持的换桥，进行中）**：已写 Rust `db.rs`（单连接 + `db_open/select/execute/batch/close`、`$N→?N`、列名→JSON、含 2 个单测）；`Cargo.toml`（删 tauri-plugin-sql、加 rusqlite bundled-sqlcipher-vendored-openssl）；`lib.rs`（注册命令 + manage(Db)）；`capabilities/default.json`（去 `sql:*` 留 `core:default`）；JS `tauri-bridge.ts`（`TauriDb` adapter，params 用 `unknown[]` 对齐旧 Database）；`tauri.ts`（换 import/字段类型/load()，**方法仍顺序 execute＝行为同旧**）；store dep 换 `@tauri-apps/api`。path 解析到 `app_config_dir()/heng.db`＝`%APPDATA%\com.hengji.dev\heng.db`（**保留既有数据**）。**已验**：`@app/store` typecheck 绿、`@app/web` build 绿（tauri chunk 正常 bundle）。**待**：`cargo test`（编 SQLCipher + db 单测）通过 → 桌面冒烟实测无回归。构建须 vcvars + Strawberry Perl（`D:\hengji-spike\build-tauri.bat`）。
> - **1b（恢复多写原子性，代码已写完）**：`insertPostings/insertOrderLines/insertPurchaseLines` 改为返回 `Stmt[]`（`postingStmts/orderLineStmts/purchaseLineStmts`）；`addTransaction/updateTransaction/addOrder/addPurchase/updatePurchase/setPostingsCleared` 改走 `db.batch([...])`；旧「连接池放弃事务」注释已更新；Rust 加 `run_batch` + `batch_is_atomic` 单测（commit + 回滚）。**已验**：`@app/store` typecheck 绿；`cargo test` 跑中。
> - **节奏（用户拍板）**：节奏-2＝1a+1b 一起做、整阶段只冒烟一次；冒烟-A＝用户手动 `pnpm --filter @app/desktop dev` 看数据。**cargo test 通过后 → 交用户冒烟 → 通过则 commit 整个阶段 1（本地）**。
> - **验收（2026-06-15）**：✅ 桌面冒烟通过（原生窗口起来、既有数据在、记账无回归）。注意 `tauri dev` 用 `--no-default-features`、与 `cargo test` 缓存键不同 → 首次会再编一次 OpenSSL（~8min，一次性）。
> - **Code review（多智能体对抗式）：must-fix = 0，安全提交**。类型/行为与 plugin-sql 一致、`db.batch` 原子性比旧版更强。**已修**：4 处过时 tauri-plugin-sql 文档/注释（ARCHITECTURE.md / docs(/en)/development.md / types.ts）。**Phase-2 硬化 backlog（不阻塞、当前不触发）**：① `db_execute` 参数化分支只跑首句（现所有参数化调用皆单句、多写走 batch；可加注释或拒绝内嵌 `;`）；② 同步 `db_*` 命令在 UI 线程跑，大 batch / 首启迁移可能卡 webview（重命令改 `async`/`spawn_blocking`）。

---

## 阶段 2 · Rust crypto 模块（NCrypt PCP）+ 加密开库

**Rust `src/crypto.rs`**（基于 Spike #2 已验证代码）：
- `gen_dek() -> [u8;32]`（BCryptGenRandom）。
- `create_wrap_key(password)`：MS Platform Crypto Provider，非导出 per-user RSA-2048，`PCP_USAGEAUTH=SHA256(UTF-16LE pw)`。
- `wrap_dek(dek)` / `unwrap_dek(password) -> Result<dek, FailClass>`（OAEP-SHA256；解封前在 reopened handle 上 set USAGEAUTH + SILENT）。
- `change_password(old,new)`＝**重封 under 新密钥**（阶段 0 定：PCP_CHANGEPASSWORD 不可用）：create 新密钥(新口令) → wrap 同一 DEK 出 `heng.dek.tpm.new` → 验证可解 → 原子顶替 → 删旧密钥（§6 两阶段原子协议、启动认旧/新两封装文件）；`delete_wrap_key()`。
- **三类失败分流**：解锁前先 ping TPM 健康；`NTE_PERM`/`TPM_20_E_LOCKOUT`→口令错/锁定；封装文件坏→数据损坏；TBS/句柄异常→芯片暂不可用（**不计销毁**）。
- 封装产物（wrapped DEK + 元数据：版本/算法/创建时间）存 heng.db 同目录的 `heng.dek.tpm`。
- `db_open` 支持传 DEK hex 作 `PRAGMA key`。

**命令**：`security_status()`、`set_password(pw)`、`unlock(pw)`、`change_password(old,new)`、`remove_password(pw)`。

**验收**：crypto 单测（封/解、三类失败、改密、删钥匙）；对一个测试库加密→锁→解→错口令拒（受控、最多 1 DA strike）。**风险**：中（机制 Spike 已验，工程化为主）。

> **推进/验收（2026-06-16，分支 `feat/local-encryption`，本地未推）**：
> - **`crypto.rs` 引擎实装**：`gen_dek`（BCryptGenRandom）；slot **a/b ping-pong** 的 PCP create/wrap/unwrap（OAEP-SHA256、解封在 reopened handle 上设 USAGEAUTH+SILENT，照 Spike #2）；`change_password`＝重封 under 另一 slot 的两阶段原子（写 `heng.dek.tpm.new`+sync → 用新口令验证可解+==DEK → 原子 rename 顶替 → 删旧 slot）+ **`reconcile` 启动自愈**（`.new` 在＝改密未 commit → 回滚删 staging slot+`.new`；顺带清孤儿 slot；全 DA-free，绝不靠猜口令）；`remove_password`（验口令→删信封→删两 slot）；`delete_slot_key`（幂等、删失败分支手动释放 handle 防泄漏）；**三类失败分流** `WrongPassword`/`Corrupt`/`ChipUnavailable` + `Internal`（基建错），保留原始 HRESULT 供 UI 细化；**版本化 JSON 信封** `heng.dek.tpm`（version/scheme/alg/slot/created_unix/wrapped_dek_hex）；`security_status`（信封在否 + PCP 健康 ping）。DEK 全程 `Zeroizing`、口令摘要用后清零。
> - **`db.rs` 修正**：`db_open` 的 key 改用 SQLCipher **原始密钥** `PRAGMA key = "x'<64hex>'"`（原 `pragma_update` 会把 hex 当 passphrase 跑 PBKDF2——错）；raw-key 跳过 KDF、必为开库首条；抽 `config_dir`/`open_db` 共用 + `is_dek_hex` 校验防注入。
> - **命令 + 并发**：`lib.rs` 注册 5 命令 + `Crypto` state；**DEK 只存 Rust 侧、绝不跨 IPC 回传 JS**；5 命令全程持 `Crypto` 锁**串行化**——堵掉「并发改密/解锁互踩固定 slot + 单一信封 → commit 与另一路 reconcile 删 slot 撞车 = 库永久不可解」的高危隐患（review 高分项，当场修掉而非留 Phase 3）。
> - **边界（清晰标注，未越界）**：DB 明↔密迁移留 **Phase 4**（`set/remove_password` 仅建/拆封装、带 `// Phase 4` 标）；解锁屏/bootstrap 门留 **Phase 3**（命令在、暂无 UI 调用）；无芯片软件弱版后置。
> - **测试**：纯逻辑 always-run（UTF-16LE digest pin〔含空串/多码元/无尾 NUL〕、hex、envelope serde、classify、slot）+ `db` 的 **SQLCipher raw-key roundtrip**（真加密〔头非明文〕→重开读回→错 key fail-fast，**0 DA、自动跑**）。**TPM `#[ignore]` 4 个**（手动 `cargo test -- --ignored --test-threads=1`、固定 slot 须串行）：set→解→改→解→移除〔0 DA〕、加密测试库锁解读回〔0 DA〕、**改密 commit 前崩溃回滚自愈**〔0 DA〕、**错口令拒〔蓄意 1 DA strike〕**。
> - **构建**：`windows = 0.58`（target `cfg(windows)`）+ `sha2` + `zeroize`。`cargo test` 绿（**10 passed / 0 failed / 4 ignored**）；须 vcvars + Strawberry Perl（`D:\hengji-spike\build-tauri.bat`）。
> - **Code review（6 维对抗式 cloud workflow、每项独立证伪 + Phase 边界裁定）**：**must-fix = 0**；11 项 confirmed should-fix，已修 6 项高价值/低改动（handle 泄漏 / op-lock 并发 / 测试清场幂等 / digest pin 加强 / 回滚自愈测试 / 永久丢失分类注释）。
> - **Phase-3/4 backlog（deferred，已记）**：① `NTE_NOT_FOUND`/`NTE_BAD_KEYSET`（Clear TPM/换主板/拷他机＝钥匙**永久丢失**）现粗归 `ChipUnavailable`，Phase 3/4 应用保留的 raw code 细化为专门「永久销毁·终态屏」（§5，与「暂不可用·重启」彻底分开）；② `remove_password` 删信封后崩溃留**良性**孤儿 slot（OVERWRITE 下次 `set_password` 自愈）；③ 迁移/改密 kill-9 注入实测在 Phase 4（本期已加进程内回滚自愈测试）。
> - **状态**：✅ 编译过 + 单测绿 + SQLCipher 真加密重开证实。**TPM `#[ignore]` 集成测试待用户在本机手动跑确认**（含 1 DA strike 的错口令测试）。下一步＝**阶段 3**（解锁/设密码 UI + bootstrap 门 + 三态状态行）。

---

## 阶段 3 · 解锁/设密码 UI + bootstrap 门 + 三态状态

- `db.ts bootstrapDesktop`：先 `security_status()` → 已加密则**先渲染解锁屏**（repo ready 之前）→ 解出 DEK → `db_open(path, dek)`；未加密 → 开明文（同现状）。
- **解锁屏**：口令框；三类失败分屏（口令错[显剩余次数/已错次数]、数据损坏[可重试]、芯片不可用[请重启]）；开了销毁显「再错 N 次永久销毁、本机无法找回」。
- **设置「安全」卡**：三态状态行（`未加密` / `已加密·安全芯片(强)` / `已加密·纯软件(弱)`，区别色）+ 设/改/移除密码 + 「错N次销毁」开关（默认关、开前强制备份、强警告）+ 上次备份 N 天前 + 可选自动锁。**绝不静默降级**（强版换无芯片机模态告知）。
- 口令由用户在原生输入框输，助手不代填。

**验收**：真 app 里走通 opt-in 设密码 → 重启解锁 → 改密 → 移除全流程；三态状态行正确。**风险**：中。

> **范围决策（2026-06-16，用户拍板）**：本步骤验收要求的「设密码→重启解锁→改密→移除全流程」依赖明↔密库迁移（§9，原计划在阶段 4）。
> 因「解锁/设密码」端到端不可能脱离迁移成立（否则设密码后留下"明文库+信封"的损坏态，重启解锁→开密文库失败），**用户决定把 §9 迁移并入本步**。阶段 4 只剩：销毁(错 N 次)/备份导出/kill-9 注入测试硬化。
>
> **推进/验收（2026-06-16，分支 `feat/local-encryption`，本地未推）**：
> - **Rust**：① `crypto.rs` 加明↔密原子迁移引擎 `migrate_encrypt`/`migrate_decrypt`（`sqlcipher_export` + **补传 `PRAGMA user_version`**〔export 不复制它，丢了会重跑 M1..M16〕+ `integrity_check`+逐表行数校验 + 同卷 `rename_with_retry`〔Windows 刚关库的文件被 AV/索引器短暂持锁 → os error 5 退避重试，Spike#2 probe2 已预判〕）；② **迁移标记** `heng.migrate`（方向+信封）+ 扩展 `reconcile`：据**库文件头**(明文 `SQLite format 3\0` vs 密文)判定原子 rename 提交点哪一侧 → 前滚(提交信封)/回滚(删未提交信封+tmp+staging slot)，**DA-free、不靠猜口令**；③ `set_password`/`remove_password` 命令改为「持 Crypto+Db 两锁 → 关连接 → 迁移 → 重开」；④ `db_open` 改收 `encrypted: bool`、**从 Crypto state 取 DEK**（DEK 绝不跨 IPC 回传 JS）；⑤ 新增 `lock` 命令；⑥ `security_status` 先 `reconcile` 再报（启动门自愈）。**加锁序固定 Crypto→Db**。
> - **JS/store**：`tauri-bridge.ts`/`tauri.ts` 用 `encrypted` 布尔取代 JS 传 key；新 `@app/store/crypto`（securityStatus/setPassword/unlock/changePassword/removePassword/lock + 三类 FailClass 类型）。
> - **web**：`db.ts` 改 gate 化（`openDesktopRepoOnce`/`demoRepoOnce` 单例 + `resetDesktopRepo`）；`App.tsx` 启动门状态机(loading/locked/open) + 自动锁 effect（默认 15min，无操作锁→清 DEK+关库→回解锁屏）；新 `UnlockScreen`（三类失败分屏）；新 `SecurityCard`（三态状态行 + 设/改/移除 + 自动锁；销毁/备份占位标注下一步）；`Settings` 挂载（仅桌面）。`autoLockMinOf` 设置助手。
> - **测试**：新增**自动**用例（0-DA、无 TPM）`migration_roundtrip_preserves_data_and_user_version`（明→密→明，数据+user_version 全程保留、库头翻转）、`db_is_plaintext_detects_header`、`marker_serde_roundtrip`。**cargo test 13 passed / 4 ignored**(TPM 待手动)；store 55 契约绿；web tsc+vite build 绿。
> - **待**：多维对抗式 review 修 must-fix → 用户桌面冒烟（设密码→重启解锁→改密→移除）+ 手动跑 4 个 TPM `#[ignore]` → commit（本地，**不推**）。
> - **已知细节**：迁移后不再 reopen-fsync tmp（Windows 下刚写完的 .db 被 Defender 短暂独占 → `File::open` ACCESS_DENIED；改为依赖 SQLite 提交时的 fsync + rename 重试）。极端窗口（DB rename 已成、提交信封失败）→ 本会话无 DEK 重开，留待重启 reconcile 前滚 + 用户输口令解锁（已注释标注）。

---

## 阶段 4 · 迁移（§9）+ 销毁（§5）+ 备份

- **明文→密文迁移**（Rust 内原子，Spike #4 已验同卷 rename + FlushFileBuffers）：同目录写密文临时文件 → 校验可解+逐行一致 → 原子 rename 顶替 → 旧库改 `.bak` 确认后 unlink → **清 `-wal/-shm` 明文页**。**开句柄/WAL 处理**：先关所有 SQLCipher 连接、`wal_checkpoint(TRUNCATE)`、确认无他进程持锁，`ERROR_ACCESS_DENIED` 视为可重试（阶段 0 验过的纪律）。**启动自愈**：`.tmp` 残留/校验失败而明文仍在 → 回退明文重试，绝不进半截密文死局。移除密码＝反向同协议。
- **销毁（软路）**：app 自管失败计数（**原子写、成功解锁归零**）→ 到 N 次 `delete_wrap_key()`。**强闸门**：开销毁前**强制先成功备份一次**；销毁默认**先移密文到带时间戳隔离区再删**（后悔药、本期不可在不懂后果时关）；量化文案「永久且不可恢复删除全部账本、本机无任何找回」；连续快速失败节流。**销毁终态 sentinel**：下次启动优先识别，进「数据已按安全设置销毁」终态屏，与「数据可能损坏(可重试)」「芯片暂不可用(请重启)」三屏彻底分开。
- **备份导出**：明标「关闭加密的等价物、不受密码保护、移到离线介质」；状态行常驻「存在 1 份未加密备份于 <路径>」；默认不主动生成；新鲜度感知。

**验收（§12）**：改密/移除/迁移**任意时点 kill-9 仍可用旧或新态**（分别覆盖三路径）；错 N 次确实销毁；坏块/芯片不可用**不**误触销毁；磁盘扫描无意外明文窗口。**风险**：高（原子性 + 误删兜底是命门）。

---

## 阶段 5 · 文档 + 验收

- README/CI 构建前提（Strawberry Perl、无 nasm、vendored-openssl 走 vcvars）。
- `encryption.md` 威胁模型用户向诚实披露收口（§0/§1/§5/§10）。
- 全量验收 + 回归。

---

## 关键技术决策（已定）

- **先换桥后加密**：阶段 1 纯基建、明文、独立验收，再加密。
- **单连接 `Mutex<Connection>` + db_batch**：恢复多写原子性（修旧债，且 §9/§5 原子性依赖它）。
- **`$N→?N` 在 Rust 翻译**：`tauri.ts` SQL 零改。
- **column_name→JSON 对齐 tauri-plugin-sql 形状**：`schema.ts` `toX` 零改。
- **加密仅桌面**：node:sqlite 测试 + InMemory 演示不动，JS 契约测试不变。
- **§10 加密会话**：NCrypt 给不了（Spike 证），fTPM 残余风险低，接受、不上裸 TBS。

## 已定（用户 2026-06-15 拍板）

1. **销毁次数 N = 5**，**不加**额外「快速连续失败」节流。
2. **自动锁**：做，放设置里用户可开关 + 调时长，**默认 15 分钟**无操作自动锁。
3. **无芯片老机**：退纯软件弱版，但**先弹确认框**（告知较弱：拷文件理论可离线试破、不支持硬销毁），用户确认才开。**绝不静默降级**。
4. **阶段 1 一并恢复多写事务（db_batch）＝ 选 A**：单连接事务，修掉「崩溃留半截账」老债；阶段 4 迁移/销毁的原子性也依赖它。
5. **附件加密**：本期后置。

## 验收矩阵（§12 映射）

| 验收项 | 阶段 | 手段 |
| --- | --- | --- |
| 构建链编过 + 真加密 | 1/2 | Spike #1 已证；桌面实跑 |
| 桥无回归 | 1 | 全流程桌面实测 + Rust 单测 |
| 封/解 + 口令门 + 三类失败 | 2 | crypto 单测 + 受控实测 |
| opt-in 设/改/移除/解锁 | 3 | 真 app 实测 |
| 迁移/改密 kill-9 仍可用 | 4 | 注入中断实测三路径 |
| 错 N 销毁 + 坏块/芯片不误删 | 4 | 受控实测（DA 预算谨慎） |
| 无意外明文窗口 | 4 | 磁盘扫描 |
