//! 系统状态后端：主音量控制（WASAPI IAudioEndpointVolume）
//! 与网络状态查询（适配器枚举 + WLAN SSID）。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    /// 主音量 0.0..1.0
    pub volume: f64,
    pub muted: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    /// 是否有已连接（带网关）的适配器
    pub online: bool,
    /// "wifi" | "ethernet" | "none"
    pub kind: String,
    /// Wi-Fi 名（SSID）/ 适配器名；未连接为空串
    pub name: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{AudioState, NetworkStatus};

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

    // ---------------- 网络状态 ----------------

    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_TYPE_IEEE80211: u32 = 71;
    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    /// 枚举已启用的物理适配器：(友好名, IfType, 是否有网关)
    fn up_adapters() -> Vec<(String, u32, bool)> {
        use windows::Win32::NetworkManagement::IpHelper::{
            GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
            GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
        };
        use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
        use windows::Win32::Networking::WinSock::AF_UNSPEC;

        let flags = GAA_FLAG_INCLUDE_GATEWAYS
            | GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size: u32 = 16 * 1024;
        let mut buf: Vec<u8> = vec![0u8; size as usize];
        for _ in 0..3 {
            let rc = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC.0 as u32,
                    flags,
                    None,
                    Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                    &mut size,
                )
            };
            if rc == 0 {
                break;
            }
            if rc != ERROR_BUFFER_OVERFLOW {
                return Vec::new();
            }
            buf.resize(size as usize, 0);
        }

        let mut out = Vec::new();
        let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !p.is_null() {
            let a = unsafe { &*p };
            if a.OperStatus == IfOperStatusUp && a.IfType != IF_TYPE_SOFTWARE_LOOPBACK {
                let name = unsafe {
                    a.FriendlyName.to_string().unwrap_or_default()
                };
                out.push((name, a.IfType, !a.FirstGatewayAddress.is_null()));
            }
            p = a.Next;
        }
        out
    }

    /// 查询当前已连接 WLAN 接口的 SSID（未连接返回 None）
    fn wlan_ssid() -> Option<String> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::NetworkManagement::WiFi::{
            WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle,
            WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
            wlan_intf_opcode_current_connection,
        };

        unsafe {
            let mut handle = HANDLE::default();
            let mut version = 0u32;
            if WlanOpenHandle(2, None, &mut version, &mut handle) != 0 {
                return None;
            }
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(handle, None, &mut list) != 0 || list.is_null() {
                let _ = WlanCloseHandle(handle, None);
                return None;
            }

            let mut ssid: Option<String> = None;
            let count = (*list).dwNumberOfItems;
            for i in 0..count {
                let info = &(*list).InterfaceInfo[i as usize];
                let mut data_size = 0u32;
                let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
                if WlanQueryInterface(
                    handle,
                    &info.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    None,
                    &mut data_size,
                    &mut data,
                    None,
                ) == 0
                    && !data.is_null()
                {
                    let attrs = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                    let len =
                        attrs.wlanAssociationAttributes.dot11Ssid.uSSIDLength as usize;
                    if len > 0 && len <= 32 {
                        ssid = Some(
                            String::from_utf8_lossy(
                                &attrs.wlanAssociationAttributes.dot11Ssid.ucSSID[..len],
                            )
                            .trim_end_matches('\0')
                            .to_string(),
                        );
                    }
                    WlanFreeMemory(data);
                }
                if ssid.is_some() {
                    break;
                }
            }
            WlanFreeMemory(list as _);
            let _ = WlanCloseHandle(handle, None);
            ssid
        }
    }

    pub(super) fn network_status() -> NetworkStatus {
        let adapters = up_adapters();
        // 优先取有网关（真正在线）的适配器；Wi-Fi 优先展示
        let connected: Vec<&(String, u32, bool)> = adapters
            .iter()
            .filter(|(_, _, gw)| *gw)
            .collect();
        let pick = connected
            .iter()
            .find(|(_, t, _)| *t == IF_TYPE_IEEE80211)
            .or_else(|| connected.iter().find(|(_, t, _)| *t != IF_TYPE_IEEE80211));

        match pick {
            Some((name, if_type, _)) => {
                let kind = if *if_type == IF_TYPE_IEEE80211 {
                    "wifi"
                } else {
                    "ethernet"
                };
                let display = if kind == "wifi" {
                    wlan_ssid().unwrap_or_else(|| name.clone())
                } else {
                    name.clone()
                };
                NetworkStatus {
                    online: true,
                    kind: kind.to_string(),
                    name: display,
                }
            }
            None => NetworkStatus {
                online: false,
                kind: "none".to_string(),
                name: String::new(),
            },
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AudioState, NetworkStatus};

    pub(super) fn audio_state() -> Result<AudioState, String> {
        Ok(AudioState { volume: 0.5, muted: false })
    }
    pub(super) fn set_volume(_v: f64) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn set_mute(_mute: bool) -> Result<(), String> {
        Ok(())
    }
    pub(super) fn network_status() -> NetworkStatus {
        NetworkStatus {
            online: false,
            kind: "none".to_string(),
            name: String::new(),
        }
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

#[tauri::command]
pub async fn get_network_status() -> NetworkStatus {
    imp::network_status()
}
