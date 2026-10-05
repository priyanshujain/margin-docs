// The traffic lights, moved down onto the middle of this app's title bar.
//
// The row is 46px tall, which is --titlebar-h in margin-shared's css/tokens.css and the one number
// this file and that one both have to know. macOS draws the close, minimise and zoom buttons where
// a system title bar wants them and has no idea the row is taller, so out of the box they sit
// seven pixels above the sidebar toggle beside them, above the filename between them and above
// every button at the other end. Nothing in the row is misaligned with anything else in it; the
// row is misaligned with the three things the system drew on top of it, which is worse, because
// those three are the first thing anybody looks at.
//
// AppKit exposes no inset for this. What it does expose is the view the buttons live in, so they
// are moved the way an app with a title bar of its own has always had to move them: the container
// is made taller, and because each button's frame is measured from that container's bottom edge,
// the three come down together and keep the spacing and the size macOS gave them. Nothing here
// draws a button or assumes a diameter, which is the point of doing it this way rather than
// setting three origins: macOS 26 made the lights larger than every release before it, and a
// number copied out of a screenshot would have been wrong within a year.
//
// Reapplied whenever the window changes, because AppKit lays the container out again on its own
// terms and puts it back where it thinks it belongs.

#[cfg(target_os = "macos")]
use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};

/// Centres the lights now and keeps them centred. Called once, from `setup`.
///
/// A no-op off macOS, where the window has ordinary decorations and this file has nothing to say.
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    apply(window);

    // Resized covers the drag, the zoom and the way back out of full screen. Focused covers the
    // first time the window is shown, which on a cold launch happens after `setup` has run and
    // after this function has already applied once to a layout that was not final. ThemeChanged
    // rebuilds the title bar's appearance and takes the container's frame with it.
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::Focused(_) | WindowEvent::ThemeChanged(_)
        ) {
            return;
        }
        if let Some(window) = app.get_webview_window(&label) {
            apply(&window);
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// One pass, on the main thread, where AppKit insists this happen.
///
/// The hop is unconditional rather than guarded by a main thread check: window events already
/// arrive on the main thread and the hop costs a trip round the run loop, which is cheaper than
/// being wrong about that on some future Tauri.
#[cfg(target_os = "macos")]
fn apply<R: Runtime>(window: &WebviewWindow<R>) {
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(ptr) = handle.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // The pointer is the NSWindow Tauri made for this webview and outlives the closure: the
        // window handle above holds it open for the length of this call.
        mac::centre(unsafe { &*(ptr as *const objc2_app_kit::NSWindow) });
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};

    /// --titlebar-h in margin-shared's css/tokens.css. The lights are centred on that row, so the
    /// two numbers move together or this stops being a fix.
    const TITLEBAR_H: f64 = 46.0;

    /// Under half a pixel the frames are already where they belong, and setting them again would
    /// buy a layout pass and a redraw for nothing. This runs on every frame of a window drag, so
    /// the early exit is the normal path rather than an optimisation.
    const SLACK: f64 = 0.5;

    pub fn centre(window: &NSWindow) {
        // Full screen is the system's layout and not this app's. The lights are in the menu bar
        // overlay rather than in the window, the container measured below is not the one holding
        // them, and there is no 46px row on screen to centre anything on.
        if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return;
        }

        let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };

        // The button sits in an NSTitlebarView, which fills an NSTitlebarContainerView. The
        // container is the one AppKit sizes to the system title bar, so it is the one to resize:
        // the view inside it follows, and the buttons follow that.
        let Some(container) = (unsafe { close.superview().and_then(|view| view.superview()) })
        else {
            return;
        };

        // Measured rather than assumed, and measured in the window's own coordinates so that
        // neither the button's size nor where AppKit currently puts it has to be a constant here.
        let button = close.convertRect_toView(close.bounds(), None);
        let top = window.frame().size.height - (button.origin.y + button.size.height);
        let wanted = (TITLEBAR_H - button.size.height) / 2.0;
        let drop = wanted - top;
        if drop.abs() < SLACK {
            return;
        }

        // Taller by the distance the buttons have to fall, with the top edge pinned: AppKit's y
        // runs up from the bottom of the window, so growing the container downwards is what
        // carries its contents down the screen.
        let mut frame = container.frame();
        frame.size.height += drop;
        frame.origin.y -= drop;
        container.setFrame(frame);
    }
}
