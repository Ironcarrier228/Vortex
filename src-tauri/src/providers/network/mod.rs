//! Сетевой провайдер: связка «процесс ↔ соединение» через IP Helper API.
//!
//! Что даёт `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` и `GetExtendedUdpTable`:
//! полный список сокетов с PID владельца, без прав администратора (в отличие от ETW).
//!
//! Что **не** даёт: объём трафика. Байты по процессам появятся на этапе 3 через ETW
//! (`Microsoft-Windows-Kernel-Network`, требует админа) — структура события уже готова
//! (`bytesSent`/`bytesRecv`), фронтенд рисует интенсивность по разнице снимков.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::events::{EndpointPayload, NetConnectionPayload, NetSnapshotPayload};
use vortex_core::netdiff::{ConnDiff, ConnDiffState, ConnKey};

/// Одна строка таблицы соединений (уже разобранная, без Win32-типов).
#[derive(Clone, Debug)]
pub struct ConnectionRow {
    /// 6 = TCP, 17 = UDP.
    pub proto: u8,
    pub pid: u32,
    pub local_ip: String,
    pub local_port: u16,
    pub remote_ip: String,
    pub remote_port: u16,
    /// TCP-состояние (`MIB_TCP_STATE`), для UDP — 0.
    pub state: u32,
}

impl ConnectionRow {
    pub fn proto_name(&self) -> &'static str {
        if self.proto == 17 {
            "udp"
        } else {
            "tcp"
        }
    }

    pub fn id(&self) -> String {
        conn_id(self.proto_name(), self.pid, self.local_port, &self.remote_ip, self.remote_port)
    }

    pub fn key(&self) -> ConnKey {
        ConnKey::new(
            self.proto,
            self.pid,
            self.local_port,
            self.remote_ip.clone(),
            self.remote_port,
        )
    }
}

/// Идентификатор соединения. Формат обязан совпадать с `src/scenes/network/ids.ts` во фронтенде.
pub fn conn_id(proto: &str, pid: u32, local_port: u16, remote_ip: &str, remote_port: u16) -> String {
    format!("{proto}:{pid}:{local_port}:{remote_ip}:{remote_port}")
}

/// Кэш имён процессов: запрос пути к .exe не бесплатный, а PID'ы повторяются.
pub struct ProcCache {
    entries: HashMap<u32, (String, Option<String>, Instant)>,
    ttl: Duration,
}

impl ProcCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            ttl: Duration::from_secs(30),
        }
    }

    /// Вернуть (отображаемое имя, полный путь).
    pub fn resolve(&mut self, pid: u32) -> (String, Option<String>) {
        if let Some((name, path, at)) = self.entries.get(&pid) {
            if at.elapsed() < self.ttl {
                return (name.clone(), path.clone());
            }
        }

        let path = crate::providers::winapi::process_path(pid);
        let name = match &path {
            Some(p) => {
                let stem = std::path::Path::new(p)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                if stem.is_empty() {
                    format!("PID {pid}")
                } else {
                    stem
                }
            }
            None => format!("PID {pid}"),
        };
        self.entries
            .insert(pid, (name.clone(), path.clone(), Instant::now()));

        // Раз в 30 секунд подчищаем «мёртвые» PID'ы, чтобы кэш не рос бесконечно.
        if self.entries.len() > 512 {
            let ttl = self.ttl;
            self.entries.retain(|_, (_, _, at)| at.elapsed() < ttl * 4);
        }
        (name, path)
    }
}

impl Default for ProcCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Имена TCP-состояний из `MIB_TCP_STATE`.
pub fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "-",
    }
}

/// Снимок таблицы соединений + дельта относительно прошлого опроса.
pub fn snapshot(
    cache: &mut ProcCache,
    diff_state: &mut ConnDiffState,
    elevated: bool,
) -> NetSnapshotPayload {
    let rows = collect_rows();
    let diff: ConnDiff = diff_state.update(rows.iter().map(|r| r.key()));

    let mut connections: Vec<NetConnectionPayload> = Vec::with_capacity(rows.len());
    for row in &rows {
        let (process, exe_path) = cache.resolve(row.pid);
        connections.push(NetConnectionPayload {
            id: row.id(),
            protocol: row.proto_name().to_string(),
            pid: row.pid,
            process,
            exe_path,
            local: EndpointPayload {
                ip: row.local_ip.clone(),
                port: row.local_port,
                host: None,
                country: None,
                city: None,
                lat: None,
                lon: None,
                asn: None,
            },
            remote: EndpointPayload {
                ip: row.remote_ip.clone(),
                port: row.remote_port,
                host: None,
                country: None,
                city: None,
                lat: None,
                lon: None,
                asn: None,
            },
            state: if row.proto == 6 {
                tcp_state_name(row.state).to_string()
            } else {
                "-".to_string()
            },
            bytes_sent: None,
            bytes_recv: None,
        });
    }

    // Стабильный порядок: фронтенд переиспользует объекты сцены по id.
    connections.sort_by(|a, b| {
        a.process
            .to_lowercase()
            .cmp(&b.process.to_lowercase())
            .then(a.id.cmp(&b.id))
    });

    NetSnapshotPayload {
        connections,
        elevated,
        etw_active: false,
        added: diff.added.iter().map(key_to_id).collect(),
        removed: diff.removed.iter().map(key_to_id).collect(),
    }
}

