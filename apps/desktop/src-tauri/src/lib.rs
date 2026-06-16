mod crypto;
mod db;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(db::Db(Mutex::new(None)))
        .manage(crypto::Crypto(Mutex::new(None)))
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
