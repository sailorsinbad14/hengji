import { invoke } from '@tauri-apps/api/core';

/**
 * 云 LLM(BYOK) 调用层的 JS 封装（增量4·4b；仅桌面 / Tauri runtime 有效）。
 * 对接 Rust 的 llm 命令（src-tauri/src/llm.rs）。**明文 API Key 只在 Rust 侧**：JS 只负责传 key 进去存
 * （DPAPI 加密落盘）、传非密配置（协议/base URL/模型）发起调用；key 绝不回传 JS、绝不进 settings 表。
 *
 * 职责：本层只做传输。提示词（CSV 列映射 / 语音结构化）由调用方构造后作为 system/user 传入；返回文本
 * 的解释（如过 core validateMappedSpec）也在调用方。红线：LLM 只产草稿/映射，算账走确定性引擎。
 */

/** 跨 IPC 的 LLM 错误：粗分类 + 文案 + HTTP 状态码（kind==='http' 时区分 401/429 等）。 */
export interface LlmError {
  /** no_key | config | network | http | parse | internal */
  kind: string;
  message: string;
  status: number;
}

/** 是否长得像 LlmError（invoke reject 出来的是普通对象，需窄化）。 */
export function isLlmError(e: unknown): e is LlmError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e;
}

/** 一次补全请求（非密配置由调用方给；key 在 Rust 侧从 DPAPI 密钥文件读）。 */
export interface LlmRequest {
  /** 'anthropic' | 'openai'（OpenAI 兼容协议覆盖 DeepSeek/Kimi/智谱 等）。 */
  protocol: 'anthropic' | 'openai';
  /** API 根地址（如 https://api.deepseek.com）或完整端点（智谱等）。 */
  baseUrl: string;
  model: string;
  /** 系统提示（任务约束）。 */
  system: string;
  /** 用户内容（待翻译的样本 / 转写文本）。 */
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/** 补全响应（只回文本；结构化解释在调用方）。 */
export interface LlmResponse {
  text: string;
}

/** 是否已配置 API Key（设置页显示状态）。 */
export const llmKeyStatus = (): Promise<boolean> => invoke('llm_key_status');

/** 保存 API Key（Rust 侧 DPAPI 加密落盘）。 */
export const llmSetKey = (key: string): Promise<void> => invoke('llm_set_key', { key });

/** 清除已存的 API Key。 */
export const llmClearKey = (): Promise<void> => invoke('llm_clear_key');

/** 发一次补全。失败 reject {@link LlmError}。 */
export const llmComplete = (req: LlmRequest): Promise<LlmResponse> => invoke('llm_complete', { req });
