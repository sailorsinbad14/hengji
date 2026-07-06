import { parseOcrBill } from '@app/core';
import type { ImportParseResult } from '@app/core';
import { ocrImage } from '@app/store/ocr';

/**
 * 图片识别（OCR）的 I/O 边界（增量2·2a-3）：图片 File → 字节 → desktop OCR 命令（WinRT）→ core 纯解析器。
 * OCR 命令仅桌面端可用，浏览器调不到——调用方须先用 `isDesktop` 门控本入口。
 * 与 import-files.ts（账单文件 CSV/xlsx 解析）并列：这是另一条进料路径（单笔截图）。
 */
export async function parseOcrImageFile(file: File): Promise<ImportParseResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // 数字数组经 IPC 传 Rust Vec<u8>（一次性用户动作，图片不大，可接受；raw 字节通道优化留 followup）。
  const result = await ocrImage(Array.from(buf));
  return parseOcrBill({ width: result.width, height: result.height, words: result.words });
}
