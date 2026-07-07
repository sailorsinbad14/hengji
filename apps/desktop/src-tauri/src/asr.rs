//! 增量4·4d — 本地语音转写（sherpa-onnx + SenseVoice-Small int8）+ 模型按需下载。
//!
//! Spike（4d-0）已验：官方 sherpa-onnx crate 预编译库自动下载、SenseVoice 五语自动检测、
//! ITN 把「三千二百块」→「3200块」、加载 1.5s / 转写 RTF≈0.03（纯 CPU）。
//!
//! 隐私：转写**全程本地**，音频永不出机（出机的只有用户确认后的转写文本，走 llm.rs 结构化）。
//! 模型（≈228MB）不随安装包分发，设置/语音入口按需下载到 config_dir/asr-sensevoice/；
//! 属程序资产非用户数据，「清空全部数据」不删它。
//!
//! 音频入参＝**已解码的 16k 单声道 PCM 样本**（浏览器侧 AudioContext 解码/重采样任意格式，
//! Rust 侧不管容器格式），accept_waveform 直接吃。
use serde::Serialize;
use std::io::{Read as _, Seek as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

use crate::db::config_dir;

/// 模型目录名（config_dir 下）。
const MODEL_DIR: &str = "asr-sensevoice";
/// 下载源（顺序尝试）：国内镜像优先，HF 官方兜底。目录是版本化快照（2024-07-17），内容稳定。
const SOURCES: [&str; 2] = [
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
];
/// (文件名, 最小合法字节数)。最小阈值挡「镜像返回 HTML 错误页」这类假成功（真实大小 239MB / 316KB）。
const FILES: [(&str, u64); 2] = [("tokens.txt", 100 * 1024), ("model.int8.onnx", 200 * 1024 * 1024)];

// 常驻识别器（首次转写懒加载 ~1.5s，此后每次 ~0.2s）。上游 sherpa-onnx crate 已为
// OfflineRecognizer 实现 Send+Sync（安全论证由上游承担），Mutex<Option<...>> 直接可 manage。

#[derive(Clone, Serialize, Default)]
pub struct DownloadInfo {
    /// idle | downloading | done | error
    pub status: String,
    /// 大模型文件的已下载/总字节（tokens.txt 秒级，进度只跟模型文件）。
    pub downloaded: u64,
    pub total: u64,
    pub error: String,
}

pub struct Asr {
    pub recognizer: Mutex<Option<sherpa_onnx::OfflineRecognizer>>,
    pub download: Arc<Mutex<DownloadInfo>>,
}

impl Default for Asr {
    fn default() -> Self {
        Self { recognizer: Mutex::new(None), download: Arc::new(Mutex::new(DownloadInfo::default())) }
    }
}

fn model_dir(dir: &Path) -> PathBuf {
    dir.join(MODEL_DIR)
}

/// 两个模型文件都在且不小于合法阈值。
pub(crate) fn model_present(dir: &Path) -> bool {
    let md = model_dir(dir);
    FILES.iter().all(|(name, min)| md.join(name).metadata().map(|m| m.len() >= *min).unwrap_or(false))
}

#[derive(Serialize)]
pub struct AsrModelStatus {
    pub present: bool,
    /// 展示用模型目录（设置页「打开所在文件夹」/排障）。
    pub dir: String,
}

#[derive(Serialize)]
pub struct TranscribeResult {
    pub text: String,
}

/// 落位（tmp → dest）带退避重试：Windows 下刚写完的文件可能被杀软/索引器短暂持锁，
/// 裸 rename 一次失败会把「已完整的 .part」永远留在续传死区（下次 Range 超界 → 416）。
fn place(tmp: &Path, dest: &Path) -> Result<(), String> {
    let mut last: Option<std::io::Error> = None;
    for i in 0..8u32 {
        match std::fs::rename(tmp, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 * u64::from(i + 1)));
            }
        }
    }
    Err(format!("落位失败: {}", last.expect("loop ran")))
}

