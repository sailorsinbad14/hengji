# 衡记 · 加密 Spike 实测结果（活文档，本地未提交）

> 配套 `encryption.md` §12。状态：**进行中**。这是经验性证伪记录——能在本机跑通才算 PASS，不靠文献。
> 决策目标：四项子任务结论 → 定**硬路 / 软路** → 再实现。
> 推送纪律：与 `encryption.md` 同，安全功能（v3）全部做完前**只本地、不 push**。

## 环境基线（2026-06-15 实测）

| 项 | 结果 |
| --- | --- |
| Rust | 1.96.0，`stable-x86_64-pc-windows-msvc` |
| MSVC | VS2022 BuildTools + VC.Tools.x86.x64（`...\2022\BuildTools`，需 vcvars 环境） |
| perl | **仅** Git for Windows 自带 msys2 perl（`C:\Program Files\Git\usr\bin\perl.exe`）；无 Strawberry/ActivePerl |
| nasm | ❌ 未装（winget 可装；choco 无） |
| TPM | **Intel PTT = 固件 TPM(fTPM)**（PnP `ACPI\INTC7001`，制造商 (Standard)）。**非独立芯片(dTPM)** |
| 当前 shell | **非管理员**（Get-Tpm / Win32_Tpm / BitLocker 查询均 Access Denied） |
| 卷 | C:（`%APPDATA%`，运行期 heng.db 所在）NTFS 194GB 空闲；D:（仓库）NTFS 332GB 空闲 |

**fTPM 的影响**：CPU↔芯片**无外部总线可嗅探**（§10 总线嗅探担忧对 fTPM 基本不适用——会话加密仍是 best practice 但威胁面更小）；但 fTPM 暴露于 faulTPM(电压注入)/TPM-Fail(时序) 等公开攻击面（§1 诚实边界**仍成立**）。

scratch 工作区：`D:\hengji-spike\`（仓库外，不污染 git）。

---

## 子任务 #4 · 原子替换 — ✅ PASS（已实测）

`D:\hengji-spike\spike4-atomic`，纯 std、无依赖。实测结论：

- **同卷 `std::fs::rename` 原子顶替已存在文件**：成功，rename 后目标内容＝新内容。✅
- **跨卷 rename 干净报错**：`ErrorKind::CrossesDevices`，OS error **17**（`ERROR_NOT_SAME_DEVICE`）。✅
  → **迁移必须把临时文件放在与 `heng.db` 同一目录/同卷**（§9 协议本就如此）。跨卷会 error 而非静默半态。
- **持久化原语**：Windows 无 POSIX 目录 fsync；正确做法＝rename 前对数据文件 `File::sync_all()`（= `FlushFileBuffers`），NTFS 自身 journal rename 元数据，无需也无法单独 fsync 目录。

**对 §9 的影响**：协议成立。`std::fs::rename`（同卷）即可替代 `ReplaceFileW`；若要保留 ACL/属性，`ReplaceFileW` 可作增强（待 #2 研究确认是否必要）。`tauri-plugin-fs` 确实不需要——Rust std 够用。

---

## 子任务 #1 · 构建链（SQLCipher in Rust） — ✅ PASS（已实测，含真加密验证）

**结果（7m50s 编过 OpenSSL 3.6.3 + SQLCipher，产物真加密）**：
- `cipher_version = "4.5.7 community"`（SQLCipher 已链，非裸 SQLite）✅
- 落盘前 16 字节随机（`71 ac 4f 70 …`），**不是** `SQLite format 3\0` ✅
- 明文标记串**不可见** ✅；错 key 打不开 ✅；对 key 读回 `secret-marker-12345` ✅

下面是发现该结论前定位的两个真坑（保留作实现期构建说明）：

`D:\hengji-spike\spike1-sqlcipher`：`rusqlite 0.32.1` + `bundled-sqlcipher-vendored-openssl`（拉到 `openssl-src v300.6.1+3.6.3`、`openssl-sys 0.9.117`、`libsqlite3-sys 0.30.1`）。

经验性发现了**两个真实构建坑**（设计稿 §4 预判“OpenSSL/Perl 最可能翻车”，方向对、细节修正）：

**坑 1 — msys perl 与 MSVC link.exe 的 PATH 冲突（已解）**：
- 为拿 perl 把 `C:\Program Files\Git\usr\bin` **前置**到 PATH → msys2 coreutils 的 `link.exe` 盖过 MSVC `link.exe`，rustc 链接 build script 调到 GNU `link`（`/usr/bin/link: extra operand`）。
- **修法**：把 perl 目录**追加**到 PATH 末尾（MSVC link/cl/nmake 优先）。← Windows MSVC + 任何 msys 工具共存的通用坑，写进构建说明。

**坑 2（真正的拦路虎）— Git 的 msys perl 缺 OpenSSL 必需的 CPAN 核心模块（已解）**：
- OpenSSL `Configure` 失败：`Can't locate Locale/Maketext/Simple.pm`，级联 `Params::Check`→`IPC::Cmd`→OpenSSL `config.pm`。Git 自带的是**精简版 msys2 perl**，不含这些核心模块。
- **nasm 不需要**：openssl-src 自动用 `no-asm` 配置（Configure 参数里就有 `no-asm`）。预判的 nasm 坑**不存在**。
- **修法（正确且可复现的构建前提）**：装 **Strawberry Perl**（完整 Windows perl，含全部核心模块）。本机已 `winget install StrawberryPerl.StrawberryPerl` 装好 `v5.42.2`，三个缺失模块齐全。构建脚本改用 `C:\Strawberry\perl\bin` 的 perl。
- ← **这是实现期必写进 README/CI 的构建前提**：Windows 上构建 vendored-openssl 需要 Strawberry Perl（不是 Git 的 msys perl），不需要 nasm。

