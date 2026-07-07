import type { DraftSuggestion, ImportDraftRow, ImportParseResult } from '@app/core';
import { normalizeMappedDate } from '@app/core';
import { extractJsonObject } from './import-llm';

/**
 * 语音记账编排（增量4·4d）：录音/上传 → **本地** SenseVoice 转写（音频永不出机）→ 转写文本
 * 用户可编辑 → 确认后发云 LLM 结构化（走 4b 调用层 + 4c 配置/开关/逐次确认）→ source='voice'
 * 草稿行进同一复核台（金额/日期可编辑、unknown 三道闸不变）。
 * 红线：LLM 输出全量硬校验——金额非法跳过、日期过历法终门、kind×方向矛盾或**非人民币线索一律 unknown**。
 */

export const VOICE_SOURCE = 'voice';
/** 单次口述的行数上限（防 LLM 注水；一口气说不完 20 笔）。 */
const MAX_ROWS = 20;
/** 音频时长上限（IPC 传 PCM 样本，场景是一句话记账）。 */
export const MAX_AUDIO_SECONDS = 120;
/** 转写目标采样率（SenseVoice 训练口径）。 */
const TARGET_RATE = 16000;

/**
 * 任意音频（webm/opus 录音、mp3/m4a/wav 上传）→ 16k 单声道 PCM。
 * 解码/混音/重采样全在浏览器 AudioContext 完成，Rust 侧只吃裸样本。
 */
export async function decodeAudioTo16kMono(buf: ArrayBuffer): Promise<{ samples: number[]; sampleRate: number }> {
  // 体积粗门先于解码：decodeAudioData 会把整段解成 PCM（2 小时播客 ≈ 2.5GB AudioBuffer），
  // 时长检查若放在解码后，内存已经爆了。30MB ≈ 半小时 mp3，远超口述场景。
  if (buf.byteLength > 30 * 1024 * 1024) {
    throw new Error(`音频文件过大（${Math.round(buf.byteLength / 1048576)} MB），请控制在 30MB / ${MAX_AUDIO_SECONDS} 秒内、分段口述。`);
  }
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(buf.slice(0));
  } catch {
    throw new Error('无法解码这段音频（支持常见录音/音频格式，如 wav / mp3 / m4a / webm）。');
  } finally {
    void probe.close();
  }
  if (decoded.duration > MAX_AUDIO_SECONDS) {
    throw new Error(`音频过长（${Math.round(decoded.duration)} 秒），请控制在 ${MAX_AUDIO_SECONDS} 秒内、分段口述。`);
  }
  if (decoded.duration < 0.3) {
    throw new Error('音频太短（不足 0.3 秒），请重录。');
  }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * TARGET_RATE)), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded; // 多声道接单声道 destination＝自动下混
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { samples: Array.from(rendered.getChannelData(0)), sampleRate: TARGET_RATE };
}

/** 结构化提示词（system）：口语转写 → 草稿行 JSON。金额只许取原文数字，拿不准给 unknown。 */
export function buildVoiceSystemPrompt(today: string): string {
  return [
    '你是记账助手的结构化器。输入是一段本地语音转写的口语文本（用户口述收支/转账，可能有错别字，',
    '数字多已转为阿拉伯数字）。你把它翻译成记账草稿行 JSON；具体记哪个账本/科目由用户在复核台决定。',
    '只输出一个 JSON 对象，不要围栏与解释：',
    '{"rows":[{',
    '  "date":"YYYY-MM-DD"（相对日期按 今天=' + today + ' 换算：昨天/上周五等；没提日期就用今天）,',
    '  "amount": 金额数字（元、正数；必须来自原文，绝不虚构或估算）,',
    '  "direction": "in"（钱进来）| "out"（钱出去）,',
    '  "kind": "income"（对外真实收入）| "expense"（对外真实支出）| "transfer"（自有账户互转：还款/存取/理财）| "unknown"（拿不准）,',
    '  "payee": "对方名称（人/店/公司；没提留空串）",',
    '  "note": "用途/商品等简述（取自原话）",',
    '  "foreignCurrency": true 仅当金额疑似非人民币（美元/dollars/欧元…）；人民币或未提币种则省略',
    '}]}',
    '规则：一句话里说了几笔就出几行；金额、日期拿不准宁可 unknown/省略，不要猜。',
  ].join('\n');
}

