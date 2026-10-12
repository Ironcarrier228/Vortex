//! Сборка дерева каталогов из потока записей, который отдаёт сканер (jwalk или MFT).
//!
//! Сканер обходит диск параллельно, поэтому записи приходят «вразнобой» по глубине.
//! Здесь мы:
//! * приводим их к плоскому массиву узлов с индексами-родителями (удобно гонять во фронтенд);
//! * достраиваем промежуточные каталоги, если их ещё не прислали;
//! * один раз (в конце) аккумулируем размеры и число файлов снизу вверх.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Узел дерева. Плоский вид выбран специально: во фронтенде это типизированные массивы,
/// по которым строятся InstancedMesh без лишних аллокаций.
#[derive(Clone, Debug)]
pub struct DiskNode {
    pub id: usize,
    pub parent: usize,
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    /// Для каталога — сумма размеров поддерева (после `finalize`).
    pub size: u64,
    /// Для каталога — число файлов в поддереве (после `finalize`).
    pub files: u32,
    /// Расширение файла в нижнем регистре (пусто для каталогов).
    pub ext: String,
    /// Время изменения, мс от Unix epoch.
    pub modified: Option<u64>,
}

/// Крупные «корзины» для окраски зданий/сегментов.
pub fn categorize(ext: &str) -> &'static str {
    match ext {
        "mp4" | "mkv" | "avi" | "mov" | "webm" | "wmv" | "flv" | "m4v" => "video",
        "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "wma" => "audio",
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "tiff" | "psd" | "raw" => "image",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "c" | "cpp" | "h" | "hpp" | "cs" | "java"
        | "go" | "rb" | "php" | "sh" | "ps1" | "lua" | "kt" | "swift" | "html" | "css" | "json"
        | "toml" | "yaml" | "yml" => "code",
        "zip" | "7z" | "rar" | "tar" | "gz" | "xz" | "bz2" | "iso" | "cab" => "archive",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "csv" => "docs",
        "exe" | "dll" | "sys" | "msi" | "bat" | "cmd" | "com" | "so" | "lib" => "system",
        "dmp" | "log" | "tmp" | "cache" => "junk",
        "" => "other",
        _ => "other",
    }
}

