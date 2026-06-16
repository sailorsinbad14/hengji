import { useEffect, useState } from 'react';
import type { Repository, StoredSetting } from '@app/store';
import {
  changePassword,
  exportBackup,
  isCryptoError,
  pickBackupPath,
  removePassword,
  securityStatus,
  setPassword,
  wipeData,
} from '@app/store/crypto';
import type { SecurityStatus } from '@app/store/crypto';
import { APP_SCOPE, AUTOLOCK_KEY, autoLockMinOf } from '../settings';

/** 上次备份多久前（unix 秒 → 人话）。 */
function backupAge(unix: number | null | undefined): string {
  if (unix == null) return '从未备份';
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  return days <= 0 ? '今天' : `${days} 天前`;
}

/** 把捕获到的错误转成给用户看的一句话（区分加密三类失败 + 基建错）。 */
function msgOf(e: unknown): string {
  if (isCryptoError(e)) {
    switch (e.class) {
      case 'WrongPassword':
        return '密码错误。';
      case 'Locked':
        return '密码连续输错，安全芯片已临时锁定（防爆破）。请隔段时间后用正确密码再试，别清空 TPM。';
      case 'Corrupt':
        return '数据或加密信封可能已损坏。';
      case 'ChipUnavailable':
        return '安全芯片暂时不可用，请重启后重试。';
      default:
        return e.message || '操作失败。';
    }
  }
  return String(e);
}

type Mode = 'idle' | 'set' | 'change' | 'remove';

/**
 * 设置 →「安全」卡（仅桌面）。三态状态行（未加密 / 已加密·安全芯片强 / 已加密但芯片不可用·信封损坏）+
 * 设/改/移除密码 + 自动锁 + 备份导出（明文，关闭加密的等价物）+「清空数据」（用户主动、加密时需口令、二次确认）。
 * 口令由用户原生输入。set/remove 触发 Rust 侧明↔密库原子迁移。
 */
