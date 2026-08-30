pub mod dto;
pub mod fonts;
pub mod fs;
pub mod grammar;
pub mod index;
mod library;
#[cfg(target_os = "macos")]
mod macspell;
pub mod pdf;
pub mod spell;
pub mod watch;
pub mod writingtools;

use std::sync::Mutex;

use crate::dto::RootInfo;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder};
#[cfg(desktop)]
use tauri::{Emitter, Runtime};

/// The open folders, in the order they were opened.
///
/// This lives here rather than in either module because both need it and neither owns the other:
/// `fs` puts roots in and takes them out, `watch` only ever turns an id back into a path. It is the
/// in-memory copy of the list; persisting it across a relaunch is `fs`'s business.
#[derive(Default)]
pub struct Roots(pub Mutex<Vec<RootInfo>>);

impl Roots {
    /// The absolute path of an open root. Every command that takes a `rootId` needs this before it
    /// can touch anything, and an id that is not open is an error rather than an empty result.
    pub fn path_for(&self, id: &str) -> Result<String, String> {
        let roots = self.0.lock().map_err(|e| e.to_string())?;
        roots
            .iter()
            .find(|root| root.id == id)
            .map(|root| root.path.clone())
            .ok_or_else(|| format!("no such root: {id}"))
    }
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;

    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let new_doc = MenuItemBuilder::with_id("new-doc", "New Document")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let new_folder = MenuItemBuilder::with_id("new-folder", "New Folder").build(handle)?;
    let quick_open = MenuItemBuilder::with_id("quick-open", "Quick Open…")
        .accelerator("CmdOrCtrl+P")
        .build(handle)?;
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
        .accelerator("CmdOrCtrl+K")
        .build(handle)?;
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(handle)?;
    let export_pdf = MenuItemBuilder::with_id("export-pdf", "Export as PDF…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(handle)?;
    let close_folder = MenuItemBuilder::with_id("close-folder", "Close Folder").build(handle)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(handle)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;
    let find = MenuItemBuilder::with_id("find", "Find…")
        .accelerator("CmdOrCtrl+F")
        .build(handle)?;
    let find_in_files = MenuItemBuilder::with_id("find-in-files", "Find in Files…")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(handle)?;
    let report_issue =
        MenuItemBuilder::with_id("report-issue", "Report an Issue…").build(handle)?;

    let submenus: Vec<_> = menu
        .items()?
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .collect();

    let find_submenu = |name: &str| {
        submenus
            .iter()
            .find(|submenu| submenu.text().map(|t| t == name).unwrap_or(false))
            .cloned()
    };

    match find_submenu("File") {
        Some(submenu) => {
            submenu.prepend_items(&[
                &open_folder,
                &new_doc,
                &new_folder,
                &PredefinedMenuItem::separator(handle)?,
                &quick_open,
                &command_palette,
                &PredefinedMenuItem::separator(handle)?,
                &save,
                &export_pdf,
                &PredefinedMenuItem::separator(handle)?,
                &close_folder,
                &PredefinedMenuItem::separator(handle)?,
            ])?;
        }
        None => {
            let submenu = SubmenuBuilder::new(handle, "File")
                .item(&open_folder)
                .item(&new_doc)
                .item(&new_folder)
                .item(&PredefinedMenuItem::separator(handle)?)
                .item(&quick_open)
                .item(&command_palette)
                .item(&PredefinedMenuItem::separator(handle)?)
                .item(&save)
                .item(&export_pdf)
                .item(&PredefinedMenuItem::separator(handle)?)
                .item(&close_folder)
                .build()?;
            menu.insert(&submenu, 1)?;
        }
    }

    if let Some(edit) = find_submenu("Edit") {
        edit.append_items(&[
            &PredefinedMenuItem::separator(handle)?,
            &find,
            &find_in_files,
        ])?;
    }

    if let Some(help) = find_submenu("Help") {
        help.append_items(&[&report_issue])?;
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(app_submenu) = submenus.first() {
            app_submenu.insert(&check_updates, 1)?;
            app_submenu.insert(&settings, 3)?;
            app_submenu.insert(&PredefinedMenuItem::separator(handle)?, 4)?;
        }
        // Writing Tools, which is the system's and needs macOS 15.1 with Apple Intelligence on.
        //
        // These two rows carry the chords and Apple's own Writing Tools rows deliberately do not,
        // which is the opposite of what the sibling app does. AppKit performs a key equivalent by
        // firing its menu item directly, so a chord on the system's row would reach Writing Tools
        // without passing the selection guard in src/editor/writing.ts, and that guard exists
        // because a rewrite spanning a link loses its address and one spanning two table cells
        // widens the table. These ids go through the command table, so they meet the guard.
        // Exactly one menu item owns each chord either way; this is which one.
        if let Some(edit) = find_submenu("Edit") {
            let proofread = MenuItemBuilder::with_id("writing-proofread", "Proofread")
                .accelerator("Shift+Alt+F")
                .build(handle)?;
            let rewrite = MenuItemBuilder::with_id("writing-rewrite", "Rewrite")
                .accelerator("Shift+Alt+R")
                .build(handle)?;
            edit.append_items(&[
                &PredefinedMenuItem::separator(handle)?,
                &proofread,
                &rewrite,
            ])?;
        }
        if let Some(view) = find_submenu("View") {
            let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+\\")
                .build(handle)?;
            view.prepend_items(&[&toggle_sidebar, &PredefinedMenuItem::separator(handle)?])?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(file) = find_submenu("File") {
            file.append_items(&[&PredefinedMenuItem::separator(handle)?, &check_updates])?;
        }
        if let Some(edit) = find_submenu("Edit") {
            edit.append_items(&[&settings])?;
        }
    }

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Roots::default())
        .manage(watch::Watchers::default())
        .manage(index::Index::default());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_process::init());
        if context.config().plugins.0.contains_key("updater") {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    builder = builder.setup(|app| {
        if let Err(e) = library::app_data_dir(app.handle()) {
            eprintln!("failed to prepare app data dir: {e}");
        }
        // The index is opened here rather than lazily on the first search, because opening it is
        // where a schema migration runs and a migration that fails should say so at launch rather
        // than the first time somebody presses Cmd+P. A failure is not fatal: the app is a text
        // editor with a broken search box, which is worth far more than a window that will not
        // open.
        if let Err(e) = index::open(app.handle()) {
            eprintln!("failed to open the search index: {e}");
        }
        // The Writing Tools submenu is AppKit's, not build_menu's: the system inserts it into Edit
        // on its own terms, so when it is there to label is writingtools.rs's problem and not this
        // file's. One call, whatever it decides to wait for.
        writingtools::install(app.handle());
        Ok(())
    });

    #[cfg(desktop)]
    {
        builder = builder
            .menu(|handle| build_menu(handle))
            .on_menu_event(|app, event| {
                if matches!(
                    event.id().0.as_str(),
                    "open-folder"
                        | "new-doc"
                        | "new-folder"
                        | "save"
                        | "close-folder"
                        | "settings"
                        | "find"
                        | "find-in-files"
                        | "quick-open"
                        | "command-palette"
                        | "toggle-sidebar"
                        | "check-updates"
                        | "report-issue"
                        | "export-pdf"
                        | "writing-proofread"
                        | "writing-rewrite"
                ) {
                    app.emit("menu-action", event.id().0.as_str()).ok();
                }
            });
    }

    // The whole command surface, in the order dto.rs describes it. Registering a command is this
    // file's job alone: a module adds a body, never a line here.
    builder
        .invoke_handler(tauri::generate_handler![
            fs::roots_list,
            fs::root_open,
            fs::root_close,
            fs::tree_read,
            fs::sweep_documents,
            fs::reveal_in_finder,
            fs::open_external,
            fs::file_read,
            fs::file_write,
            fs::file_create,
            fs::file_folder_create,
            fs::file_rename,
            fs::file_move,
            fs::file_duplicate,
            fs::file_trash,
            fs::asset_write,
            watch::watch_start,
            watch::watch_stop,
            fs::index_rebuild,
            fs::index_status,
            fs::search_quick_open,
            fs::search_text,
            fs::backlinks_for,
            spell::spell_check,
            spell::spell_learn,
            spell::spell_unlearn,
            spell::spell_available,
            writingtools::writing_available,
            writingtools::writing_run,
            pdf::pdf_compile,
            pdf::pdf_write,
            grammar::grammar_available,
            grammar::grammar_check,
            fonts::fonts_list_system,
        ])
        .run(context)
        .expect("error while running Margin Docs");
}
