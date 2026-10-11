//! Дифференцирование снимков таблицы соединений.
//!
//! IP Helper API отдаёт «плоский» список сокетов. Чтобы рисовать импульсы по рёбрам
//! 3D-графа (новое соединение → вспышка), нужно знать, что появилось и что исчезло
//! между опросами. Здесь только эта логика — она прекрасно тестируется без Windows.

use std::collections::HashSet;

/// Ключ соединения: уникален в пределах снимка.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnKey {
    /// 6 = TCP, 17 = UDP (как в IPPROTO_*).
    pub proto: u8,
    pub pid: u32,
    pub local_port: u16,
    /// Пустая строка для UDP (у него нет удалённой стороны).
    pub remote_ip: String,
    pub remote_port: u16,
}

impl ConnKey {
    pub fn new(proto: u8, pid: u32, local_port: u16, remote_ip: impl Into<String>, remote_port: u16) -> Self {
        Self {
            proto,
            pid,
            local_port,
            remote_ip: remote_ip.into(),
            remote_port,
        }
    }
}

/// Что изменилось между двумя снимками.
#[derive(Clone, Debug, Default)]
pub struct ConnDiff {
    pub added: Vec<ConnKey>,
    pub removed: Vec<ConnKey>,
    /// Сколько соединений в текущем снимке.
    pub total: usize,
}

impl ConnDiff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

/// Состояние между опросами.
#[derive(Default)]
pub struct ConnDiffState {
    known: HashSet<ConnKey>,
    polls: u64,
}

impl ConnDiffState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Первый снимок считается «всё новое» — это удобно: сцена сразу получает материал
    /// для анимации появления узлов.
    pub fn update(&mut self, current: impl IntoIterator<Item = ConnKey>) -> ConnDiff {
        let next: HashSet<ConnKey> = current.into_iter().collect();
        let mut added: Vec<ConnKey> = next.difference(&self.known).cloned().collect();
        let mut removed: Vec<ConnKey> = self.known.difference(&next).cloned().collect();
        added.sort();
        removed.sort();
        self.known = next;
        self.polls += 1;
        ConnDiff {
            added,
            removed,
            total: self.known.len(),
        }
    }

    pub fn polls(&self) -> u64 {
        self.polls
    }

    pub fn len(&self) -> usize {
        self.known.len()
    }

    pub fn is_empty(&self) -> bool {
        self.known.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(port: u16, ip: &str) -> ConnKey {
        ConnKey::new(6, 1234, port, ip, 443)
    }

    #[test]
    fn first_snapshot_marks_everything_as_new() {
        let mut st = ConnDiffState::new();
        let d = st.update([key(1, "1.1.1.1"), key(2, "8.8.8.8")]);
        assert_eq!(d.added.len(), 2);
        assert!(d.removed.is_empty());
        assert_eq!(d.total, 2);
    }

    #[test]
    fn identical_snapshot_is_a_noop() {
        let mut st = ConnDiffState::new();
        st.update([key(1, "1.1.1.1")]);
        let d = st.update([key(1, "1.1.1.1")]);
        assert!(d.is_empty());
        assert_eq!(d.total, 1);
    }

    #[test]
    fn detects_additions_and_removals() {
        let mut st = ConnDiffState::new();
        st.update([key(1, "1.1.1.1"), key(2, "8.8.8.8")]);
        let d = st.update([key(2, "8.8.8.8"), key(3, "9.9.9.9")]);
        assert_eq!(d.added, vec![key(3, "9.9.9.9")]);
        assert_eq!(d.removed, vec![key(1, "1.1.1.1")]);
        assert_eq!(d.total, 2);
    }

    #[test]
    fn udp_without_remote_is_a_valid_key() {
        let mut st = ConnDiffState::new();
        let udp = ConnKey::new(17, 99, 5353, "", 0);
        let d = st.update([udp.clone()]);
        assert_eq!(d.added, vec![udp]);
        assert_eq!(st.polls(), 1);
    }
}
