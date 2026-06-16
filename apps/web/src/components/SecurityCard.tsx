import { useEffect, useState } from 'react';
import type { Repository, StoredSetting } from '@app/store';
import {
  changePassword,
  isCryptoError,
  removePassword,
  securityStatus,
  setPassword,
} from '@app/store/crypto';
import type { SecurityStatus } from '@app/store/crypto';
import { APP_SCOPE, AUTOLOCK_KEY, autoLockMinOf } from '../settings';

/** 把捕获到的错误转成给用户看的一句话（区分加密三类失败 + 基建错）。 */
function msgOf(e: unknown): string {
  if (isCryptoError(e)) {
    switch (e.class) {
      case 'WrongPassword':
        return '密码错误。';
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
 * 设/改/移除密码 + 自动锁。口令由用户原生输入。set/remove 会触发 Rust 侧明↔密库原子迁移（可能耗时，显示处理中）。
 * 「错 N 次销毁」+ 备份导出留下一阶段（Phase 4）。
 */
export default function SecurityCard({
  repo,
  settings,
  reload,
  onSecurityChange,
}: {
  repo: Repository;
  settings: StoredSetting[];
  reload: () => Promise<void>;
  onSecurityChange: () => void;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

      <p className="muted small sec-todo">「输错多次自动销毁」与「加密备份导出」将在后续版本提供。</p>
    </div>
  );
}
