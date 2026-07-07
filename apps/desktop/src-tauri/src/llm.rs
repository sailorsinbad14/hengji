//! 增量4·4b — 云 LLM(BYOK) 调用层 + DPAPI 密钥存储（仅 Windows 桌面）。
//!
//! 职责边界：本模块**只做传输**——把「协议 + base_url + model + system + user」发给用户自带 key 的
//! 云端点，返回纯文本。具体提示词（CSV 列映射 / 语音结构化）由调用方（web 侧）构造并传入；返回文本
//! 的解释（如过 core 的 validateMappedSpec）也在调用方。红线不变：LLM 只产草稿/映射，算账走确定性引擎。
//!
//! 密钥存储＝**DPAPI**（CryptProtectData，当前用户 + 本机绑定；库/边车被拷到别的机器或别的用户解不开）。
//! 密文存 config_dir 的 `heng.apikey`（与 heng.dek.tpm 等同列），**明文 key 绝不跨 IPC 回传 JS、绝不进 settings 表**。
//! 「清空全部数据」时一并删除（见 crypto::engine::wipe）。
//!
//! 隐私：调用由 web 侧 opt-in + 逐次告知后才发生；本层不缓存请求/响应。
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use zeroize::Zeroizing;

use crate::db::config_dir;

/// DPAPI 密钥密文文件名（config_dir 内，与 heng.dek.tpm 同列）。**wipe 清单必须含它**（见 crypto::engine::wipe）。
pub(crate) const KEY_FILE: &str = "heng.apikey";

/// 跨 IPC 回传给 JS 的 LLM 错误：粗分类 + 文案 + HTTP 状态码（kind=http 时区分 401 认证/429 限流等）。
#[derive(Serialize, Debug, Clone)]
pub struct LlmError {
    /// no_key | config | network | http | parse | internal
    pub kind: String,
    pub message: String,
    pub status: u16,
}

impl LlmError {
    fn of(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), status: 0 }
    }
    fn internal(message: impl Into<String>) -> Self {
        Self::of("internal", message)
    }
}

/// 一次补全请求（camelCase：Tauri v2 IPC 默认；JS 传 { protocol, baseUrl, model, system, user, maxTokens? }）。
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequest {
    /// "anthropic" | "openai"（OpenAI 兼容协议一把覆盖 DeepSeek/Kimi/智谱 等国产商）。
    pub protocol: String,
    /// API 根地址（如 https://api.deepseek.com）或完整端点（智谱等非 /v1 版本段用完整端点）；见 build_url 归一。
    pub base_url: String,
    pub model: String,
    pub system: String,
    pub user: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

/// 补全响应（只回文本；结构化解释在调用方）。
#[derive(Serialize, Debug)]
pub struct LlmResponse {
    pub text: String,
}

fn key_path(dir: &Path) -> PathBuf {
    dir.join(KEY_FILE)
}

/// 是否已配置 key（设置页显示「已配置/未配置」用）。
pub(crate) fn key_present(dir: &Path) -> bool {
    key_path(dir).exists()
}

/// DPAPI 加密后原子写入密钥文件（tmp + sync + rename）。空 key 拒。
fn store_key(dir: &Path, key: &str) -> Result<(), LlmError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(LlmError::of("config", "API Key 不能为空"));
    }
    let cipher = dpapi::protect(trimmed.as_bytes())?;
    let tmp = dir.join(format!("{KEY_FILE}.tmp"));
    let mut fh = File::create(&tmp).map_err(|e| LlmError::internal(e.to_string()))?;
    fh.write_all(&cipher).map_err(|e| LlmError::internal(e.to_string()))?;
    fh.sync_all().map_err(|e| LlmError::internal(e.to_string()))?;
    std::fs::rename(&tmp, key_path(dir)).map_err(|e| LlmError::internal(e.to_string()))
}

/// 删除密钥文件（幂等；不存在也 Ok）——**删后校验确实消失**（对齐 074c806 教训：Windows 句柄
/// 延迟释放/只读属性会让裸 remove_file 静默失败，UI 显示「已清除」而密文仍在＝安全操作假成功）。
pub(crate) fn clear_key(dir: &Path) -> Result<(), LlmError> {
    let p = key_path(dir);
    for i in 0..8u32 {
        let _ = std::fs::remove_file(&p);
        if !p.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(30 * u64::from(i + 1)));
    }
    Err(LlmError::internal("清除失败：密钥文件被占用，无法删除，请稍后重试"))
}

