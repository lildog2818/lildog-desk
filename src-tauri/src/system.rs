//! 系统状态后端：主音量控制（WASAPI IAudioEndpointVolume）。
//! 网络状态查询在后续提交中加入本模块。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    /// 主音量 0.0..1.0
    pub volume: f64,
    pub muted: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::AudioState;

    use windows::Win32::Media::Audio::{
        Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator, eConsole,
        eRender,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };

    /// 每次调用独立初始化 COM（与 icons.rs 同模式），拿默认渲染端点音量接口
    fn with_endpoint<T>(
        f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<T>,
    ) -> windows::core::Result<T> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let ep: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?;
            f(&ep)
        }
    }

    pub(super) fn audio_state() -> Result<AudioState, String> {
        with_endpoint(|ep| unsafe {
            let v = ep.GetMasterVolumeLevelScalar()?;
            let m = ep.GetMute()?;
            Ok(AudioState {
                volume: (v as f64).clamp(0.0, 1.0),
                muted: m.as_bool(),
            })
        })
        .map_err(|e| e.to_string())
    }

    pub(super) fn set_volume(v: f64) -> Result<(), String> {
        let v = v.clamp(0.0, 1.0) as f32;
        with_endpoint(|ep| unsafe { ep.SetMasterVolumeLevelScalar(v, std::ptr::null()) })
            .map_err(|e| e.to_string())
    }

    pub(super) fn set_mute(mute: bool) -> Result<(), String> {
        with_endpoint(|ep| unsafe { ep.SetMute(mute, std::ptr::null()) })
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::AudioState;

    pub(super) fn audio_state() -> Result<AudioState, String> {
        Ok(AudioState { volume: 0.5, muted: false })
    }
    pub(super) fn set_volume(_v: f64) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn set_mute(_mute: bool) -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub async fn get_audio_state() -> Result<AudioState, String> {
    imp::audio_state()
}

#[tauri::command]
pub async fn set_audio_volume(volume: f64) -> Result<(), String> {
    imp::set_volume(volume)
}

#[tauri::command]
pub async fn set_audio_mute(mute: bool) -> Result<(), String> {
    imp::set_mute(mute)
}
