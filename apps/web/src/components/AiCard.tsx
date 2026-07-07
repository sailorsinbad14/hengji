import { useEffect, useState } from 'react';
import type { Repository, StoredSetting } from '@app/store';
import { isLlmError, llmClearKey, llmComplete, llmKeyStatus, llmSetKey } from '@app/store/llm';
import { AI_CONFIG_KEY, APP_SCOPE, aiConfigOf } from '../settings';
import type { AiConfig } from '../settings';
import { confirmAsk } from '../confirm';

/**
 * 设置页「AI 智能认列」卡（增量4·4c，仅桌面渲染——Settings 里 isDesktop 门控）。
 * 非密配置（开关/协议/地址/模型）存 settings 表；API Key 走 Rust 命令 DPAPI 加密落盘（heng.apikey），
 * 明文 key 只在本组件输入框内存在、保存后即清空，绝不进 settings/绝不回读。
 */

interface Preset {
  id: string;
  name: string;
  protocol: AiConfig['protocol'];
  baseUrl: string;
  model: string;
}

/** 常用服务商预填（全部字段可再改；模型名会过时，仅是起点）。 */
const PRESETS: Preset[] = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'kimi', name: 'Kimi（月之暗面）', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
];

export default function AiCard({
  repo,
  settings,
  reload,
}: {
  repo: Repository;
  settings: StoredSetting[];
  reload: () => Promise<void>;
}) {
  const saved = aiConfigOf(settings);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [protocol, setProtocol] = useState<AiConfig['protocol']>(saved.protocol);
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [keyInput, setKeyInput] = useState('');
  const [keySet, setKeySet] = useState<boolean | null>(null); // null=查询中
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(''); // 保存/测试反馈

  useEffect(() => {
    llmKeyStatus()
      .then(setKeySet)
      .catch(() => setKeySet(false));
  }, []);

  async function saveConfig(patch?: Partial<AiConfig>): Promise<void> {
    const cfg: AiConfig = { enabled, protocol, baseUrl: baseUrl.trim(), model: model.trim(), ...patch };
    setBusy(true);
    setNote('');
    try {
      await repo.setSetting(APP_SCOPE, AI_CONFIG_KEY, JSON.stringify(cfg));
      await reload();
      setNote('配置已保存。');
    } catch (e) {
      setNote(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 开关立即生效（开关本身就是隐私闸门，不该等「保存」按钮）。
   * 基于**已持久化**的配置只改 enabled——绝不连带保存表单里的半成品编辑（那是「保存配置」按钮的活）；
   * 保存失败回滚勾选（隐私总开关的显示态必须与持久化态一致）。
   */
  async function toggleEnabled(on: boolean): Promise<void> {
    setEnabled(on);
    setBusy(true);
    setNote('');
    try {
      const persisted = aiConfigOf(settings);
      await repo.setSetting(APP_SCOPE, AI_CONFIG_KEY, JSON.stringify({ ...persisted, enabled: on }));
      await reload();
      setNote(on ? '已开启（服务商配置改动仍需点「保存配置」）。' : '已关闭。');
    } catch (e) {
      setEnabled(!on);
      setNote(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(id: string): void {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProtocol(p.protocol);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setNote('已填入预设，可修改后点「保存配置」。');
  }

  async function saveKey(): Promise<void> {
    setBusy(true);
    setNote('');
    try {
      await llmSetKey(keyInput);
      setKeyInput(''); // 明文 key 用后即清
      setKeySet(true);
      setNote('API Key 已加密保存（仅本机本用户可解）。');
    } catch (e) {
      setNote(`保存 Key 失败：${isLlmError(e) ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clearKey(): Promise<void> {
    if (!(await confirmAsk('清除已保存的 API Key？'))) return;
    setBusy(true);
    try {
      await llmClearKey();
      setKeySet(false);
      setNote('已清除 API Key。');
    } catch (e) {
      // 删除失败绝不显示假成功（Rust 侧带重试+存在性校验，失败=文件真删不掉）
      setNote(`清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 测试连接：一次极小补全（几个 token），验证 地址/模型/Key 三件套。 */
  async function testConnection(): Promise<void> {
    setBusy(true);
    setNote('正在连接…');
    try {
      await llmComplete({
        protocol,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        system: 'You are a connectivity probe.',
        user: 'Reply with exactly: OK',
        maxTokens: 16,
        temperature: 0,
      });
      setNote('连接成功 ✓（地址 / 模型 / Key 均可用）');
    } catch (e) {
      if (isLlmError(e)) {
        const hint =
          e.kind === 'no_key'
            ? '（请先保存 API Key）'
            : e.status === 401 || e.status === 403
              ? '（Key 无效或无权限）'
              : e.status === 404
                ? '（地址或模型名可能不对）'
                : '';
        setNote(`连接失败：${e.message}${hint}`);
      } else {
        setNote(`连接失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>AI 智能认列（云 · 自带 Key）</h3>
      <p className="muted small">
        默认关闭。开启后解锁两种上云用途（每次外发前都会再弹窗确认）：① 导入<b>陌生银行账单</b>时把
        「文件名 + 表头 + 最多前 25 行样本」发给你配置的 AI 服务商识别列结构（同一银行第二次导入先用本地记忆、不再上云）；
        ② <b>语音记账</b>时把你核对过的转写文本发给它生成草稿（音频本身永不上传）。
        金额解析、去重、记账全部仍在本地完成；支付宝 / 微信账单与图片识别从不上云。
      </p>
      <label className="chkline">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggleEnabled(e.target.checked)} />
        启用 AI 智能认列
      </label>
      {enabled && (
        <>
          <div className="rec-setup">
            <label>
              服务商预设
              <select defaultValue="" disabled={busy} onChange={(e) => applyPreset(e.target.value)}>
                <option value="" disabled>
                  选择后自动填入…
                </option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              协议
              <select value={protocol} disabled={busy} onChange={(e) => setProtocol(e.target.value as AiConfig['protocol'])}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
          </div>
          <div className="rec-setup">
            <label>
              API 地址
              <input
                type="text"
                value={baseUrl}
                placeholder="https://api.deepseek.com"
                disabled={busy}
                onChange={(e) => setBaseUrl(e.target.value)}
                style={{ minWidth: 260 }}
              />
            </label>
            <label>
              模型
              <input type="text" value={model} placeholder="deepseek-chat" disabled={busy} onChange={(e) => setModel(e.target.value)} />
            </label>
            <button disabled={busy} onClick={() => void saveConfig()}>
              保存配置
            </button>
          </div>
          <div className="rec-setup">
            <label>
              API Key{' '}
              <span className="muted small">{keySet === null ? '（查询中…）' : keySet ? '（已配置 · 本机加密存储）' : '（未配置）'}</span>
              <input
                type="password"
                value={keyInput}
                placeholder={keySet ? '输入新 Key 可覆盖' : 'sk-…'}
                disabled={busy}
                onChange={(e) => setKeyInput(e.target.value)}
                style={{ minWidth: 220 }}
              />
            </label>
            <button disabled={busy || keyInput.trim() === ''} onClick={() => void saveKey()}>
              保存 Key
            </button>
            {keySet === true && (
              <button className="lnk danger" disabled={busy} onClick={() => void clearKey()}>
                清除
              </button>
            )}
            <button disabled={busy} onClick={() => void testConnection()}>
              测试连接
            </button>
          </div>
          <p className="muted small">
            Key 经 Windows DPAPI 加密只存本机（换电脑/换用户无法解密），「清空全部数据」时一并删除；调用直接从本机发往服务商、不经任何中转。
          </p>
        </>
      )}
      {note && <p className="small">{note}</p>}
    </div>
  );
}