正在用 Strawberry perl 重跑（后台，会真正编译 OpenSSL 3.6.3 + SQLCipher，约十几分钟）。

falsification 判据（待这次跑完）：`cargo build` 通过 **且** 产物 `PRAGMA cipher_version` 非空 **且** 落盘文件头不是明文 `SQLite format 3\0` **且** 明文标记串不可见 **且** 错 key 打不开、对 key 能读回。

---

## 子任务 #2 · NCrypt PCP 芯片封装 — ✅ PASS（已实测，含口令门确证）

`D:\hengji-spike\spike2-pcp`（`windows` 0.58 + `sha2`）。用 **MS Platform Crypto Provider** 建**非导出**per-user RSA-2048 密钥，`PCP_USAGEAUTH` = SHA-256(UTF-16LE 口令) 作 TPM 用法授权，OAEP-SHA256 封装随机 256-bit DEK。结果：

- **跨进程解封成功**：`create` 进程封的 DEK 与**另一个** `unwrap` 进程用对口令解出的 DEK **逐字节相同** ✅
- **口令门是真的（解掉研究最大隐忧"静默失守"）**：故意输**错**口令 → `NCryptDecrypt` 被芯片**拒绝**，返回 `0x80090010 NTE_PERM`。**不是**"错口令也能解出"的静默失守 ✅
- **错口令确实计入全局 DA**：错一次后 `lockoutCounter` 从 0 → **1**（`maxAuthFail=32`、未锁）。→ **封装密钥受 DA 保护＝芯片对口令猜测限速**，正是 §1"拷文件也无法离线爆破"所依赖的那一档（拿到封装文件的对手只有约 32 次机会、本机每 2h 才回血 1 次）✅
- **全程非管理员**（per-user 密钥，省略 `NCRYPT_MACHINE_KEY_FLAG`）✅；`NCryptDeleteKey` 干净删除 ✅
- 代价：恰好 1 次 DA strike（共 32），自愈。

