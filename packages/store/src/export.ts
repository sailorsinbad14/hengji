import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

/**
 * 流水导出（CSV/Markdown）的桌面落盘封装（仅 Tauri runtime 有效）。
 * 内容在 web 侧生成（apps/web/src/export.ts 纯函数）；写文件在 Rust 内完成
 * （src-tauri/src/export.rs，沿用「不引 tauri-plugin-fs」的既有决策 + heng.* 防撞）。
 */

/** 弹原生「另存为」对话框选导出路径；用户取消返回 null。 */
export const pickExportPath = (defaultName: string, filterName: string, ext: string): Promise<string | null> =>
  save({
    title: '导出流水',
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [ext] }],
  });

/** 把文本内容写到 destPath（Rust 侧校验路径防撞后 UTF-8 落盘）。 */
export const saveTextFile = (destPath: string, content: string): Promise<void> =>
  invoke('save_text_file', { destPath, content });
