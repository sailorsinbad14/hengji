mod asr;
mod crypto;
mod db;
mod export;
mod llm;
mod ocr;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(db::Db(Mutex::new(None)))
        .manage(crypto::Crypto(Mutex::new(crypto::CryptoState::default())))
        .manage(asr::Asr::default())
        .invoke_handler(tauri::generate_handler![
            db::db_open,
            db::db_select,
            db::db_execute,
            db::db_batch,
            db::db_close,
            crypto::security_status,
            crypto::set_password,
            crypto::unlock,
            crypto::change_password,
            crypto::remove_password,
            crypto::lock,
            crypto::export_backup,
            crypto::wipe_data,
            export::save_text_file,
            llm::llm_key_status,
            llm::llm_set_key,
            llm::llm_clear_key,
            llm::llm_complete,
            asr::asr_model_status,
            asr::asr_download_model,
            asr::asr_download_progress,
            asr::asr_transcribe,
            ocr::ocr_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 正常退出前 checkpoint+关库：别把真实数据长期悬在 -wal（手工拷 heng.db 会拿旧数据）。
                // 崩溃/强杀不经此处——那时 -wal 保留、下次开库自动恢复，数据不丢，只是单文件拷贝仍旧。
                match db::close_with_checkpoint(&app.state::<db::Db>()) {
                    Ok(true) => {}
                    Ok(false) => eprintln!("[hengji] 退出 checkpoint 未落干净（busy）——-wal 保留，数据完整"),
                    Err(e) => eprintln!("[hengji] 退出 checkpoint 失败（数据靠 -wal 完整，下次启动自动恢复）：{e}"),
                }
            }
        });
}
