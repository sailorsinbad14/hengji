import { invoke } from '@tauri-apps/api/core';

/**
 * 本地 OCR 命令的 JS 包装（增量2·2a-3）。调 desktop Rust `ocr_image` 命令把图片字节识别成
 * 词 + 词级 bbox；**仅桌面端可用**（Windows.Media.Ocr 走 Tauri，浏览器无此命令），调用方须先 isDesktop 门控。
 * 返回的 words 交 core 的 `parseOcrBill` 抽草稿行（全本地、不上云）。
 */

/** Rust `ocr_image` 返回的一个词（含 bbox + 引擎行号；core 解析器只用 text/x/y/w/h）。 */
export interface OcrCommandWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
}

/** Rust `ocr_image` 返回：图片尺寸 + 引擎全文 + 词级 bbox。 */
export interface OcrCommandResult {
  width: number;
  height: number;
  text: string;
  words: OcrCommandWord[];
}

/** 识别一张图片（字节数组）→ 词 + bbox。仅桌面端。 */
export const ocrImage = (image: number[]): Promise<OcrCommandResult> => invoke('ocr_image', { image });