**对设计的反馈（§10）**：研究 + 实测确认——**NCrypt/PCP 无法让调用方配置"加盐/绑定的加密+HMAC TPM 会话"**（只有裸 TBS/`TPM2_StartAuthSession` 能）。本机是 **fTPM 无外部总线**，残余嗅探风险低；§10 那条"必启加密 TPM 会话"经 NCrypt **不可满足**，应改为"fTPM 上接受残余风险 / 若必须则改裸 TBS 封装密钥（大工程）"。口令轮换走 `PCP_CHANGEPASSWORD`（待后续探针）。

---

## 子任务 #3 · 硬路（NV 单调计数器 + PolicyNV） — ⚠️ 只读探针出意外：研究的 NO-GO 前提被本机证伪

**研究（已对抗式验证、引一手资料）结论＝硬路在 stock Windows 上 NO-GO**，理由：`TPM2_NV_DefineSpace` 只接受 owner / platform 层级授权；Windows 1607+ 把 owner auth 设成随机值后**丢弃**（OSManagedAuthLevel=5 只留 lockoutAuth），平台层级归固件/OS，app 拿不到 → 定义不了计数器 → 退软路。

**但本机只读探针（`spike3-tpmcap`，TBS + 原始 `TPM2_GetCapability`，零改动、非管理员可跑）打脸了那个前提**：

- TBS 非管理员即可通话 ✅
- **`TPMA_PERMANENT = 0x00000004`**：
  - **`ownerAuthSet = false`** ← **关键**。owner 授权是**空口令**，不是"被设成随机值丢弃"。空口令任何人都能用空 session 出示 → **`TPM2_NV_DefineSpace` 在本机的 owner 授权前提可能成立**。
  - `lockoutAuthSet = true`（Windows 确实留着 lockoutAuth；DA 锁定无法被 app 复位 → 这条研究对）
  - `inLockout = false`（当前未锁）
- **DA 参数（与 BitLocker/Hello 共享）**：`maxAuthFail=32`（错 32 次锁）、`lockoutInterval=7200s`（**每 2 小时**才宽恕 1 次，比研究假设的"每 10 分钟"更苛刻）、`lockoutRecovery=86400s`（锁后等 24h）。→ **错误尝试在本机更珍贵**，软路计数/节流与"最多 1 次取证"纪律更要守。
- 已存在 21 个 NV index（BitLocker/厂商等），新定义一个不会撞号。

**含义（诚实）**：硬路在本机**未必是 NO-GO**——拦路的"owner auth 拿不到"在这台机器上不成立（owner auth 是空）。**剩下唯一未决问题**：Windows TBS 是否允许（可能要管理员的）app 真的 `TPM2_NV_DefineSpace`（空 owner 授权）。这要 **mutating Probe B**（定义 NV index = 持久 TPM 状态、大概率需管理员、研究的 Probe B 常量有坑：`TPM_SE_TRIAL` 应=0x03、`TPM_EO_UNSIGNED_LT` 应=0x0005）才能拍死。

**产品层面的取舍（关键）**：即便本机硬路能做出，**跨用户机器不可靠**——别的机器 owner auth 可能非空、NV 定义大概率要管理员（消费级 app 不宜要求提权）、NV 空间受 Windows 管、Clear TPM 仍能无密码删库。所以硬路最多是"**部分机器上的尽力增强**"，给不了"iPhone 式确定性、人人有"。→ **倾向：产品仍走软路；空-owner-auth 这个发现记下来，硬路留作未来"能力达标的机器上的可选增强"**。是否现在做 mutating Probe B 拍死 = 待用户拍板（见下 gate）。

