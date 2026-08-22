use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use tauri::Manager;

pub fn cached_icon(app: &tauri::AppHandle, source: &str) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("icons");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut hasher = DefaultHasher::new();
    source.to_lowercase().hash(&mut hasher);
    let out = dir.join(format!("{:016x}.png", hasher.finish()));

    if !out.exists() {
        extract_icon(source, &out)?;
    }
    Ok(out.to_string_lossy().into_owned())
}

fn extract_icon(source: &str, out: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_ICONONLY,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok();

        let wpath: Vec<u16> = source
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(wpath.as_ptr()), None)
                .map_err(|e| format!("shell item: {e}"))?;

        let hbmp = factory
            .GetImage(SIZE { cx: 48, cy: 48 }, SIIGBF_ICONONLY)
            .map_err(|e| format!("get image: {e}"))?;

        let result = hbmp_to_png(hbmp, out);
        let _ = DeleteObject(hbmp.into());
        result
    }
}

unsafe fn hbmp_to_png(hbmp: windows::Win32::Graphics::Gdi::HBITMAP, out: &Path) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS,
    };

    if hbmp.is_invalid() {
        return Err("null bitmap".into());
    }

    let mut bmp = BITMAP::default();
    let got = GetObjectW(
        hbmp.into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    );
    if got == 0 || bmp.bmWidth == 0 || bmp.bmHeight == 0 {
        return Err("cannot read bitmap info".into());
    }
    let w = bmp.bmWidth as usize;
    let h = bmp.bmHeight.unsigned_abs() as usize;
    if w > 2048 || h > 2048 {
        return Err("bitmap too large".into());
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w as i32;
    bmi.bmiHeader.biHeight = -(h as i32);
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;

    let mut buf = vec![0u8; w * h * 4];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return Err("GetDIBits failed".into());
    }

    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let img =
        image::RgbaImage::from_raw(w as u32, h as u32, buf).ok_or("bitmap buffer mismatch")?;
    img.save(out).map_err(|e| e.to_string())
}