/// 读回明文 key（Zeroizing：用完清零）。文件缺失 → no_key；DPAPI 解密失败（换机/换用户/篡改）→ internal。
fn load_key(dir: &Path) -> Result<Zeroizing<String>, LlmError> {
    let p = key_path(dir);
    if !p.exists() {
        return Err(LlmError::of("no_key", "尚未配置 API Key"));
    }
    let cipher = std::fs::read(&p).map_err(|e| LlmError::internal(e.to_string()))?;
    let plain = dpapi::unprotect(&cipher)?; // Zeroizing<Vec<u8>>：非 UTF-8 错误分支 drop 时也清零
    let s = std::str::from_utf8(&plain).map_err(|_| LlmError::internal("密钥解码失败（非 UTF-8）"))?;
    Ok(Zeroizing::new(s.to_string()))
}

#[cfg(windows)]
mod dpapi {
    //! Windows DPAPI（当前用户 + 本机绑定）。附应用专属 entropy：同用户下别的进程的 DPAPI 密文
    //! 不能被换进 heng.apikey 里解开（纵深防御）。
    use super::LlmError;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use zeroize::Zeroizing;

    const ENTROPY: &[u8] = b"hengji.llm.apikey.v1";

    fn as_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// 取出 output blob 的字节，**清零 CryptoAPI 分配的缓冲**（unprotect 的输出含明文 key），再 LocalFree。
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize); // 归还堆前抹掉明文残留
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
        v
    }

    /// 加密（输出＝密文，非敏感）。
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, LlmError> {
        let inb = as_blob(plain);
        let ent = as_blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        unsafe {
            CryptProtectData(&inb, PCWSTR::null(), Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| LlmError::internal(format!("DPAPI 加密失败: {}", e.message())))?;
            Ok(take(out))
        }
    }

    /// 解密（输出＝明文 key，Zeroizing 包裹：任何错误分支 drop 时也清零）。
    pub fn unprotect(cipher: &[u8]) -> Result<Zeroizing<Vec<u8>>, LlmError> {
        let inb = as_blob(cipher);
        let ent = as_blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        unsafe {
            CryptUnprotectData(&inb, None, Some(&ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| LlmError::internal(format!("DPAPI 解密失败: {}", e.message())))?;
            Ok(Zeroizing::new(take(out)))
        }
    }
}

mod http {
    //! 两套协议适配器（Anthropic /v1/messages，OpenAI 兼容 /v1/chat/completions）+ 端点归一。
    use super::{json, Duration, LlmError, LlmRequest, LlmResponse};

    /// 端点归一（tail 传入时须小写，如 "/chat/completions"）：
    /// - base 带 query/fragment（Azure 式 `?api-version=…`）→ 用户给的是完整 URL，原样，绝不再拼路径；
    /// - 已含操作尾（大小写不敏感）→ 完整端点，原样（智谱式 .../api/paas/v4/chat/completions）；
    /// - 末段是版本段 `v\d+`（大小写不敏感，如 /v1、/V4）→ 只补操作尾，不重复版本；
    /// - 否则补标准 `/v1/...` 路径。
    fn build_url(base: &str, std_path: &str, tail: &str) -> String {
        let trimmed = base.trim();
        if trimmed.contains('?') || trimmed.contains('#') {
            return trimmed.to_string();
        }
        let b = trimmed.trim_end_matches('/');
        if b.to_ascii_lowercase().ends_with(tail) {
            return b.to_string();
        }
        if let Some(last) = b.rsplit('/').next() {
            let l = last.to_ascii_lowercase();
            if l.len() > 1 && l.starts_with('v') && l[1..].bytes().all(|c| c.is_ascii_digit()) {
                return format!("{b}{tail}");
            }
        }
        format!("{b}{std_path}")
    }

    fn net_err(e: reqwest::Error) -> LlmError {
        let what = if e.is_timeout() {
            "网络超时"
        } else if e.is_connect() {
            "无法连接服务商"
        } else {
            "网络错误"
        };
        LlmError { kind: "network".into(), message: format!("{what}: {e}"), status: 0 }
    }

    /// 响应体上限（8 MiB）：LLM 映射/结构化响应是 KB 级；封顶挡住失控/恶意 base_url 的无长度大 body 撑爆内存。
    const MAX_BODY: u64 = 8 * 1024 * 1024;