**实测（用户选「非提权先试」）→ 非提权 NV 定义被 Windows 拦截**：`spike3-tpmcap define` 发 `TPM2_NV_DefineSpace`（owner 层级、空口令 session）→ 返回 **`0x80280400 = "The command was blocked." (TPM_E_COMMAND_BLOCKED)`**。注意：这是 **Windows TBS 命令过滤器**直接拦掉了该命令（不是 owner auth 不对——owner auth 是空、本可出示；TBS 在更上层就 block 了）。
- **结论（本机、非提权）**：**非提权消费级 app 根本发不出 NV_DefineSpace** → 硬路对"不要求管理员的 opt-in 功能"**不可行**。这个 block 与 owner-auth 是否为空**无关**。
- 未测：提权后 TBS 是否放行（用户选了非提权先试、没走 elevated Probe B）。即便提权能行，产品上也不该要求消费者装管理员助手 + 跨机假设 owner-auth 为空 + 调 TBS 命令过滤 → **硬路不作为出货机制**。
- **硬路最终判定：本期 NO-GO，退软路**（正是用户预授权的「做不出退软路并诚实标注」分支）。空-owner-auth 的发现记档，留作未来"能力达标机器上的可选增强（需提权助手）"。

---

## 总结论（四项全部实测）

| 子任务 | 判定 | 一句话 |
| --- | --- | --- |
| #1 SQLCipher 构建 | ✅ PASS | Strawberry Perl（非 Git msys perl）、无需 nasm；产物真加密（cipher 4.5.7） |
| #2 NCrypt 芯片封装 | ✅ PASS | 非提权封/解 DEK 跨进程一致；**口令门由芯片真强制**（错口令 NTE_PERM + 计 1 次 DA）；DA 限速＝离线爆破护城河成立 |
| #3 硬路（NV+PolicyNV） | ❌ NO-GO（本期） | 非提权 `NV_DefineSpace` 被 TBS `COMMAND_BLOCKED`；退软路（用户预授权分支） |
| #4 原子替换 | ✅ PASS | 同卷 rename 原子顶替；跨卷干净报错；FlushFileBuffers 持久化 |

**架构定案＝软路（强核心）**：
- **真加密**：SQLCipher 随机 256-bit DEK（#1 证实可构建+真加密）。
- **DEK 封装**：NCrypt PCP 非导出 per-user TPM 密钥 + 口令作 `PCP_USAGEAUTH`（#2 证实芯片强制口令 + DA 限速 + 非提权 + 可删）。→ **拷文件无法离线爆破**这一核心档**成立**。
- **错 N 次销毁＝软路**：app 自管失败计数 → `NCryptDeleteKey` 删封装密钥（#3 证实硬路对非提权 app 不可行）。**诚实标注**：对手在第 N 次前拔电/杀进程/拷封装文件可躲过那一次销毁（§5 已写）。
- **迁移/改密原子**：Rust 同卷 `std::fs::rename` + FlushFileBuffers（#4 证实）。
- **§10 修正**：fTPM 本机无总线可嗅探；NCrypt 给不了调用方控制的加密会话——§10 那条降级为"fTPM 上接受残余风险"。

**实现期构建前提（写进 README/CI）**：Windows 需 **Strawberry Perl**（不是 Git 的 msys perl），**不需要 nasm**；vendored-openssl 走 vcvars。

**给 encryption.md 的回写**：§11 Q1（硬路是否可行）＝**NO-GO**，§5 主线＝软路，§0/§1 措辞已诚实（无需改）；§10 加密会话要求按上面降级；§4 构建前提补 Strawberry Perl。

## 剩余 / 后续
- 实现前可选追加探针：`PCP_CHANGEPASSWORD` 改密、迁移在真 SQLCipher 库上的开句柄/WAL sidecar 处理（#4 研究提示的生产风险）。
- 若将来想要硬路：仅在"能力达标 + 提权助手"的机器上做可选增强（elevated Probe B 未跑）。
- scratch 在 `D:\hengji-spike\`（仓库外）；spike1 的 target 含编译出的 OpenSSL，约 1-2GB，可留作复跑或删。
