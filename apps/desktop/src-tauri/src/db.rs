//! 自写 rusqlite + SQLCipher 桥，替代 tauri-plugin-sql。
//! - 单连接 `Mutex<Option<Connection>>`（可在多写时用一把事务，修连接池放弃事务的老债）。
//! - 占位符把 sqlx 风格 `$1..$N` 翻成 SQLite 的 `?1..?N`。
//! - 行按 column_name 映射成 {列名:值} JSON，形状与 tauri-plugin-sql 一致，让 web 层 schema.ts 零改。
//! 阶段 1a：开库不带 key（明文），行为与原 tauri-plugin-sql 一致。加密在阶段 2 由 db_open 带 key 接入。
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Value as Json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 单连接状态（由 db_open 填充）。
pub struct Db(pub Mutex<Option<Connection>>);

#[derive(serde::Deserialize)]
pub struct Stmt {
    sql: String,
    #[serde(default)]
    params: Vec<Json>,
}

/// `$1..$N`（sqlx 风格） → `?1..?N`（SQLite/rusqlite）。只对 `$` 紧跟数字时替换，其余原样。
fn translate(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' && chars.peek().is_some_and(|d| d.is_ascii_digit()) {
            out.push('?');
        } else {
            out.push(c);
        }
    }
    out
}

/// JSON 入参 → rusqlite 绑定值。
fn bind(v: &Json) -> SqlValue {
    match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Json::Number(n) => n
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => SqlValue::Text(s.clone()),
        // 数组/对象不应作为参数出现；防御性地序列化为文本。
        other => SqlValue::Text(other.to_string()),
    }
}

/// rusqlite 列值 → JSON（对齐 tauri-plugin-sql：INTEGER/REAL→number、TEXT→string、NULL→null）。
fn json_of(v: SqlValue) -> Json {
    match v {
        SqlValue::Null => Json::Null,
        SqlValue::Integer(i) => Json::from(i),
        SqlValue::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        SqlValue::Text(s) => Json::String(s),
        SqlValue::Blob(b) => Json::Array(b.into_iter().map(Json::from).collect()),
    }
}

fn run_select(conn: &Connection, sql: &str, params: &[Json]) -> rusqlite::Result<Vec<Json>> {
    let mut stmt = conn.prepare(&translate(sql))?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let n = names.len();
    let bound: Vec<SqlValue> = params.iter().map(bind).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(bound), |row| {
        let mut obj = Map::with_capacity(n);
        for (i, name) in names.iter().enumerate() {
            obj.insert(name.clone(), json_of(row.get::<_, SqlValue>(i)?));
        }
        Ok(Json::Object(obj))
    })?;
    rows.collect()
}

fn run_exec(conn: &Connection, sql: &str, params: &[Json]) -> rusqlite::Result<()> {
    let tsql = translate(sql);
    if params.is_empty() {
        // 迁移 DDL / PRAGMA：execute_batch 容忍多语句并丢弃结果集（如 journal_mode 的返回行）。
        conn.execute_batch(&tsql)
    } else {
        let bound: Vec<SqlValue> = params.iter().map(bind).collect();
        conn.execute(&tsql, rusqlite::params_from_iter(bound)).map(|_| ())
    }
}

// ---- commands ----

/// 本地库文件名（库与封装文件 heng.dek.tpm、迁移临时文件都在 config_dir 下，同卷便于 §9 原子替换）。
/// 与 web 侧 bootstrap 的 'sqlite:heng.db' 一致；crypto 迁移据此定位待加/解密的库。
pub const DB_FILE: &str = "heng.db";