    /// 读响应体（有界）并按状态码分流：非 2xx → 尽力抽服务商错误消息，带上 HTTP 状态码。
    fn read_body(resp: reqwest::blocking::Response) -> Result<String, LlmError> {
        use std::io::Read as _;
        let status = resp.status();
        let mut buf = Vec::new();
        resp.take(MAX_BODY)
            .read_to_end(&mut buf)
            .map_err(|e| LlmError { kind: "network".into(), message: format!("读取响应失败: {e}"), status: 0 })?;
        let body = String::from_utf8_lossy(&buf).into_owned();
        if status.is_success() {
            return Ok(body);
        }
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
            .unwrap_or_else(|| body.chars().take(300).collect());
        Err(LlmError {
            kind: "http".into(),
            message: format!("服务商返回 {}: {}", status.as_u16(), detail),
            status: status.as_u16(),
        })
    }

    /// Anthropic 响应：content:[{type:"text",text}] → 拼接所有 text 块。
    fn extract_anthropic(body: &str) -> Result<LlmResponse, LlmError> {
        let v: serde_json::Value =
            serde_json::from_str(body).map_err(|e| LlmError::of("parse", format!("响应非 JSON: {e}")))?;
        let blocks = v
            .get("content")
            .and_then(|c| c.as_array())
            .ok_or_else(|| LlmError::of("parse", "响应缺少 content 数组"))?;
        let mut text = String::new();
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
        if text.is_empty() {
            return Err(LlmError::of("parse", "响应无文本内容"));
        }
        Ok(LlmResponse { text })
    }

    /// OpenAI 兼容响应：choices[0].message.content。
    fn extract_openai(body: &str) -> Result<LlmResponse, LlmError> {
        let v: serde_json::Value =
            serde_json::from_str(body).map_err(|e| LlmError::of("parse", format!("响应非 JSON: {e}")))?;
        let text = v
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .ok_or_else(|| LlmError::of("parse", "响应缺少 choices[0].message.content"))?;
        if text.is_empty() {
            return Err(LlmError::of("parse", "响应无文本内容"));
        }
        Ok(LlmResponse { text: text.to_string() })
    }

