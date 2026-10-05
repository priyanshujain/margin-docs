pub mod dto;
pub mod fonts;
pub mod fs;
pub mod grammar;
pub mod index;
pub mod integration;
mod library;
#[cfg(target_os = "macos")]
mod macspell;
pub mod pdf;
pub mod spell;
pub mod titlebar;
pub mod watch;
pub mod windows;
pub mod writingtools;

use std::sync::Mutex;

use crate::dto::RootInfo;

#[cfg(desktop)]
use tauri::menu::{
    AboutMetadata, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
#[cfg(desktop)]
use tauri::Runtime;

#[cfg(desktop)]
use tauri::Manager;

/// The folders open in any window, in the order they were opened. Which window holds which is
/// `windows::Windows`' business; a folder open in two windows is one entry here, one watcher and one
/// set of index rows.
///
/// This lives here rather than in either module because both need it and neither owns the other:
/// `fs` puts roots in and takes them out, `watch` only ever turns an id back into a path.
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

    pub fn paths_for(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let roots = self.0.lock().map_err(|e| e.to_string())?;
        Ok(roots
            .iter()
            .filter(|root| ids.contains(&root.id))
            .map(|root| root.path.clone())
            .collect())
    }
}

/// Menu items whose action belongs to whichever window the user is in.
#[cfg(desktop)]
const ROUTED_MENU_IDS: [&str; 17] = [
    "open-folder",
    "new-doc",
    "new-folder",
    "save",
    "close-folder",
    "settings",
    "find",
    "find-in-files",
    "quick-open",
    "command-palette",
    "toggle-sidebar",
    "toggle-outline",
    "check-updates",
    "report-issue",
    "export-pdf",
    "writing-proofread",
    "writing-rewrite",
];

#[cfg(desktop)]
fn build_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;

    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let new_doc = MenuItemBuilder::with_id("new-doc", "New Document")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let new_window = MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let new_folder = MenuItemBuilder::with_id("new-folder", "New Folder").build(handle)?;
    let quick_open = MenuItemBuilder::with_id("quick-open", "Quick Open…")
        .accelerator("CmdOrCtrl+P")
        .build(handle)?;
    // Cmd+Shift+P rather than the Cmd+K this row used to carry. Cmd+K is the link chord in every
    // application people write prose in, so it went to the link tool, and the accelerator had to
    // move with it: macOS performs a key equivalent by firing the menu item itself, before the
    // webview sees a keydown, so a row still holding Cmd+K would have kept opening this palette
    // whatever src/keys/bindings.ts said.
    //
    // The link tool got no row of its own in exchange. A menu item's key equivalent fires with no
    // idea what is on screen, and that chord is bound in the document context precisely so it does
    // nothing while an overlay has the keyboard; every accelerator in this file belongs to a
    // command that means the same thing in every context, and a link into a selection that is not
    // there is not one of them.
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
        .accelerator("CmdOrCtrl+Shift+P")
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
                &new_window,
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
                .item(&new_window)
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
        // The app submenu is built here rather than patched, because what it is missing is the
        // point. Tauri's default carries Services, Hide and Hide Others, and none of the three
        // belongs on this app: Services is a submenu of whatever every other installed app has
        // decided to advertise, which is a list this app cannot see, cannot order and cannot
        // predict the contents of, and the two Hide rows are a window state nobody reaches for
        // through a menu. Cmd+H stops hiding the app along with the row that owned the chord,
        // which is the trade being made knowingly.
        //
        // Removing the whole submenu and inserting a replacement at the same index, rather than
        // deleting rows out of the default one, because the default's separators are positional:
        // taking Services out leaves two separators with nothing between them, and the arithmetic
        // for which of them to also remove would be a comment longer than this one.
        let info = handle.package_info();
        let about = PredefinedMenuItem::about(
            handle,
            None,
            Some(AboutMetadata {
                name: Some(info.name.clone()),
                version: Some(info.version.to_string()),
                copyright: handle.config().bundle.copyright.clone(),
                authors: handle.config().bundle.publisher.clone().map(|p| vec![p]),
                ..Default::default()
            }),
        )?;
        let app_submenu = SubmenuBuilder::new(handle, info.name.clone())
            .item(&about)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&check_updates)
            .item(&settings)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::quit(handle, None)?)
            .build()?;
        menu.remove_at(0)?;
        menu.insert(&app_submenu, 0)?;
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
            let toggle_outline = MenuItemBuilder::with_id("toggle-outline", "Toggle Outline")
                .accelerator("CmdOrCtrl+Shift+\\")
                .build(handle)?;
            view.prepend_items(&[
                &toggle_sidebar,
                &toggle_outline,
                &PredefinedMenuItem::separator(handle)?,
            ])?;
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
        .manage(windows::Windows::default())
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
        // Whatever the last session left open is closed now, once, rather than by each window as
        // it loads, which would close folders another window had only just opened.
        fs::forget_stale_roots(app.handle());
        #[cfg(target_os = "macos")]
        windows::terminate::install(app.handle());
        // The Writing Tools submenu is AppKit's, not build_menu's: the system inserts it into Edit
        // on its own terms, so when it is there to label is writingtools.rs's problem and not this
        // file's. One call, whatever it decides to wait for.
        writingtools::install(app.handle());
        // The traffic lights, which land seven pixels above everything else in a title bar this
        // tall until they are moved. Here rather than in the window's own setup because the window
        // is Tauri's and this is the first point in the launch that has a handle to it.
        // Every window after this one gets the same in windows.rs, which is what builds them.
        if let Some(window) = app.get_webview_window(windows::MAIN) {
            titlebar::install(&window);
        }
        // Last, so the files that launched the app find the main window ready to take the first.
        windows::start(app.handle());
        Ok(())
    });

    #[cfg(desktop)]
    {
        builder = builder
            .menu(build_menu)
            .on_menu_event(|app, event| {
                let id = event.id().0.as_str();
                if id == "new-window" {
                    if let Err(e) = windows::create_window(app, Default::default()) {
                        eprintln!("could not open a window: {e}");
                    }
                } else if ROUTED_MENU_IDS.contains(&id) {
                    windows::dispatch_menu(app, id);
                }
            })
            .on_window_event(|window, event| match event {
                tauri::WindowEvent::Focused(true) => windows::focused(window.app_handle(), window.label()),
                tauri::WindowEvent::Destroyed => windows::destroyed(window.app_handle(), window.label()),
                _ => {}
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
            fs::file_bytes,
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
            windows::window_init,
            windows::window_create,
            windows::window_close_refused,
            windows::document_claim,
            windows::document_set,
            windows::document_open,
            integration::cli_install,
            integration::default_app_set,
        ])
        .build(context)
        .expect("error while building Margin Docs")
        .run(|app, event| match event {
            // Finder, the Dock and `mdocs` all hand over files this way, on a cold launch and to an
            // app that is already running alike.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                windows::open_urls(app, paths);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => windows::reopen(app, has_visible_windows),
            // The last window closing leaves a Mac app running, the way every other document app
            // does. Only a quit, which sets `quitting` first, lets it go.
            tauri::RunEvent::ExitRequested { code: None, api, .. } if !windows::quitting(app) => {
                api.prevent_exit();
            }
            _ => {}
        });
}