/// 应用配置目录（%APPDATA%\<bundle id>\）。库与封装文件（heng.dek.tpm）都放这里。
/// 阶段 2 crypto 命令与 db_open 共用，确保 DEK 封装文件与库同目录（§9 同卷原子替换前提）。
pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 是否为 64 位十六进制（raw 32-byte DEK 的 hex 表示）。
fn is_dek_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 打开（或创建）SQLite/SQLCipher 连接。
/// - key=Some(dek_hex)：用 SQLCipher **原始密钥** 语法 `x'<hex>'` —— 把 DEK 当 32 字节原始密钥直接用、
///   跳过 PBKDF2 派生（DEK 本就是随机密钥），且必须是开库第一条 PRAGMA。
/// - key=None：明文库。
/// 随后统一 WAL/外键/busy_timeout。供 db_open 命令与测试共用。
pub fn open_db(full: &Path, key: Option<&str>) -> Result<Connection, String> {
    let conn = Connection::open(full).map_err(|e| e.to_string())?;
    if let Some(k) = key {
        if !is_dek_hex(k) {
            return Err("invalid DEK: expected 64 hex chars".into());
        }
        // k 已校验为纯十六进制 → 字符串插值无注入风险。raw-key 必须先于其它 PRAGMA。
        conn.execute_batch(&format!("PRAGMA key = \"x'{k}'\";"))
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 打开（或创建）本地库。path 形如 'sqlite:heng.db'，相对应用配置目录
/// （与原 tauri-plugin-sql 同一位置，保留既有数据）。
/// `encrypted=true` 时用 **Rust 侧已解锁的 DEK**（Crypto state）开 SQLCipher 密文库——
/// DEK 绝不跨 IPC 传给 JS，故这里只收一个布尔、自己去 Crypto state 取（须先 unlock）。
/// `encrypted=false` 开明文库（未加密／演示外的桌面默认）。
#[tauri::command]
pub fn db_open(
    app: AppHandle,
    db: State<Db>,
    crypto: State<crate::crypto::Crypto>,
    path: String,
    encrypted: bool,
) -> Result<(), String> {
    let file = path.strip_prefix("sqlite:").unwrap_or(&path);
    let full = config_dir(&app)?.join(file);
    let conn = if encrypted {
        // 先取 DEK→hex（在独立作用域里持 Crypto 锁），释放后再开库+持 Db 锁，保持「Crypto 先于 Db」的全局加锁序。
        let hex = {
            let guard = crypto.0.lock().unwrap();
            let dek = guard.as_ref().ok_or("数据库已加密但尚未解锁")?;
            crate::crypto::dek_hex(dek)
        };
        open_db(&full, Some(&hex))?
    } else {
        open_db(&full, None)?
    };
    *db.0.lock().unwrap() = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn db_select(db: State<Db>, sql: String, params: Vec<Json>) -> Result<Vec<Json>, String> {
    let guard = db.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("db not open")?;
    run_select(conn, &sql, &params).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_execute(db: State<Db>, sql: String, params: Vec<Json>) -> Result<(), String> {
    let guard = db.0.lock().unwrap();
    let conn = guard.as_ref().ok_or("db not open")?;
    run_exec(conn, &sql, &params).map_err(|e| e.to_string())
}

fn run_batch(conn: &mut Connection, stmts: &[Stmt]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for s in stmts {
        let bound: Vec<SqlValue> = s.params.iter().map(bind).collect();
        tx.execute(&translate(&s.sql), rusqlite::params_from_iter(bound))?;
    }
    tx.commit()
}

/// 多条写在一把事务里（要么全成、要么全不写）。给多写方法用，修「半截交易」老债。
#[tauri::command]
pub fn db_batch(db: State<Db>, stmts: Vec<Stmt>) -> Result<(), String> {
    let mut guard = db.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("db not open")?;
    run_batch(conn, &stmts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_close(db: State<Db>) -> Result<(), String> {
    *db.0.lock().unwrap() = None; // drop 即关闭连接
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_placeholders() {
        assert_eq!(translate("WHERE id=$1 AND book_id=$2"), "WHERE id=?1 AND book_id=?2");
        assert_eq!(translate("IN ($1, $2, $10)"), "IN (?1, ?2, ?10)");
        assert_eq!(translate("no params"), "no params");
        assert_eq!(translate("PRAGMA user_version = 5"), "PRAGMA user_version = 5");
    }

    #[test]
    fn binds_and_reads_back() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(a TEXT, b INTEGER, c REAL, d TEXT)").unwrap();
        run_exec(
            &conn,
            "INSERT INTO t(a,b,c,d) VALUES ($1,$2,$3,$4)",
            &[Json::String("x".into()), Json::from(7i64), Json::from(1.5f64), Json::Null],
        )
        .unwrap();
        let rows = run_select(&conn, "SELECT * FROM t WHERE b=$1", &[Json::from(7i64)]).unwrap();
        assert_eq!(rows.len(), 1);
        let o = rows[0].as_object().unwrap();
        assert_eq!(o["a"], Json::String("x".into()));
        assert_eq!(o["b"], Json::from(7i64));
        assert_eq!(o["c"], Json::from(1.5f64));
        assert_eq!(o["d"], Json::Null);
    }

    #[test]
    fn sqlcipher_raw_key_roundtrip() {
        // 用随机 32 字节 DEK 直接加密临时库（不经 TPM）：建→关→对 key 重开读回；错 key 读不出。
        // 验证 open_db 的 raw-key（x'..'）路径 + SQLCipher 真加密。0 DA、可自动跑。
        let base = std::env::temp_dir().join(format!("heng-sqlcipher-test-{}.db", std::process::id()));
        let cleanup = |p: &Path| {
            let _ = std::fs::remove_file(p);
            let _ = std::fs::remove_file(PathBuf::from(format!("{}-wal", p.display())));
            let _ = std::fs::remove_file(PathBuf::from(format!("{}-shm", p.display())));
        };
        cleanup(&base);
        let dek = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        {
            let conn = open_db(&base, Some(dek)).unwrap();
            conn.execute_batch("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('secret-marker');").unwrap();
        }
        // 落盘文件头不是明文 "SQLite format 3\0"（真加密）。
        let head = std::fs::read(&base).unwrap();
        assert_ne!(&head[..16], b"SQLite format 3\0", "库头不应是明文 SQLite");
        // 对 key 重开 → 读回。
        {
            let conn = open_db(&base, Some(dek)).unwrap();
            let v: String = conn.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
            assert_eq!(v, "secret-marker");
        }
        // 错 key → 打不开。注意 open_db 在 journal_mode=WAL 时即读库 → 解密失败会在 open_db 内就报
        // （fail-fast）；最迟也在首次查询失败。两种都算“被拒”。
        {
            let wrong = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
            let denied = match open_db(&base, Some(wrong)) {
                Err(_) => true, // 开库即拒
                Ok(conn) => conn.query_row("SELECT x FROM t", [], |r| r.get::<_, String>(0)).is_err(),
            };
            assert!(denied, "错 key 不应能读出明文");
        }
        cleanup(&base);
    }

    #[test]
    fn rejects_bad_dek_hex() {
        assert!(open_db(Path::new(":memory:"), Some("tooshort")).is_err());
        assert!(open_db(Path::new(":memory:"), Some(&"z".repeat(64))).is_err());
    }

    #[test]
    fn batch_is_atomic() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(id TEXT PRIMARY KEY)").unwrap();
        // 成功：两条都写入
        run_batch(
            &mut conn,
            &[
                Stmt { sql: "INSERT INTO t(id) VALUES ($1)".into(), params: vec![Json::from("a")] },
                Stmt { sql: "INSERT INTO t(id) VALUES ($1)".into(), params: vec![Json::from("b")] },
            ],
        )
        .unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // 失败回滚：'c' 本会插入，但随后 'a' 重复主键报错 → 整批回滚、'c' 不留
        let res = run_batch(
            &mut conn,
            &[
                Stmt { sql: "INSERT INTO t(id) VALUES ($1)".into(), params: vec![Json::from("c")] },
                Stmt { sql: "INSERT INTO t(id) VALUES ($1)".into(), params: vec![Json::from("a")] },
            ],
        );
        assert!(res.is_err());
        let n2: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 2, "rollback: 'c' 不应持久化");
    }
}
