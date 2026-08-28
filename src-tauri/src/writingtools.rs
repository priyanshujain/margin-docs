// Writing Tools, which is Apple's and not this app's.
//
// There is no API to call. The system puts a "Writing Tools" submenu on the Edit menu of any app
// with an editable text view, and the only way in from here is to find that item on the live
// NSMenu and perform it. What happens next happens in the webview, to the DOM, without asking:
// that is the whole risk in this feature, docs/architecture.md is where the seam is described, and
// src/editor/writing.ts is where the selection that may be handed to one is decided.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

/// What the main thread last saw. Read below by a command that has no handle to hop with.
#[cfg(target_os = "macos")]
static SUBMENU_SEEN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
    use objc2_foundation::NSArray;

    fn submenu_named(items: &NSArray<NSMenuItem>, title: &str) -> Option<Retained<NSMenu>> {
        for i in 0..items.count() {
            let item = items.objectAtIndex(i);
            if item.title().to_string() == title {
                return item.submenu();
            }
        }
        None
    }

    fn edit_menu(mtm: MainThreadMarker) -> Option<Retained<NSMenu>> {
        let main = NSApplication::sharedApplication(mtm).mainMenu()?;
        for i in 0..main.numberOfItems() {
            let Some(item) = main.itemAtIndex(i) else { continue };
            let Some(submenu) = item.submenu() else { continue };
            if submenu.title().to_string() == "Edit" || item.title().to_string() == "Edit" {
                return Some(submenu);
            }
        }
        None
    }

    pub fn writing_tools_menu(mtm: MainThreadMarker) -> Option<Retained<NSMenu>> {
        submenu_named(&edit_menu(mtm)?.itemArray(), "Writing Tools")
    }

    /// Whether the submenu is on the Edit menu right now, and false off the main thread, where
    /// AppKit may not be asked.
    pub fn available() -> bool {
        MainThreadMarker::new().is_some_and(|mtm| writing_tools_menu(mtm).is_some())
    }

    /// Fires one row of the submenu by its title, which is English because the frontend has no way
    /// to know what this Mac calls it. A row that is not found is an error rather than a no-op: a
    /// gesture that does nothing and says nothing is the worst answer available.
    pub fn perform(tool: &str) -> Result<(), String> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Err("Writing Tools has to be performed on the main thread.".into());
        };
        let Some(menu) = writing_tools_menu(mtm) else {
            return Err("This Mac has no Writing Tools menu.".into());
        };
        let items = menu.itemArray();
        for i in 0..items.count() {
            if items.objectAtIndex(i).title().to_string() == tool {
                menu.performActionForItemAtIndex(i as isize);
                return Ok(());
            }
        }
        Err(format!("The Writing Tools menu has no {tool} item."))
    }
}

/// Called once from lib.rs's `setup`, which is early enough.
///
/// The sibling app looks for the submenu here and it was worth checking rather than copying,
/// because the submenu is AppKit's and nothing in this process puts it there. Measured on macOS
/// 26.5: at `setup`, before the webview has loaded a page, the Edit menu already carries "Writing
/// Tools" with Proofread and Rewrite on it, so there is nothing to wait for and no window event to
/// hang this off. A Mac without Apple Intelligence has no submenu at any moment, which is the same
/// code path.
///
/// This deliberately does not put Shift+Option+F and Shift+Option+R on Apple's own rows, which is
/// what the sibling does. AppKit performs a key equivalent by firing the menu item directly, so a
/// chord on the system's row reaches Writing Tools without passing the selection guard in
/// src/editor/writing.ts, and that guard is refusing selections that corrupt the file: a rewrite
/// spanning a link loses its address, one spanning two table cells widens the table. The chords are
/// on this app's own Edit rows instead, in lib.rs, where they route through the command table and
/// meet the guard. Exactly one menu item still owns each chord.
pub fn install(_app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    SUBMENU_SEEN.store(mac::available(), Ordering::Relaxed);
}

/// Whether this machine can actually run a Writing Tool. Writing Tools needs macOS 15.1 and Apple
/// Intelligence turned on, and `minimumSystemVersion` for this app is 10.15, so an unavailable menu
/// is the ordinary case and not an error: the frontend turns it into a toast rather than a button
/// that silently does nothing.
///
/// Answered from the live menu rather than from a version number, because the version is necessary
/// and not sufficient: the feature is off until the user turns Apple Intelligence on, and the
/// submenu is the only thing that knows. This signature carries no `AppHandle` to hop threads with,
/// so off the main thread it answers with what `install` saw at launch instead of guessing.
#[tauri::command]
pub fn writing_available() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if mac::available() {
            SUBMENU_SEEN.store(true, Ordering::Relaxed);
            return Ok(true);
        }
        Ok(SUBMENU_SEEN.load(Ordering::Relaxed))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

/// Fires one item on the system's Writing Tools submenu, by its English title.
#[tauri::command]
pub fn writing_run(app: tauri::AppHandle, tool: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        // Performed here when this is already the main thread, so a missing row comes back as an
        // error the frontend can say out loud. The hop is the fallback and it cannot report: waiting
        // on its answer would deadlock exactly when the wait was unnecessary.
        if MainThreadMarker::new().is_some() {
            return mac::perform(&tool);
        }
        app.run_on_main_thread(move || {
            if let Err(e) = mac::perform(&tool) {
                eprintln!("writing tools: {e}");
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tool);
        Err("Writing Tools is a macOS feature.".into())
    }
}
