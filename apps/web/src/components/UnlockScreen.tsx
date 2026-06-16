import { useState } from 'react';
import { isCryptoError, unlock } from '@app/store/crypto';
import type { CryptoError } from '@app/store/crypto';

/**
 * 解锁屏（仅桌面已加密时，bootstrap 门在开库前渲染）。
 * 口令由用户在原生输入框输入，解锁成功（DEK 已存 Rust 侧）后回调 onUnlocked 让 App 开库。
 * 失败按分流（§5）：口令错可重试；数据损坏 / 芯片不可用 / 芯片锁定走专门提示、不诱导反复试错。
 */
export default function UnlockScreen({ onUnlocked }: { onUnlocked: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<CryptoError | null>(null);

  async function submit(): Promise<void> {
    if (busy || !pw) return;
    setBusy(true);
    setErr(null);
    try {
      await unlock(pw);
      setPw('');
      await onUnlocked(); // 开库 + 进入主界面（由 App 处理）
    } catch (e) {
      setErr(isCryptoError(e) ? e : { class: 'Internal', code: 0, message: String(e) });
      setBusy(false);
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-brand">
          <span className="mark">衡</span> 衡记
        </div>
        <p className="lock-sub">本账本已加密，请输入密码解锁。</p>
        <input
          type="password"
          className="lock-input"
          placeholder="密码"
          value={pw}
          autoFocus
          disabled={busy}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button className="btn btn-primary lock-btn" disabled={busy || !pw} onClick={() => void submit()}>
          {busy ? '解锁中…' : '解锁'}
        </button>
        {err && <LockError err={err} />}
        <p className="lock-foot muted small">忘记密码无法找回：钥匙锁在本机安全芯片里，没有后门。请确保你有备份。</p>
      </div>
    </div>
  );
}

function LockError({ err }: { err: CryptoError }) {
  // 显示芯片返回的原始 HRESULT，便于诊断/支持（§5「持 live code 细化」）。
  const code = err.code ? `（错误码 0x${err.code.toString(16)}）` : '';
  if (err.class === 'WrongPassword') {
    return <p className="lock-err">密码错误，请重试。每次输错都会消耗安全芯片的一次防猜测额度，连错过多会被临时锁定。</p>;
  }
  if (err.class === 'Locked') {
    return (
      <div className="lock-err lock-err-block">
        <strong>密码连续输错，安全芯片已临时锁定</strong>
        <p className="small">
          这是芯片的防爆破保护。请隔一段时间后用<strong>正确</strong>密码再试——一次成功即解除；期间别继续试错，重启不一定能解，更<strong>不要清空 TPM</strong>（会永久毁掉钥匙）。{code}
        </p>
      </div>
    );
  }
  if (err.class === 'Corrupt') {
    return (
      <div className="lock-err lock-err-block">
        <strong>数据可能已损坏</strong>
        <p className="small">加密信封或数据库文件读取失败，重复尝试无济于事。如有备份请从备份恢复。{code}</p>
      </div>
    );
  }
  if (err.class === 'ChipUnavailable') {
    return (
      <div className="lock-err lock-err-block">
        <strong>暂时无法访问安全芯片</strong>
        <p className="small">多数情况是临时的——请重启电脑后再试一次。{code}</p>
        <p className="small">
          但如果你曾清空过 TPM、更换主板/CPU，或把数据文件拷到了别的电脑，则封装钥匙已永久失效、本机再也无法解开——请改用备份恢复。
        </p>
      </div>
    );
  }
  return <p className="lock-err">解锁失败：{err.message}{code}</p>;
}