fn key_to_id(key: &ConnKey) -> String {
    conn_id(
        if key.proto == 17 { "udp" } else { "tcp" },
        key.pid,
        key.local_port,
        &key.remote_ip,
        key.remote_port,
    )
}

/* ───────────────────────── Windows: чтение таблиц ───────────────────────── */

#[cfg(windows)]
fn collect_rows() -> Vec<ConnectionRow> {
    let mut rows = Vec::with_capacity(256);
    unsafe {
        if let Some(buf) = fetch_table(true, win::AF_INET) {
            parse_tcp_v4(&buf, &mut rows);
        }
        if let Some(buf) = fetch_table(true, win::AF_INET6) {
            parse_tcp_v6(&buf, &mut rows);
        }
        if let Some(buf) = fetch_table(false, win::AF_INET) {
            parse_udp_v4(&buf, &mut rows);
        }
        if let Some(buf) = fetch_table(false, win::AF_INET6) {
            parse_udp_v6(&buf, &mut rows);
        }
    }
    rows
}

#[cfg(not(windows))]
fn collect_rows() -> Vec<ConnectionRow> {
    Vec::new()
}

#[cfg(windows)]
mod win {
    use super::ConnectionRow;
    use std::net::{Ipv4Addr, Ipv6Addr};

    pub const AF_INET: u32 = 2;
    pub const AF_INET6: u32 = 23;
    pub const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
    pub const UDP_TABLE_OWNER_PID: u32 = 1;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MibTcpRowOwnerPid {
        pub state: u32,
        pub local_addr: u32,
        pub local_port: u32,
        pub remote_addr: u32,
        pub remote_port: u32,
        pub owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MibTcp6RowOwnerPid {
        pub local_addr: [u8; 16],
        pub local_scope_id: u32,
        pub local_port: u32,
        pub remote_addr: [u8; 16],
        pub remote_scope_id: u32,
        pub remote_port: u32,
        pub state: u32,
        pub owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MibUdpRowOwnerPid {
        pub local_addr: u32,
        pub local_port: u32,
        pub owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MibUdp6RowOwnerPid {
        pub local_addr: [u8; 16],
        pub local_scope_id: u32,
        pub local_port: u32,
        pub owning_pid: u32,
    }

    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            table: *mut core::ffi::c_void,
            size: *mut u32,
            order: i32,
            af: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
        fn GetExtendedUdpTable(
            table: *mut core::ffi::c_void,
            size: *mut u32,
            order: i32,
            af: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
    }

    /// Забрать таблицу целиком: первый вызов узнаёт размер, второй — читает.
    pub unsafe fn fetch_table(tcp: bool, af: u32) -> Option<Vec<u8>> {
        let class = if tcp {
            TCP_TABLE_OWNER_PID_ALL
        } else {
            UDP_TABLE_OWNER_PID
        };
        let mut size: u32 = 0;
        let probe = if tcp {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                af,
                class,
                0,
            )
        } else {
            GetExtendedUdpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                af,
                class,
                0,
            )
        };
        if probe != ERROR_INSUFFICIENT_BUFFER && probe != 0 {
            return None;
        }
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let code = if tcp {
            GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                &mut size,
                0,
                af,
                class,
                0,
            )
        } else {
            GetExtendedUdpTable(
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                &mut size,
                0,
                af,
                class,
                0,
            )
        };
        if code != 0 {
            return None;
        }
        Some(buf)
    }

    /// Адреса и порты в таблицах лежат в сетевом порядке байт.
    pub fn ipv4_text(raw: u32) -> String {
        let addr = Ipv4Addr::from(u32::from_be(raw));
        if addr.is_unspecified() {
            "*".to_string()
        } else {
            addr.to_string()
        }
    }

    pub fn ipv6_text(raw: &[u8; 16], scope: u32) -> String {
        let addr = Ipv6Addr::from(*raw);
        if addr.is_unspecified() {
            return "*".to_string();
        }
        // fe80::/10 — link-local: без scope-id адрес неоднозначен.
        let link_local = raw[0] == 0xfe && (raw[1] & 0xc0) == 0x80;
        let text = addr.to_string();
        if scope != 0 && (link_local || addr.is_multicast()) {
            format!("{text}%{scope}")
        } else {
            text
        }
    }

    pub fn port(raw: u32) -> u16 {
        u16::from_be((raw & 0xFFFF) as u16)
    }