/// Расширение из имени файла (нижний регистр, без точки). `.env` → "env".
pub fn extension_of(name: &str) -> String {
    match name.rsplit_once('.') {
        // Стебель не нужен: важно только расширение после последней точки.
        Some((_, ext)) if !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Инкрементальный сборщик дерева. Использование:
/// ```no_run
/// # use std::path::Path;
/// # use vortex_core::disk::TreeBuilder;
/// let mut b = TreeBuilder::new(Path::new("C:\\"));
/// b.insert(Path::new("C:\\Windows\\System32\\notepad.exe"), false, 340_992, None);
/// let nodes = b.finalize();
/// assert_eq!(nodes[0].files, 1);
/// ```
pub struct TreeBuilder {
    root: PathBuf,
    nodes: Vec<DiskNode>,
    index: HashMap<PathBuf, usize>,
    finalized: bool,
}

impl TreeBuilder {
    pub fn new(root: &Path) -> Self {
        let root = root.to_path_buf();
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        let root_node = DiskNode {
            id: 0,
            parent: 0,
            path: root.clone(),
            name,
            is_dir: true,
            size: 0,
            files: 0,
            ext: String::new(),
            modified: None,
        };
        let mut index = HashMap::new();
        index.insert(root.clone(), 0);
        Self {
            root,
            nodes: vec![root_node],
            index,
            finalized: false,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.len() <= 1
    }

    pub fn nodes(&self) -> &[DiskNode] {
        &self.nodes
    }

    pub fn is_finalized(&self) -> bool {
        self.finalized
    }

    /// Добавить запись сканера. Возвращает id узла или `None`, если путь вне корня
    /// (например, сканер случайно отдал ссылку за пределы сканируемого дерева).
    pub fn insert(
        &mut self,
        path: &Path,
        is_dir: bool,
        size: u64,
        modified: Option<u64>,
    ) -> Option<usize> {
        if path.strip_prefix(&self.root).is_err() {
            return None;
        }
        if let Some(&id) = self.index.get(path) {
            // Каталог мог быть создан заранее как «промежуточное звено» — уточняем данные.
            let node = &mut self.nodes[id];
            node.is_dir |= is_dir;
            if !node.is_dir {
                node.size = node.size.max(size);
            }
            if modified.is_some() {
                node.modified = modified;
            }
            return Some(id);
        }

        let parent_path = path.parent()?;
        let parent = if parent_path == self.root {
            0
        } else {
            self.ensure_dir(parent_path)?
        };

        let id = self.nodes.len();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        let ext = if is_dir {
            String::new()
        } else {
            extension_of(&name)
        };

        self.nodes.push(DiskNode {
            id,
            parent,
            path: path.to_path_buf(),
            name,
            is_dir,
            size,
            files: 0,
            ext,
            modified,
        });
        self.index.insert(path.to_path_buf(), id);
        Some(id)
    }

    /// Создаёт каталог-заглушку и всех его отсутствующих родителей.
    fn ensure_dir(&mut self, path: &Path) -> Option<usize> {
        if let Some(&id) = self.index.get(path) {
            return Some(id);
        }
        if path == self.root {
            return Some(0);
        }
        path.strip_prefix(&self.root).ok()?;

        let parent_path = path.parent()?;
        let parent = if parent_path == self.root {
            0
        } else {
            self.ensure_dir(parent_path)?
        };

        let id = self.nodes.len();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        self.nodes.push(DiskNode {
            id,
            parent,
            path: path.to_path_buf(),
            name,
            is_dir: true,
            size: 0,
            files: 0,
            ext: String::new(),
            modified: None,
        });
        self.index.insert(path.to_path_buf(), id);
        Some(id)
    }

    /// Аккумулирует размеры/файлы снизу вверх и возвращает готовый плоский список.
    ///
    /// Работает за один проход с конца массива: родитель всегда создаётся раньше детей,
    /// поэтому к моменту обработки узла все его потомки уже добавлены в него.
    pub fn finalize(&mut self) -> Vec<DiskNode> {
        for id in (1..self.nodes.len()).rev() {
            let (parent, size, files, is_dir) = {
                let n = &self.nodes[id];
                (n.parent, n.size, n.files, n.is_dir)
            };
            let files_add = if is_dir { files } else { 1 };
            let p = &mut self.nodes[parent];
            p.size = p.size.saturating_add(size);
            p.files = p.files.saturating_add(files_add);
        }
        self.finalized = true;
        self.nodes.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorizes_common_extensions() {
        assert_eq!(categorize("png"), "image");
        assert_eq!(categorize("mkv"), "video");
        assert_eq!(categorize("rs"), "code");
        assert_eq!(categorize("7z"), "archive");
        assert_eq!(categorize("pdf"), "docs");
        assert_eq!(categorize("dll"), "system");
        assert_eq!(categorize("qqq"), "other");
        assert_eq!(categorize(""), "other");
    }

    #[test]
    fn extension_parsing() {
        assert_eq!(extension_of("archive.tar.gz"), "gz");
        assert_eq!(extension_of(".env"), "env");
        assert_eq!(extension_of("noext"), "");
    }

    #[test]
    fn builds_tree_with_missing_intermediate_dirs() {
        let mut b = TreeBuilder::new(Path::new("/root"));
        // Сканер может прислать файл раньше каталога — родители достраиваются сами.
        let f1 = b.insert(Path::new("/root/a/b/c.bin"), false, 100, None).unwrap();
        let f2 = b.insert(Path::new("/root/a/b/d.bin"), false, 250, None).unwrap();
        let nodes = b.finalize();

        let c = &nodes[f1];
        assert_eq!(c.name, "c.bin");
        assert_eq!(c.ext, "bin");
        assert_eq!(nodes[c.parent].name, "b");
        assert_eq!(nodes[f2].size, 250);

        let dir_a = &nodes[0]; // корень (id 0)
        assert_eq!(dir_a.size, 350, "размер корня = сумма всех файлов");
        assert_eq!(dir_a.files, 2);

        let dir_b_id = nodes[f1].parent;
        assert_eq!(nodes[dir_b_id].size, 350);
        assert_eq!(nodes[dir_b_id].files, 2);
    }

    #[test]
    fn ignores_paths_outside_root() {
        let mut b = TreeBuilder::new(Path::new("/root"));
        assert!(b.insert(Path::new("/other/file.txt"), false, 1, None).is_none());
        assert!(b.is_empty());
    }

    #[test]
    fn dirs_sort_naturally_by_size() {
        let mut b = TreeBuilder::new(Path::new("/root"));
        for i in 0..10 {
            b.insert(
                Path::new(&format!("/root/big/f{i}.dat")),
                false,
                1000,
                None,
            );
        }
        b.insert(Path::new("/root/small/one.txt"), false, 10, None);
        let nodes = b.finalize();
        let big = nodes.iter().find(|n| n.name == "big").unwrap();
        let small = nodes.iter().find(|n| n.name == "small").unwrap();
        assert!(big.size > small.size);
        assert_eq!(big.files, 10);
    }
}