    /// 发一次补全（reqwest **blocking**；调用方保证在无 tokio 环境的独立线程里跑，见 llm_complete）。
    pub fn complete(req: &LlmRequest, key: &str) -> Result<LlmResponse, LlmError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| LlmError::internal(format!("HTTP 客户端构建失败: {e}")))?;
        let max_tokens = req.max_tokens.unwrap_or(1024);
        let temperature = req.temperature.unwrap_or(0.0);
        match req.protocol.as_str() {
            "anthropic" => {
                let url = build_url(&req.base_url, "/v1/messages", "/messages");
                let body = json!({
                    "model": req.model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "system": req.system,
                    "messages": [{ "role": "user", "content": req.user }],
                });
                let resp = client
                    .post(&url)
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .map_err(net_err)?;
                extract_anthropic(&read_body(resp)?)
            }
            "openai" => {
                let url = build_url(&req.base_url, "/v1/chat/completions", "/chat/completions");
                let body = json!({
                    "model": req.model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "messages": [
                        { "role": "system", "content": req.system },
                        { "role": "user", "content": req.user },
                    ],
                });
                let resp = client
                    .post(&url)
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .map_err(net_err)?;
                extract_openai(&read_body(resp)?)
            }
            other => Err(LlmError::of("config", format!("未知协议: {other}"))),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn build_url_appends_or_respects() {
            // 无版本段 → 补标准路径
            assert_eq!(build_url("https://api.deepseek.com", "/v1/chat/completions", "/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
            assert_eq!(build_url("https://api.anthropic.com", "/v1/messages", "/messages"), "https://api.anthropic.com/v1/messages");
            // 已带 /v1 → 只补尾（不重复 /v1）
            assert_eq!(build_url("https://api.openai.com/v1", "/v1/chat/completions", "/chat/completions"), "https://api.openai.com/v1/chat/completions");
            // 完整端点（智谱式 /api/paas/v4/...）→ 原样
            assert_eq!(
                build_url("https://open.bigmodel.cn/api/paas/v4/chat/completions", "/v1/chat/completions", "/chat/completions"),
                "https://open.bigmodel.cn/api/paas/v4/chat/completions"
            );
            // 尾斜杠归一
            assert_eq!(build_url("https://api.deepseek.com/", "/v1/chat/completions", "/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
            // 带 query（Azure 式）→ 原样，绝不再拼路径
            assert_eq!(
                build_url("https://x.openai.azure.com/openai/deployments/g/chat/completions?api-version=2024-02-01", "/v1/chat/completions", "/chat/completions"),
                "https://x.openai.azure.com/openai/deployments/g/chat/completions?api-version=2024-02-01"
            );
            // 大小写不敏感的版本段 → 只补尾、不重复
            assert_eq!(build_url("https://api.openai.com/V1", "/v1/chat/completions", "/chat/completions"), "https://api.openai.com/V1/chat/completions");
            // 大小写不敏感的操作尾 → 原样
            assert_eq!(build_url("https://h.example.com/API/Chat/Completions", "/v1/chat/completions", "/chat/completions"), "https://h.example.com/API/Chat/Completions");
        }

        #[test]
        fn extract_anthropic_concats_text_blocks() {
            let body = r#"{"content":[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}"#;
            assert_eq!(extract_anthropic(body).unwrap().text, "你好世界");
        }

        #[test]
        fn extract_openai_reads_first_choice() {
            let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"version\":1}"}}]}"#;
            assert_eq!(extract_openai(body).unwrap().text, "{\"version\":1}");
        }

        #[test]
        fn extract_errors_on_shape_mismatch() {
            assert_eq!(extract_anthropic("not json").unwrap_err().kind, "parse");
            assert_eq!(extract_openai(r#"{"choices":[]}"#).unwrap_err().kind, "parse");
            assert_eq!(extract_anthropic(r#"{"content":[]}"#).unwrap_err().kind, "parse");
        }
    }
}

// ---- Tauri 命令（薄包装；明文 key 绝不回传 JS） ----

/// 是否已配置 API Key（设置页显示状态）。
#[tauri::command]
pub fn llm_key_status(app: AppHandle) -> Result<bool, String> {
    let dir = config_dir(&app)?;
    Ok(key_present(&dir))
}

/// 保存 API Key（DPAPI 加密存盘）。
#[tauri::command]
pub fn llm_set_key(app: AppHandle, key: String) -> Result<(), LlmError> {
    let key = Zeroizing::new(key); // 立即接管 IPC 传入的明文，命令返回时清零（不留 freed-heap 残留）
    let dir = config_dir(&app).map_err(|e| LlmError::internal(e))?;
    store_key(&dir, key.as_str())
}

/// 清除已存的 API Key（删除失败如实上报，绝不假成功）。
#[tauri::command]
pub fn llm_clear_key(app: AppHandle) -> Result<(), LlmError> {
    let dir = config_dir(&app).map_err(|e| LlmError::internal(e))?;
    clear_key(&dir)
}

/// 发一次补全。key 从 DPAPI 密钥文件读出（不跨 IPC）。
/// **async**：同步命令在主线程内联执行，join 等待网络往返会冻住 UI（窗口拖动/并发 IPC 全排队）；
/// async 命令挪到 runtime 线程池。内层仍用全新 OS 线程跑 reqwest blocking（脱离 tokio 环境）。
#[tauri::command]
pub async fn llm_complete(app: AppHandle, req: LlmRequest) -> Result<LlmResponse, LlmError> {
    let dir = config_dir(&app).map_err(|e| LlmError::internal(e))?;
    let key = load_key(&dir)?;
    let handle = std::thread::spawn(move || http::complete(&req, key.as_str()));
    tauri::async_runtime::spawn_blocking(move || handle.join().map_err(|_| LlmError::internal("HTTP 线程异常终止"))?)
        .await
        .map_err(|e| LlmError::internal(format!("任务调度失败: {e}")))?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("hengji-llm-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn dpapi_roundtrip_and_key_store() {
        let dir = tmp_dir();
        clear_key(&dir).unwrap();
        assert!(!key_present(&dir), "初始无 key");
        assert_eq!(load_key(&dir).unwrap_err().kind, "no_key");

        let secret = "sk-ant-test-0123456789abcdef";
        store_key(&dir, secret).unwrap();
        assert!(key_present(&dir), "存后有 key");
        // 落盘的是密文（DPAPI），不是明文
        let raw = std::fs::read(dir.join(KEY_FILE)).unwrap();
        assert_ne!(raw.as_slice(), secret.as_bytes(), "落盘必须是 DPAPI 密文");
        // 读回明文一致（trim）
        assert_eq!(load_key(&dir).unwrap().as_str(), secret);

        // 空 key 拒
        assert_eq!(store_key(&dir, "   ").unwrap_err().kind, "config");

        clear_key(&dir).unwrap();
        assert!(!key_present(&dir), "清除后无 key");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