/// 单文件下载（带断点续传 + tmp→rename 原子 + 最小字节校验）。progress 回调收 (已下载, 总量)。
fn download_one(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    min_bytes: u64,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    let have = tmp.metadata().map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(url);
    if have > 0 {
        req = req.header("range", format!("bytes={have}-"));
    }
    let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    // 416＝Range 起点 ≥ 远端大小：.part 大概率已是完整文件（上次落位被瞬时锁挡掉 / 进程在 rename 前被杀）。
    // 够最小体积就直接落位；不够却 416＝状态错乱，删掉重来（否则每次续传都 416 → 永久死锁）。
    if status.as_u16() == 416 {
        if have >= min_bytes {
            return place(&tmp, dest);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err("续传状态异常，已重置断点，请再试一次".into());
    }
    if !status.is_success() {
        return Err(format!("下载失败 HTTP {}", status.as_u16()));
    }
    // 206=服务器接续（append）；200=服务器不认 Range（从头重写）
    let resume = status.as_u16() == 206 && have > 0;
    let remaining = resp.content_length().unwrap_or(0);
    let total = if resume { have + remaining } else { remaining };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resume)
        .open(&tmp)
        .map_err(|e| format!("写临时文件失败: {e}"))?;
    let mut written = if resume {
        file.seek(std::io::SeekFrom::End(0)).map_err(|e| e.to_string())?;
        have
    } else {
        0
    };
    progress(written, total);
    let mut reader = resp;
    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("写盘失败: {e}"))?;
        written += n as u64;
        progress(written, total);
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && written != total {
        return Err(format!("下载不完整（{written}/{total} 字节），请重试（会断点续传）"));
    }
    if written < min_bytes {
        let _ = std::fs::remove_file(&tmp); // 大概率是镜像的错误页，残片无续传价值
        return Err("下载内容异常（体积过小，可能是镜像错误页），请重试".into());
    }
    place(&tmp, dest)
}

/// 后台下载线程主体：逐文件 × 逐源尝试；进度/终态写共享 state。
fn run_download(dir: PathBuf, info: Arc<Mutex<DownloadInfo>>) {
    let client = match reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(3600)).build() {
        Ok(c) => c,
        Err(e) => {
            let mut d = info.lock().unwrap();
            d.status = "error".into();
            d.error = format!("HTTP 客户端构建失败: {e}");
            return;
        }
    };
    let md = model_dir(&dir);
    if let Err(e) = std::fs::create_dir_all(&md) {
        let mut d = info.lock().unwrap();
        d.status = "error".into();
        d.error = format!("创建模型目录失败: {e}");
        return;
    }
    for (name, min) in FILES {
        let dest = md.join(name);
        if dest.metadata().map(|m| m.len() >= min).unwrap_or(false) {
            continue; // 已就位（重入/上次成功一半）
        }
        let is_big = min > 1024 * 1024; // 进度只跟大模型文件
        let mut last_err = String::new();
        let mut ok = false;
        for src in SOURCES {
            let url = format!("{src}/{name}");
            let r = download_one(&client, &url, &dest, min, |done, total| {
                if is_big {
                    let mut d = info.lock().unwrap();
                    d.downloaded = done;
                    d.total = total;
                }
            });
            match r {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e) => last_err = format!("{url} → {e}"),
            }
        }
        if !ok {
            let mut d = info.lock().unwrap();
            d.status = "error".into();
            d.error = last_err;
            return;
        }
    }
    let mut d = info.lock().unwrap();
    d.status = "done".into();
    d.error = String::new();
}

// ---- Tauri 命令 ----

#[tauri::command]
pub fn asr_model_status(app: AppHandle) -> Result<AsrModelStatus, String> {
    let dir = config_dir(&app)?;
    Ok(AsrModelStatus { present: model_present(&dir), dir: model_dir(&dir).display().to_string() })
}

