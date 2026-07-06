//! 本地 OCR（增量2·2a-1）：用 Windows.Media.Ocr 把上传的账单图片（小票 / 收款详情 /
//! app 截图）识别成 **词 + 词级边界框**，交 core 纯解析器做空间行重建 + 抽草稿行
//! （见 packages/core 的 import/ocr）。
//!
//! Spike 已验（docs/design 见交接）：`zh-Hans-CN` 引擎**非提权**可用，金额 / 日期 /
//! 对方 / 交易单号等关键字段均能识别；输出含每个词的 bbox，正是列表 / 详情空间重建的依据。
//!
//! 边界纪律：本模块只做「图片字节 → 词 + bbox」这道 I/O 边界（脏活：WinRT 解码 + 识别），
//! **不**做任何金额 / 日期解析（那是 core 纯函数、可单测）。全本地、不上云（隐私最强）；
//! 红线不变：算账 / 落库走确定性引擎、复核台人工定稿。
use serde::Serialize;
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

/// 一个识别出的词 + 其在图片中的边界框（像素坐标，左上原点）。
/// core 解析器据 bbox 重建表格行（详情：找最大字号的金额；列表：Y 聚行、X 切「文字块 + 金额」）。
#[derive(Serialize)]
pub struct OcrWord {
    text: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    /// 引擎自带的分行序号。**仅供参考**——引擎的阅读顺序会把列表右列金额拆离原行，
    /// 故 core 以 bbox 自建行为准（这个字段留作调试 / 兜底）。
    line: u32,
}

/// 一张图片的 OCR 结果：图片尺寸 + 引擎全文 + 词级 bbox 列表。
#[derive(Serialize)]
pub struct OcrOutput {
    width: u32,
    height: u32,
    /// 引擎拼出的全文（调试 / 兜底用；正式抽取走 `words` 的空间重建）。
    text: String,
    words: Vec<OcrWord>,
}

/// OCR 失败（无中文引擎 / 图片无法解码 / 识别异常）。统一回传文案，不做安全分类（非敏感路径）。
#[derive(Serialize, Debug)]
pub struct OcrError {
    message: String,
}
fn err(m: impl Into<String>) -> OcrError {
    OcrError { message: m.into() }
}
fn win_err(e: windows::core::Error) -> OcrError {
    OcrError { message: e.message().to_string() }
}

/// 建中文 OCR 引擎：优先 `zh-Hans-CN`（简体中文识别器，Spike 实测在位），否则退用户配置语言。
fn make_engine() -> Result<OcrEngine, OcrError> {
    if let Ok(lang) = Language::CreateLanguage(&HSTRING::from("zh-Hans-CN")) {
        if OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok(engine);
            }
        }
    }
    // 兜底：用户配置语言。无任何 OCR 语言时会得到 null 引擎 → 留待 RecognizeAsync 报错回传。
    OcrEngine::TryCreateFromUserProfileLanguages().map_err(win_err)
}

/// 图片字节 → SoftwareBitmap（经内存随机访问流 + BitmapDecoder 解码，支持 png/jpg/bmp…）。
fn decode_bitmap(image: &[u8]) -> Result<(BitmapDecoder, SoftwareBitmap), OcrError> {
    let stream = InMemoryRandomAccessStream::new().map_err(win_err)?;
    let out = stream.GetOutputStreamAt(0).map_err(win_err)?;
    let writer = DataWriter::CreateDataWriter(&out).map_err(win_err)?;
    writer.WriteBytes(image).map_err(win_err)?;
    writer.StoreAsync().map_err(win_err)?.get().map_err(win_err)?;
    writer.FlushAsync().map_err(win_err)?.get().map_err(win_err)?;
    let _ = writer.DetachStream(); // 解绑输出视图，避免 writer drop 时关闭底层流
    stream.Seek(0).map_err(win_err)?;
    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(win_err)?.get().map_err(win_err)?;
    let bmp = decoder.GetSoftwareBitmapAsync().map_err(win_err)?.get().map_err(win_err)?;
    Ok((decoder, bmp))
}

/// 识别一张图片 → 词 + bbox。不碰 Tauri runtime，便于 `#[ignore]` 集成测试直接调。
fn recognize(image: &[u8]) -> Result<OcrOutput, OcrError> {
    if image.is_empty() {
        return Err(err("空图片"));
    }
    let engine = make_engine()?;
    let (decoder, bmp) = decode_bitmap(image)?;
    let width = decoder.PixelWidth().map_err(win_err)?;
    let height = decoder.PixelHeight().map_err(win_err)?;
    let result = engine.RecognizeAsync(&bmp).map_err(win_err)?.get().map_err(win_err)?;
    let text = result.Text().map_err(win_err)?.to_string();
    let mut words = Vec::new();
    for (li, line) in result.Lines().map_err(win_err)?.into_iter().enumerate() {
        for word in line.Words().map_err(win_err)? {
            let r = word.BoundingRect().map_err(win_err)?;
            words.push(OcrWord {
                text: word.Text().map_err(win_err)?.to_string(),
                x: r.X,
                y: r.Y,
                w: r.Width,
                h: r.Height,
                line: li as u32,
            });
        }
    }
    Ok(OcrOutput { width, height, text, words })
}

/// 识别上传的图片字节 → 词 + 词级 bbox（desktop-only；OCR 全本地、不上云）。
/// JS 侧把上传 / 粘贴的图片读成字节传入；返回的 words 交 core 解析器抽草稿行。
#[tauri::command]
pub fn ocr_image(image: Vec<u8>) -> Result<OcrOutput, OcrError> {
    recognize(&image)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机 OCR 冒烟（touches WinRT + 真图片；默认 `#[ignore]`，手动跑）：
    /// 设环境变量 `HENGJI_OCR_TEST_IMAGE` 指向一张账单截图 → 识别并打印尺寸 / 词数 / 全文。
    ///   `cargo test --release ocr_real_image_smoke -- --ignored --nocapture`
    #[test]
    #[ignore = "touches WinRT OCR + a real image; run manually with HENGJI_OCR_TEST_IMAGE set"]
    fn ocr_real_image_smoke() {
        let path = std::env::var("HENGJI_OCR_TEST_IMAGE").expect("set HENGJI_OCR_TEST_IMAGE");
        let bytes = std::fs::read(&path).expect("read test image");
        let out = recognize(&bytes).expect("recognize");
        println!("img {}x{}  words={}", out.width, out.height, out.words.len());
        println!("--- engine text ---\n{}\n--- end ---", out.text);
        assert!(out.width > 0 && out.height > 0, "图片尺寸应 > 0");
        assert!(!out.words.is_empty(), "应至少识别出一些词");
    }
}