    pub unsafe fn rows_from<T: Copy>(buf: &[u8], mut f: impl FnMut(T)) {
        if buf.len() < 4 {
            return;
        }
        let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let stride = std::mem::size_of::<T>();
        if stride == 0 {
            return;
        }
        for index in 0..count {
            let offset = 4 + index * stride;
            if offset + stride > buf.len() {
                break; // таблица «поехала» — прекращаем разбор вместо чтения за границей
            }
            let row = std::ptr::read_unaligned(buf.as_ptr().add(offset) as *const T);
            f(row);
        }
    }

    impl From<MibTcpRowOwnerPid> for ConnectionRow {
        fn from(r: MibTcpRowOwnerPid) -> Self {
            ConnectionRow {
                proto: 6,
                pid: r.owning_pid,
                local_ip: ipv4_text(r.local_addr),
                local_port: port(r.local_port),
                remote_ip: ipv4_text(r.remote_addr),
                remote_port: port(r.remote_port),
                state: r.state,
            }
        }
    }

    impl From<MibTcp6RowOwnerPid> for ConnectionRow {
        fn from(r: MibTcp6RowOwnerPid) -> Self {
            ConnectionRow {
                proto: 6,
                pid: r.owning_pid,
                local_ip: ipv6_text(&r.local_addr, r.local_scope_id),
                local_port: port(r.local_port),
                remote_ip: ipv6_text(&r.remote_addr, r.remote_scope_id),
                remote_port: port(r.remote_port),
                state: r.state,
            }
        }
    }

    impl From<MibUdpRowOwnerPid> for ConnectionRow {
        fn from(r: MibUdpRowOwnerPid) -> Self {
            ConnectionRow {
                proto: 17,
                pid: r.owning_pid,
                local_ip: ipv4_text(r.local_addr),
                local_port: port(r.local_port),
                remote_ip: String::new(),
                remote_port: 0,
                state: 0,
            }
        }
    }

    impl From<MibUdp6RowOwnerPid> for ConnectionRow {
        fn from(r: MibUdp6RowOwnerPid) -> Self {
            ConnectionRow {
                proto: 17,
                pid: r.owning_pid,
                local_ip: ipv6_text(&r.local_addr, r.local_scope_id),
                local_port: port(r.local_port),
                remote_ip: String::new(),
                remote_port: 0,
                state: 0,
            }
        }
    }
}

#[cfg(windows)]
use win::{MibTcp6RowOwnerPid, MibTcpRowOwnerPid, MibUdp6RowOwnerPid, MibUdpRowOwnerPid};

#[cfg(windows)]
unsafe fn fetch_table(tcp: bool, af: u32) -> Option<Vec<u8>> {
    win::fetch_table(tcp, af)
}

#[cfg(windows)]
fn parse_tcp_v4(buf: &[u8], out: &mut Vec<ConnectionRow>) {
    unsafe {
        win::rows_from::<MibTcpRowOwnerPid>(buf, |row| out.push(row.into()));
    }
}

#[cfg(windows)]
fn parse_tcp_v6(buf: &[u8], out: &mut Vec<ConnectionRow>) {
    unsafe {
        win::rows_from::<MibTcp6RowOwnerPid>(buf, |row| out.push(row.into()));
    }
}

#[cfg(windows)]
fn parse_udp_v4(buf: &[u8], out: &mut Vec<ConnectionRow>) {
    unsafe {
        win::rows_from::<MibUdpRowOwnerPid>(buf, |row| out.push(row.into()));
    }
}

#[cfg(windows)]
fn parse_udp_v6(buf: &[u8], out: &mut Vec<ConnectionRow>) {
    unsafe {
        win::rows_from::<MibUdp6RowOwnerPid>(buf, |row| out.push(row.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_id_is_stable_and_matches_frontend_format() {
        let row = ConnectionRow {
            proto: 6,
            pid: 1234,
            local_ip: "10.0.0.5".into(),
            local_port: 51000,
            remote_ip: "142.250.0.14".into(),
            remote_port: 443,
            state: 5,
        };
        assert_eq!(row.id(), "tcp:1234:51000:142.250.0.14:443");
        assert_eq!(row.proto_name(), "tcp");
    }

    #[test]
    fn tcp_states_are_named() {
        assert_eq!(tcp_state_name(5), "ESTABLISHED");
        assert_eq!(tcp_state_name(2), "LISTEN");
        assert_eq!(tcp_state_name(999), "-");
    }

    #[test]
    fn udp_rows_have_no_remote() {
        let row = ConnectionRow {
            proto: 17,
            pid: 4,
            local_ip: "0.0.0.0".into(),
            local_port: 5353,
            remote_ip: String::new(),
            remote_port: 0,
            state: 0,
        };
        assert_eq!(row.proto_name(), "udp");
        assert_eq!(row.id(), "udp:4:5353::0");
    }
}