/** 文本字段清洗：剥控制字符（防与去重键的 U+0001 消歧后缀字面相撞、防 UI 注入）+ trim + 截断。 */
function cleanText(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

/** 金额上限（分）：1e13＝千亿元。超安全整数的「整数」静默丢精度，余额算术失真（LLM 可能把单号误当金额）。 */
const MAX_AMOUNT_MINOR = 1e13;

/**
 * LLM 结构化输出 → 标准化草稿行（**全量硬校验**，LLM 产物不可信）：
 * 金额须为正数分且在安全整数量级内；日期过 normalizeMappedDate 历法终门、非法回落今天并告警、未来日期提示；
 * kind×direction 矛盾 → unknown；foreignCurrency → unknown（绝不静默按人民币记）；payee/note 剥控制字符；行数封顶。
 * `salt`＝批次盐（进去重键）：语音无外部唯一号，键若纯内容派生，跨批次去重会把「同天真实发生的
 * 第二笔相同交易」当重复吞掉——重复口述的兜底是复核台可见+整批撤销，不是静默去重。
 */
export function parseVoiceRows(llmText: string, today: string, salt: string): ImportParseResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(llmText));
  } catch {
    throw new Error('AI 返回的不是有效 JSON，请重试一次。');
  }
  const arr = Array.isArray(raw) ? raw : ((raw as Record<string, unknown> | null)?.rows as unknown);
  if (!Array.isArray(arr)) throw new Error('AI 返回缺少 rows 数组，请重试一次。');
  if (arr.length > MAX_ROWS) warnings.push(`AI 返回 ${arr.length} 行，仅取前 ${MAX_ROWS} 行`);

  const rows: ImportDraftRow[] = [];
  const seen = new Map<string, number>();
  for (const item of arr.slice(0, MAX_ROWS)) {
    if (typeof item !== 'object' || item === null) {
      warnings.push('跳过一行：格式不是对象');
      continue;
    }
    const o = item as Record<string, unknown>;
    const amount = Number(o.amount);
    const amountMinor = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amountMinor <= 0 || !Number.isSafeInteger(amountMinor) || amountMinor > MAX_AMOUNT_MINOR) {
      warnings.push(`跳过一行：金额无效或超出合理范围（${String(o.amount).slice(0, 24)}）`);
      continue;
    }
    const direction = o.direction === 'in' ? 'in' : o.direction === 'out' ? 'out' : null;
    if (!direction) {
      warnings.push('跳过一行：资金方向缺失');
      continue;
    }
    let date = today;
    if (typeof o.date === 'string' && o.date.trim() !== '') {
      const dt = normalizeMappedDate(o.date.trim(), 'auto');
      if (dt) date = dt.date;
      else warnings.push(`一行日期无法识别（${String(o.date).slice(0, 24)}），已按今天记，可在复核台改`);
    }
    if (date > today) warnings.push(`一行日期在未来（${date}），请核对是否为相对日期换算出错`);
    const payee = cleanText(o.payee, 64);
    const note = cleanText(o.note, 200);

    let suggestion: DraftSuggestion;
    if (o.foreignCurrency === true) {
      suggestion = 'unknown';
      warnings.push(`「${payee || note || `¥${(amountMinor / 100).toFixed(2)}`}」疑似非人民币金额，待复核台人工确认（导入线恒人民币）`);
    } else if (o.kind === 'income') {
      suggestion = direction === 'in' ? 'income' : 'unknown';
    } else if (o.kind === 'expense') {
      suggestion = direction === 'out' ? 'expense' : 'unknown';
    } else if (o.kind === 'transfer') {
      suggestion = direction === 'in' ? 'transfer-in' : 'transfer-out';
    } else {
      suggestion = 'unknown';
    }
    if (suggestion === 'unknown' && o.foreignCurrency !== true && (o.kind === 'income' || o.kind === 'expense')) {
      warnings.push('一行的类型与资金方向矛盾，已标待定');
    }

    // 去重键＝批次盐+内容派生（盐防跨批次吞真交易，见函数注释）；同批重复内容行以不可见分隔符
    // 追加序号消歧（payee 已剥控制字符，键不可能与内容字面相撞）
    const base = `voice:${salt}:${date}:${amountMinor}:${direction}:${payee}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const bizNo = n === 1 ? base : `${base}\u0001${n}`;

    rows.push({
      source: VOICE_SOURCE,
      bizNo,
      date,
      datetime: `${date} 00:00:00`,
      amountMinor,
      direction,
      payee,
      note,
      accountingType: '语音',
      suggestion,
    });
  }
  return { rows, meta: { source: VOICE_SOURCE }, warnings };
}
