//! 把前端生成好的导出文件写到用户选定的路径。内容全在前端生成（exceljs），
//! Rust 只负责落盘：排版依赖着色器、日历、汇总结果，在 Rust 重算等于实现两遍模型。
//! 路径来自「另存为」对话框，不该擅自改写用户给的文件名。

use std::fs;
use std::path::Path;

/// Base64 解码。前端传字节只能走 base64：JSON 数字数组体积 4×，
/// raw IPC body 拿不到同一次调用的路径。手写这二十行比引 crate 划算。
pub(crate) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const INVALID: u8 = 0xFF;
    // 反查表：ASCII → 6 位值
    let mut table = [INVALID; 256];
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i < alphabet.len() {
        table[alphabet[i] as usize] = i as u8;
        i += 1;
    }

    let bytes: Vec<u8> = input
        .bytes()
        // 换行和 '=' 填充不携带信息，滤掉后统一做长度校验
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();

    // 每 4 个字符 → 3 字节。余 1 个字符是不可能出现的合法编码
    if bytes.len() % 4 == 1 {
        return Err("base64 长度非法".into());
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    for chunk in bytes.chunks(4) {
        let mut acc: u32 = 0;
        for &b in chunk {
            let v = table[b as usize];
            if v == INVALID {
                return Err(format!("base64 含非法字符：{}", b as char));
            }
            acc = (acc << 6) | v as u32;
        }
        // 不足 4 个时左移补齐，再按实际字节数取高位
        let produced = chunk.len() - 1;
        acc <<= 6 * (4 - chunk.len());
        for k in 0..produced {
            out.push((acc >> (16 - 8 * k)) as u8);
        }
    }
    Ok(out)
}

/// Base64 编码。头像在库里是 `data:image/png;base64,...`，导出要还原成
/// 真实 PNG 文件，导入又要拼回 data URI。
pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        // 不足 3 字节时右边补零凑满 24 位，再按实际字节数决定输出几个字符
        let mut acc = 0u32;
        for (i, &b) in chunk.iter().enumerate() {
            acc |= (b as u32) << (16 - 8 * i);
        }
        for k in 0..chunk.len() + 1 {
            out.push(ALPHABET[((acc >> (18 - 6 * k)) & 0x3F) as usize] as char);
        }
        for _ in chunk.len()..3 {
            out.push('=');
        }
    }
    out
}

/// 写文件。父目录不存在就建出来：在保存对话框里新建目录后取消再确认，
/// 偶尔会拿到尚未落地的路径。
#[tauri::command]
pub fn write_export(path: String, base64: String) -> Result<String, String> {
    let bytes = decode_base64(&base64)?;
    let path = Path::new(&path);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    fs::write(path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 「在访达中显示」导出好的文件。
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_canonical_vectors() {
        // RFC 4648 §10 的测试向量，逐个长度覆盖三种填充情况
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("Zg==").unwrap(), b"f");
        assert_eq!(decode_base64("Zm8=").unwrap(), b"fo");
        assert_eq!(decode_base64("Zm9v").unwrap(), b"foo");
        assert_eq!(decode_base64("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(decode_base64("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(decode_base64("Zm9vYmFy").unwrap(), b"foobar");
    }

    /// xlsx 是 ZIP，头四字节必须是 PK\x03\x04 —— 高位字节被截掉的解码 bug
    /// 在纯文本向量上看不出来，但会让 Excel 直接拒绝打开文件。
    #[test]
    fn decodes_high_bytes_intact() {
        // "PK\x03\x04\x14\x00" 的 base64
        assert_eq!(
            decode_base64("UEsDBBQA").unwrap(),
            vec![0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]
        );
        // 全 1 字节，任何一处移位错误都会露馅
        assert_eq!(decode_base64("////").unwrap(), vec![0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn tolerates_line_breaks_and_rejects_garbage() {
        assert_eq!(decode_base64("Zm9v\nYmFy").unwrap(), b"foobar");
        assert!(decode_base64("Zm9v!").is_err());
        assert!(decode_base64("Zm9vY").is_err(), "余 1 个字符不是合法编码");
    }

    /// 编码器和解码器必须互为逆运算。
    #[test]
    fn base64_round_trips() {
        for vec in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            assert_eq!(decode_base64(&encode_base64(vec.as_bytes())).unwrap(), vec.as_bytes());
        }
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(encode_base64(b"f"), "Zg==");

        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(decode_base64(&encode_base64(&all)).unwrap(), all);
    }

    #[test]
    fn writes_bytes_to_disk() {
        let dir = std::env::temp_dir().join("gantt-export-test");
        let _ = fs::remove_dir_all(&dir);
        // 目录故意不预先创建，验证 write_export 会自己补出来
        let path = dir.join("nested").join("out.bin");

        write_export(
            path.to_string_lossy().into_owned(),
            "UEsDBBQA".into(),
        )
        .unwrap();

        assert_eq!(
            fs::read(&path).unwrap(),
            vec![0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
