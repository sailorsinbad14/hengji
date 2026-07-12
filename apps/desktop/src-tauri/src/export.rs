//! 流水导出落盘（CSV/Markdown）。文本内容由前端生成（apps/web/src/export.ts），这里只负责写文件：
//! 路径来自原生「另存为」对话框，仍过 heng.* 防撞校验（防手滑把导出存成 heng.db 覆盖活动库）。
//! 沿用「不引 tauri-plugin-fs、写文件都在 Rust 内完成」的既有决策（docs/design/encryption.md §7）。
//!
//! 信任边界：dest_path/content 来自 webview——与 export_backup 同一信任模型（webview 若被 XSS
//! 攻破，本命令可写任意非 heng.* 路径；CSP + 无远程内容使该前提难达成）。若要收紧（Rust 侧弹
//! 对话框取路径、JS 不传绝对路径），另立议题。

use std::path::Path;
use tauri::AppHandle;

use crate::crypto::validate_export_dest;
use crate::db::config_dir;

/// dir-based 可测内核：校验 + UTF-8 落盘。内容是文本（CSV/MD），不做二进制。
fn save_impl(dir: &Path, dest_str: &str, content: &str) -> Result<(), String> {
    let dest = Path::new(dest_str);
    validate_export_dest(dir, dest)?;
    std::fs::write(dest, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn save_text_file(app: AppHandle, dest_path: String, content: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    save_impl(&dir, &dest_path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 拒绝写应用数据目录下的 heng.*（防覆盖活动库）；目录内其他名字放行。
    #[test]
    fn save_rejects_heng_star_in_config_dir() {
        let dir = std::env::temp_dir().join(format!("heng-export-reject-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("heng.db");
        assert!(save_impl(&dir, bad.to_str().unwrap(), "x").is_err());
        assert!(!bad.exists());
        let ok = dir.join("流水.csv");
        assert!(save_impl(&dir, ok.to_str().unwrap(), "a,b\r\n").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    /// Windows 文件系统大小写不敏感：HENG.DB 等大小写变体同样被拒（guard 小写化比对）。
    #[test]
    fn save_rejects_heng_star_case_insensitive() {
        let dir = std::env::temp_dir().join(format!("heng-export-case-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for name in ["HENG.DB", "Heng.Db", "hEnG.security"] {
            let bad = dir.join(name);
            assert!(save_impl(&dir, bad.to_str().unwrap(), "x").is_err(), "{name} 应被拒");
            assert!(!bad.exists());
        }
        fs::remove_dir_all(&dir).ok();
    }

    /// 正常写出：UTF-8 内容（含 BOM 与中文）逐字节回读一致。
    #[test]
    fn save_writes_utf8_roundtrip() {
        let dir = std::env::temp_dir().join(format!("heng-export-write-{}", std::process::id()));
        let out = std::env::temp_dir().join(format!("heng-export-out-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&out).unwrap();
        let dest = out.join("衡记流水_测试_2026-07-07.csv");
        let content = "\u{FEFF}日期,金额\r\n2026-07-01,-33.80\r\n";
        save_impl(&dir, dest.to_str().unwrap(), content).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), content.as_bytes());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&out).ok();
    }
}
