import { invoke } from '@tauri-apps/api/core';

/**
 * 本地语音转写命令的 JS 封装（增量4·4d；仅桌面 / Tauri runtime 有效）。
 * 对接 Rust 的 asr 命令（src-tauri/src/asr.rs）：SenseVoice-Small int8 全本地转写（音频永不出机），
 * 模型 ≈228MB 按需下载（hf-mirror 优先、HF 官方兜底，断点续传）。
 * 音频入参＝**已解码的 16k 单声道 PCM 样本**（调用方用 AudioContext 解码/重采样任意格式）。
 */

export interface AsrModelStatus {
  present: boolean;
  /** 模型所在目录（排障/展示用）。 */
  dir: string;
}

export interface AsrDownloadInfo {
  /** idle | downloading | done | error */
  status: string;
  /** 大模型文件的已下载/总字节。 */
  downloaded: number;
  total: number;
  error: string;
}

export interface TranscribeResult {
  text: string;
}

export const asrModelStatus = (): Promise<AsrModelStatus> => invoke('asr_model_status');

/** 启动模型下载（幂等）。之后轮询 {@link asrDownloadProgress}。 */
export const asrDownloadModel = (): Promise<void> => invoke('asr_download_model');

export const asrDownloadProgress = (): Promise<AsrDownloadInfo> => invoke('asr_download_progress');

/** 本地转写 16k 单声道 PCM。首次调用懒加载模型（~1.5s），此后每次 ~0.2s/5s 音频。 */
export const asrTranscribe = (samples: number[], sampleRate: number): Promise<TranscribeResult> =>
  invoke('asr_transcribe', { samples, sampleRate });