export default function SecurityCard({
  repo,
  settings,
  reload,
  onSecurityChange,
  onWiped,
}: {
  repo: Repository;
  settings: StoredSetting[];
  reload: () => Promise<void>;
  onSecurityChange: () => void;
  /** 清空成功后通知 App 重开全新空库、回主界面。 */
  onWiped: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [wipePw, setWipePw] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);
  const [wipeMode, setWipeMode] = useState(false);

  async function refresh(): Promise<void> {
    try {
      setStatus(await securityStatus());
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  function resetForm(): void {
    setMode('idle');
    setPw('');
    setPw2('');
    setOldPw('');
    setErr(null);
  }

  const autoLock = autoLockMinOf(settings);

  async function saveAutoLock(value: string): Promise<void> {
    await repo.setSetting(APP_SCOPE, AUTOLOCK_KEY, value);
    await reload();
  }

  async function doSet(): Promise<void> {
    if (busy) return;
    setErr(null);
    if (pw.length < 1) return setErr('请输入密码。');
    if (pw !== pw2) return setErr('两次输入的密码不一致。');
    setBusy(true);
    try {
      await setPassword(pw); // Rust：建封装 + 明文→密文迁移 + 重开密文连接
      resetForm();
      await refresh();
      onSecurityChange();
      await reload();
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doChange(): Promise<void> {
    if (busy) return;
    setErr(null);
    if (pw.length < 1) return setErr('请输入新密码。');
    if (pw !== pw2) return setErr('两次输入的新密码不一致。');
    setBusy(true);
    try {
      await changePassword(oldPw, pw);
      resetForm();
      await refresh();
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(): Promise<void> {
    if (busy) return;
    setErr(null);
    if (oldPw.length < 1) return setErr('请输入当前密码。');
    if (!confirm('移除密码后，数据库会解密为明文——任何拿到文件的人都能直接打开。确定移除？')) return;
    setBusy(true);
    try {
      await removePassword(oldPw); // Rust：验证口令 + 密文→明文迁移 + 拆封装
      resetForm();
      await refresh();
      onSecurityChange();
      await reload();
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(false);
    }
  }

  function startWipe(): void {
    setWipeMsg(null);
    setWipePw('');
    setWipeMode(true);
  }
  function cancelWipe(): void {
    setWipeMode(false);
    setWipePw('');
    setWipeMsg(null);
  }
  async function doWipe(): Promise<void> {
    if (wiping) return;
    setWipeMsg(null);
    const enc = status?.encrypted ?? false;
    if (enc && wipePw.length < 1) return setWipeMsg('请输入密码以确认是你本人。');
    if (
      !confirm(
        '确定清空全部数据？这会【永久删除】所有账本、流水、设置，本机无法找回。\n建议先导出一份备份再清空。确定继续？',
      )
    )
      return;
    setWiping(true);
    try {
      await wipeData(enc ? wipePw : undefined); // Rust：加密时验口令 → 删信封+钥匙+库
      cancelWipe();
      await onWiped(); // App 重开全新空库、回主界面 → 本组件随之卸载；成功路径不再 setState
    } catch (e) {
      setWipeMsg(msgOf(e)); // 加密时口令错 → WrongPassword
      setWiping(false);
    }
  }

  async function doBackup(): Promise<void> {
    if (backupBusy) return;
    setBackupMsg(null);
    const stamp = new Date().toISOString().slice(0, 10);
    let dest: string | null;
    try {
      dest = await pickBackupPath(`衡记备份-${stamp}.db`);
    } catch (e) {
      setBackupMsg(msgOf(e));
      return;
    }
    if (!dest) return; // 用户取消对话框
    setBackupBusy(true);
    try {
      const info = await exportBackup(dest); // Rust：解密导出明文 + 记录新鲜度
      await refresh();
      setBackupMsg(`✓ 已导出 ${info.rows} 条记录到 ${info.path}`);
    } catch (e) {
      setBackupMsg(msgOf(e));
    } finally {
      setBackupBusy(false);
    }
  }

  // —— 状态行 ——
  const encrypted = status?.encrypted ?? false;
  const strong = encrypted && status?.scheme === 'tpm-pcp' && status?.tpm_available;
  const chipDown = encrypted && !status?.tpm_available;
  const broken = encrypted && status?.scheme == null;

  return (
    <div className="card">
      <h3>安全 · 本地加密</h3>

      <div className="sec-status">
        {!status ? (
          <span className="sec-pill">加载中…</span>
        ) : !encrypted ? (
          <span className="sec-pill sec-none">未加密（明文）</span>
        ) : broken ? (
          <span className="sec-pill sec-warn">已加密 · 加密信封损坏</span>
        ) : chipDown ? (
          <span className="sec-pill sec-warn">已加密 · 安全芯片暂不可用</span>
        ) : (
          <span className="sec-pill sec-strong">已加密 · 安全芯片保护（强）</span>
        )}
      </div>

      {!encrypted && (
        <p className="muted small">
          当前数据库以明文存储，拷走文件即可打开。设置密码后，数据会用一把随机钥匙加密、钥匙锁进本机安全芯片，
          拷到别的电脑也解不开。<strong>但忘记密码无法找回（没有后门）</strong>，务必牢记并自行备份。
        </p>
      )}
      {strong && (
        <p className="muted small">数据已加密。钥匙绑定本机安全芯片，需在这台电脑上输对密码才能打开；拷走文件无法离线破解。</p>
      )}
      {chipDown && (
        <p className="muted small">读不到安全芯片，暂时无法改密/移除。请重启电脑或检查 BIOS 中的 TPM 设置后重试。</p>
      )}

      {/* —— 操作区 —— */}
      {mode === 'idle' && status && (
        <div className="sec-actions">
          {!encrypted ? (
            <button className="btn btn-primary" onClick={() => setMode('set')}>
              设置密码加密
            </button>
          ) : (
            !broken &&
            !chipDown && (
              <>
                <button className="btn" onClick={() => setMode('change')}>
                  修改密码
                </button>
                <button className="lnk danger" onClick={() => setMode('remove')}>
                  移除密码（解密为明文）
                </button>
              </>
            )
          )}
        </div>
      )}

      {mode === 'set' && (
        <div className="sec-form">
          <input type="password" placeholder="设置密码" value={pw} autoFocus disabled={busy} onChange={(e) => setPw(e.target.value)} />
          <input type="password" placeholder="再次输入密码" value={pw2} disabled={busy} onChange={(e) => setPw2(e.target.value)} />
          <p className="muted small">忘记密码＝数据彻底无法恢复（无后门）。请牢记，并确保已自行备份。</p>
          <div className="sec-form-btns">
            <button className="btn btn-primary" disabled={busy} onClick={() => void doSet()}>
              {busy ? '加密中…' : '加密'}
            </button>
            <button className="nb-cancel" disabled={busy} onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
      )}

      {mode === 'change' && (
        <div className="sec-form">
          <input type="password" placeholder="当前密码" value={oldPw} autoFocus disabled={busy} onChange={(e) => setOldPw(e.target.value)} />
          <input type="password" placeholder="新密码" value={pw} disabled={busy} onChange={(e) => setPw(e.target.value)} />
          <input type="password" placeholder="再次输入新密码" value={pw2} disabled={busy} onChange={(e) => setPw2(e.target.value)} />
          <div className="sec-form-btns">
            <button className="btn btn-primary" disabled={busy} onClick={() => void doChange()}>
              {busy ? '修改中…' : '确认修改'}
            </button>
            <button className="nb-cancel" disabled={busy} onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
      )}

      {mode === 'remove' && (
        <div className="sec-form">
          <input type="password" placeholder="当前密码" value={oldPw} autoFocus disabled={busy} onChange={(e) => setOldPw(e.target.value)} />
          <p className="muted small">移除后数据库变回明文，任何拿到文件的人都能直接打开。</p>
          <div className="sec-form-btns">
            <button className="btn danger-btn" disabled={busy} onClick={() => void doRemove()}>
              {busy ? '解密中…' : '移除密码'}
            </button>
            <button className="nb-cancel" disabled={busy} onClick={resetForm}>
              取消
            </button>
          </div>
        </div>
      )}

      {err && <p className="form-err">{err}</p>}

      {/* —— 自动锁（仅已加密强版时有意义）—— */}
      {strong && (
        <div className="sec-autolock">
          <label>
            自动锁定
            <select value={autoLock === 0 ? 'off' : String(autoLock)} onChange={(e) => void saveAutoLock(e.target.value)}>
              <option value="off">关闭</option>
              <option value="5">5 分钟无操作</option>
              <option value="15">15 分钟无操作</option>
              <option value="30">30 分钟无操作</option>
              <option value="60">60 分钟无操作</option>
            </select>
          </label>
          <p className="muted small">无操作达到时长后自动锁定，需重新输入密码。</p>
        </div>
      )}

      {/* —— 备份导出（明文 · 关闭加密的等价物）—— */}
      <div className="sec-backup">
        <div className="sec-backup-head">
          <button className="btn" disabled={backupBusy} onClick={() => void doBackup()}>
            {backupBusy ? '导出中…' : '导出未加密备份'}
          </button>
          <span className={`small${status?.last_backup_unix == null ? ' sec-stale' : ' muted'}`}>
            上次备份：{backupAge(status?.last_backup_unix)}
          </span>
        </div>
        {status?.last_backup_path && <p className="muted small sec-backup-path">于 {status.last_backup_path}</p>}
        <p className="muted small">
          备份是<strong>关闭加密的等价物</strong>、不受密码保护——请存到 U 盘等离线介质、别和电脑放一起。
          这也是忘记密码后<strong>唯一</strong>能找回数据的途径。
        </p>
        {encrypted && status?.last_backup_path && (
          <p className="sec-warn-line small">⚠ 存在 1 份未加密备份于 {status.last_backup_path}</p>
        )}
        {backupMsg && <p className="muted small">{backupMsg}</p>}
      </div>

      {/* —— 清空数据（用户主动 · 加密时需口令 · 二次确认）—— */}
      <div className="sec-wipe">
        {!wipeMode ? (
          <button className="lnk danger" onClick={startWipe}>
            清空全部数据…
          </button>
        ) : (
          <div className="sec-form">
            <p className="muted small">
              <strong>永久删除</strong>本机全部账本、流水、设置（含加密钥匙），<strong>无法找回</strong>、只能从你导出的备份恢复。
              {encrypted && '请输入当前密码确认是你本人。'}
            </p>
            {encrypted && (
              <input
                type="password"
                placeholder="输入当前密码确认"
                value={wipePw}
                autoFocus
                disabled={wiping}
                onChange={(e) => setWipePw(e.target.value)}
              />
            )}
            <div className="sec-form-btns">
              <button className="btn danger-btn" disabled={wiping} onClick={() => void doWipe()}>
                {wiping ? '清空中…' : '清空全部数据'}
              </button>
              <button className="nb-cancel" disabled={wiping} onClick={cancelWipe}>
                取消
              </button>
            </div>
            {wipeMsg && <p className="form-err">{wipeMsg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
