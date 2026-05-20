use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceNode {
    path: String,
    name: String,
    #[serde(rename = "type")]
    node_type: String,
    children: Option<Vec<WorkspaceNode>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    root_path: String,
    root_name: String,
    nodes: Vec<WorkspaceNode>,
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())
}

fn build_tree(path: &Path) -> Result<WorkspaceNode, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if metadata.is_dir() {
        let mut children = fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|child| {
                child.file_name()
                    .map(|name| !name.to_string_lossy().starts_with('.'))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();

        children.sort_by(|a, b| {
            let a_is_dir = a.is_dir();
            let b_is_dir = b.is_dir();

            match b_is_dir.cmp(&a_is_dir) {
                std::cmp::Ordering::Equal => a
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(
                        &b.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase(),
                    ),
                ordering => ordering,
            }
        });

        let child_nodes = children
            .iter()
            .map(|child| build_tree(child))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(WorkspaceNode {
            path: path_to_string(path)?,
            name,
            node_type: "folder".to_string(),
            children: Some(child_nodes),
        })
    } else {
        Ok(WorkspaceNode {
            path: path_to_string(path)?,
            name,
            node_type: "file".to_string(),
            children: None,
        })
    }
}

fn unique_copy_path(original: &Path) -> PathBuf {
    let parent = original.parent().unwrap_or_else(|| Path::new(""));
    let stem = original
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Copy".to_string());
    let extension = original.extension().map(|value| value.to_string_lossy().to_string());

    for index in 1..=1000 {
        let suffix = if index == 1 {
            " Copy".to_string()
        } else {
            format!(" Copy {}", index)
        };

        let file_name = match &extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };

        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!("{stem}-copy"))
}

#[tauri::command]
fn pick_workspace() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Open Workspace Folder")
        .pick_folder();

    match folder {
        Some(path) => path_to_string(&path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn load_workspace(root_path: String) -> Result<WorkspaceSnapshot, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("Selected workspace is not a folder".to_string());
    }

    let root_node = build_tree(&root)?;

    Ok(WorkspaceSnapshot {
        root_path: root_path.clone(),
        root_name: root_node.name,
        nodes: root_node.children.unwrap_or_default(),
    })
}

#[tauri::command]
fn read_file_contents(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_file_contents(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    fs::write(path, "").map_err(|error| error.to_string())
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let parent = source
        .parent()
        .ok_or_else(|| "Cannot rename path without parent".to_string())?;
    let target = parent.join(new_name);

    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    path_to_string(&target)
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;

    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())
    } else {
        fs::remove_file(target).map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn duplicate_file(path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let target = unique_copy_path(&source);
    fs::copy(&source, &target).map_err(|error| error.to_string())?;
    path_to_string(&target)
}

#[tauri::command]
fn move_path(source_path: String, destination_folder_path: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let destination_folder = PathBuf::from(&destination_folder_path);
    let file_name = source
        .file_name()
        .ok_or_else(|| "Invalid source path".to_string())?;
    let target = destination_folder.join(file_name);

    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    path_to_string(&target)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            load_workspace,
            read_file_contents,
            write_file_contents,
            create_file,
            create_folder,
            rename_path,
            delete_path,
            duplicate_file,
            move_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