/// 启动模型下载（幂等：已在下载中直接返回；已就位置 done）。进度轮询 asr_download_progress。
#[tauri::command]
pub fn asr_download_model(app: AppHandle, asr: State<Asr>) -> Result<(), String> {
    let dir = config_dir(&app)?;
    {
        let mut d = asr.download.lock().unwrap();
        if d.status == "downloading" {
            return Ok(());
        }
        if model_present(&dir) {
            d.status = "done".into();
            return Ok(());
        }
        d.status = "downloading".into();
        d.error = String::new();
        d.downloaded = 0;
        d.total = 0;
    }
    let info = Arc::clone(&asr.download);
    std::thread::spawn(move || run_download(dir, info)); // 全新 std 线程：reqwest blocking 不进 tokio 环境
    Ok(())
}

#[tauri::command]
pub fn asr_download_progress(asr: State<Asr>) -> Result<DownloadInfo, String> {
    Ok(asr.download.lock().unwrap().clone())
}

/// 本地转写：16k 单声道 PCM 样本（浏览器侧已解码/重采样）→ 文本。识别器首次调用懒加载后常驻。
/// **async**：同步命令在主线程内联执行，巨型 payload 反序列化 + 加载 1.5s + 解码会把 UI 冻成「无响应」；
/// async 命令挪到 runtime 线程池（CPU 密集占一个 worker 数秒，可接受）。
#[tauri::command]
pub async fn asr_transcribe(app: AppHandle, asr: State<'_, Asr>, samples: Vec<f32>, sample_rate: u32) -> Result<TranscribeResult, String> {
    // 极短音频（<0.1s）产不出任何特征帧，0 帧输入直达 C 库＝异常穿透 FFI 的 abort 风险，前置挡掉
    if samples.len() < 1600 {
        return Err("音频太短（不足 0.1 秒），请重录".into());
    }
    let dir = config_dir(&app)?;
    if !model_present(&dir) {
        return Err("语音模型未下载，请先在语音入口下载模型（约 228MB，一次性）".into());
    }
    let md = model_dir(&dir);
    let mut cell = asr.recognizer.lock().unwrap(); // 串行化转写 + 懒加载
    if cell.is_none() {
        let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
        config.model_config.sense_voice = sherpa_onnx::OfflineSenseVoiceModelConfig {
            model: Some(md.join("model.int8.onnx").display().to_string()),
            language: Some("auto".into()), // 五语自动检测（zh/yue/en/ja/ko）
            use_itn: true,                 // 逆文本归一：三千二百块 → 3200块
            ..Default::default()
        };
        config.model_config.tokens = Some(md.join("tokens.txt").display().to_string());
        let rec = sherpa_onnx::OfflineRecognizer::create(&config)
            .ok_or_else(|| "加载语音模型失败（模型文件可能损坏，可删除模型目录后重新下载）".to_string())?;
        *cell = Some(rec);
    }
    let rec = cell.as_ref().expect("just loaded");
    let stream = rec.create_stream();
    stream.accept_waveform(sample_rate as i32, &samples);
    rec.decode(&stream);
    let result = stream.get_result().ok_or_else(|| "转写失败（未取到结果）".to_string())?;
    Ok(TranscribeResult { text: result.text })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// model_present：两文件都够大才算在（挡半截下载/错误页残留）。**无网络、无模型**。
    #[test]
    fn model_present_requires_both_files_min_size() {
        let dir = std::env::temp_dir().join(format!("heng-asr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let md = dir.join(MODEL_DIR);
        std::fs::create_dir_all(&md).unwrap();
        assert!(!model_present(&dir), "空目录应为未就位");
        std::fs::write(md.join("tokens.txt"), vec![0u8; 200 * 1024]).unwrap();
        assert!(!model_present(&dir), "缺模型文件应为未就位");
        std::fs::write(md.join("model.int8.onnx"), vec![0u8; 1024]).unwrap();
        assert!(!model_present(&dir), "模型文件过小（错误页残留）应为未就位");
        // 用 set_len 造大文件（稀疏，不真占盘）
        let f = std::fs::OpenOptions::new().write(true).open(md.join("model.int8.onnx")).unwrap();
        f.set_len(220 * 1024 * 1024).unwrap();
        drop(f);
        assert!(model_present(&dir), "两文件就位且够大");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
