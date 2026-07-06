mod crypto;
mod db;
mod llm;
mod ocr;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(db::Db(Mutex::new(None)))
        .manage(crypto::Crypto(Mutex::new(crypto::CryptoState::default())))
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
            llm::llm_key_status,
            llm::llm_set_key,
            llm::llm_clear_key,
            llm::llm_complete,
            ocr::ocr_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
