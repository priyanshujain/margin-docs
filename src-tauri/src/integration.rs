// The two places this app reaches outside itself on request: the `mdocs` command in the user's
// PATH, and being the app Finder opens Markdown files with. Both act on the installed app bundle,
// so neither does anything from a development build.

use std::path::{Path, PathBuf};

/// Where `mdocs` is installed: on the default PATH of every macOS shell.
pub const LINK: &str = "/usr/local/bin/mdocs";

/// The launcher inside the bundle, relative to `Contents`. Mirrors `bundle.macOS.files` in
/// tauri.conf.json.
const LAUNCHER: &str = "Resources/bin/mdocs";

const EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mkdn"];

const BY_HAND: &str = "To set it by hand, select a Markdown file in Finder, choose File > Get Info, \
pick Margin Docs under Open with, then click Change All.";

/// The running app's bundle, refused when this is not a packaged app the user can keep.
pub fn bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| "This needs the installed Margin Docs app, not a development build.".to_string())?;
    if bundle.to_string_lossy().contains("/AppTranslocation/") {
        return Err(
            "Move Margin Docs into your Applications folder and open it from there first."
                .to_string(),
        );
    }
    Ok(bundle.to_path_buf())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Link {
    Missing,
    /// Already points at this app's launcher.
    Current,
    /// Points at a launcher inside some Margin Docs bundle that is not this one, left behind when
    /// the app moved. Safe to replace.
    Stale,
    /// Something else entirely, which is never overwritten.
    Foreign,
}

fn is_launcher(path: &Path) -> bool {
    path.ends_with(Path::new("Contents").join(LAUNCHER))
        && path
            .ancestors()
            .nth(4)
            .is_some_and(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
}

pub fn inspect(link: &Path, launcher: &Path) -> Link {
    let meta = match std::fs::symlink_metadata(link) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Link::Missing,
        Err(_) => return Link::Foreign,
    };
    if !meta.file_type().is_symlink() {
        return Link::Foreign;
    }
    let Ok(target) = std::fs::read_link(link) else {
        return Link::Foreign;
    };
    let target = match link.parent() {
        Some(dir) if target.is_relative() => dir.join(target),
        _ => target,
    };
    let same = target == launcher
        || matches!(
            (std::fs::canonicalize(&target), std::fs::canonicalize(launcher)),
            (Ok(a), Ok(b)) if a == b
        );
    if same {
        Link::Current
    } else if is_launcher(&target) {
        Link::Stale
    } else {
        Link::Foreign
    }
}

pub enum Placed {
    Done,
    /// The folder is not the user's to write in, so the system has to be asked.
    NeedsAdmin,
}

/// Points `link` at `launcher` without asking anybody, through a temporary link renamed into place
/// so a stale link is replaced in one step.
pub fn place(link: &Path, launcher: &Path) -> Result<Placed, String> {
    use std::io::ErrorKind;
    let dir = link
        .parent()
        .ok_or_else(|| format!("{} has no folder", link.display()))?;
    if let Err(e) = std::fs::create_dir_all(dir) {
        return match e.kind() {
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => Ok(Placed::NeedsAdmin),
            _ => Err(format!("{}: {e}", dir.display())),
        };
    }
    let tmp = dir.join(format!(".mdocs.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    if let Err(e) = std::os::unix::fs::symlink(launcher, &tmp) {
        return match e.kind() {
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => Ok(Placed::NeedsAdmin),
            _ => Err(format!("{}: {e}", dir.display())),
        };
    }
    std::fs::rename(&tmp, link).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", link.display())
    })?;
    Ok(Placed::Done)
}

/// The system's administrator prompt, which runs the same link as root. Cancelling it is an answer
/// and not a failure, so it comes back as `Ok(false)`.
fn place_as_admin(link: &Path, launcher: &Path) -> Result<bool, String> {
    let dir = link
        .parent()
        .ok_or_else(|| format!("{} has no folder", link.display()))?;
    let output = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "do shell script \"/bin/mkdir -p \" & quoted form of (item 1 of argv) & \" && /bin/ln -sfh \" & quoted form of (item 2 of argv) & \" \" & quoted form of (item 3 of argv) with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(dir)
        .arg(launcher)
        .arg(link)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("-128") {
        return Ok(false);
    }
    Err(stderr.trim().to_string())
}

/// Puts `mdocs` on the PATH, pointing into this app bundle.
#[tauri::command(async)]
pub fn cli_install() -> Result<String, String> {
    let launcher = bundle()?.join("Contents").join(LAUNCHER);
    if !launcher.is_file() {
        return Err(format!("{} is missing from the app.", launcher.display()));
    }
    let link = Path::new(LINK);
    match inspect(link, &launcher) {
        Link::Current => return Ok(format!("mdocs is already installed at {LINK}.")),
        Link::Foreign => {
            return Err(format!(
                "{LINK} already exists and is not Margin Docs' command, so it was left alone. Remove it first if you want mdocs to open Margin Docs."
            ))
        }
        Link::Missing | Link::Stale => {}
    }
    match place(link, &launcher)? {
        Placed::Done => {}
        Placed::NeedsAdmin => {
            if !place_as_admin(link, &launcher)? {
                return Ok("Installing mdocs was cancelled. Nothing was changed.".to_string());
            }
        }
    }
    if inspect(link, &launcher) != Link::Current {
        return Err(format!("{LINK} was not created."));
    }
    Ok(format!(
        "Installed mdocs at {LINK}. Run `mdocs notes.md` to open a file here."
    ))
}

/// Makes this app the one Finder opens Markdown files with.
#[tauri::command(async)]
pub fn default_app_set(app: tauri::AppHandle) -> Result<String, String> {
    let bundle = bundle()?;
    let outcome = mac::set_default(&bundle, &app.config().identifier)?;
    let changed: Vec<&str> = outcome.changed.iter().flatten().copied().collect();
    let all = EXTENSIONS.len();
    let list = |exts: &[&str]| {
        exts.iter()
            .map(|ext| format!(".{ext}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match (&outcome.stopped, changed.len()) {
        (None, n) if n == all => Ok(format!(
            "Margin Docs now opens Markdown files ({}).",
            list(&EXTENSIONS)
        )),
        (Some(Stop::Cancelled), 0) => Ok(format!("Nothing was changed. {BY_HAND}")),
        (Some(Stop::Failed(reason)), 0) => Err(format!("{reason}. {BY_HAND}")),
        (stopped, _) => {
            let missing: Vec<&str> = EXTENSIONS
                .iter()
                .copied()
                .filter(|ext| !changed.contains(ext))
                .collect();
            let why = match stopped {
                Some(Stop::Cancelled) => "the change was cancelled".to_string(),
                Some(Stop::Failed(reason)) => reason.clone(),
                None => "macOS did not apply it".to_string(),
            };
            Ok(format!(
                "Margin Docs now opens {} files, but not {} because {why}. {BY_HAND}",
                list(&changed),
                list(&missing)
            ))
        }
    }
}

pub enum Stop {
    Cancelled,
    Failed(String),
}

pub struct Outcome {
    /// The extensions of each content type that was switched over.
    pub changed: Vec<Vec<&'static str>>,
    /// Why it stopped before the last type, if it did.
    pub stopped: Option<Stop>,
}

/// The content types macOS files these extensions under, each with the extensions it covers. `.md`
/// and `.markdown` share one declared type; the rest are dynamic types made up from the extension.
#[cfg(target_os = "macos")]
fn content_types() -> Vec<(String, Vec<&'static str>)> {
    let mut out: Vec<(String, Vec<&'static str>)> = Vec::new();
    for ext in EXTENSIONS {
        let Some(id) = mac::type_for_extension(ext) else {
            continue;
        };
        match out.iter_mut().find(|(known, _)| *known == id) {
            Some((_, exts)) => exts.push(ext),
            None => out.push((id, vec![ext])),
        }
    }
    out
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol};
    use objc2::{msg_send, sel};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSError, NSString, NSURL};

    use super::{content_types, Outcome, Stop};

    /// How long the system consent prompt is waited on before the attempt is reported as stalled.
    const CONSENT_WAIT: Duration = Duration::from_secs(300);
    const ROLES_ALL: u32 = 0xFFFF_FFFF;
    /// NSUserCancelledError, which is what declining the consent prompt answers with.
    const USER_CANCELLED: isize = 3072;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        static kUTTagClassFilenameExtension: *const c_void;
        fn UTTypeCreatePreferredIdentifierForTag(
            tag_class: *const c_void,
            tag: *const c_void,
            conforming_to: *const c_void,
        ) -> *const c_void;
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: *const c_void,
            role: u32,
            handler: *const c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    pub fn type_for_extension(ext: &str) -> Option<String> {
        let tag = NSString::from_str(ext);
        unsafe {
            let id = UTTypeCreatePreferredIdentifierForTag(
                kUTTagClassFilenameExtension,
                Retained::as_ptr(&tag).cast(),
                std::ptr::null(),
            );
            if id.is_null() {
                return None;
            }
            let text = (*id.cast::<NSString>()).to_string();
            CFRelease(id);
            Some(text)
        }
    }

    pub fn set_default(bundle: &Path, identifier: &str) -> Result<Outcome, String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let modern = workspace.respondsToSelector(sel!(
            setDefaultApplicationAtURL:toOpenContentType:completionHandler:
        ));
        let types = content_types();
        if types.is_empty() {
            return Err("macOS does not recognise the Markdown extensions".to_string());
        }
        let mut outcome = Outcome {
            changed: Vec::new(),
            stopped: None,
        };
        for (id, exts) in types {
            let result = if modern {
                set_modern(&workspace, bundle, &id)
            } else {
                set_legacy(&id, identifier)
            };
            match result {
                Ok(()) => outcome.changed.push(exts),
                Err(stop) => {
                    outcome.stopped = Some(stop);
                    break;
                }
            }
        }
        Ok(outcome)
    }

    /// macOS 12 and later, which asks the user before it lets an app make itself the default.
    fn set_modern(workspace: &NSWorkspace, bundle: &Path, id: &str) -> Result<(), Stop> {
        let Some(class) = AnyClass::get(c"UTType") else {
            return Err(Stop::Failed("macOS has no content type API".to_string()));
        };
        let name = NSString::from_str(id);
        let content: Option<Retained<AnyObject>> =
            unsafe { msg_send![class, typeWithIdentifier: &*name] };
        let Some(content) = content else {
            return Err(Stop::Failed(format!("macOS does not know the type {id}")));
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&bundle.to_string_lossy()));

        let (tx, rx) = mpsc::channel::<Result<(), Stop>>();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let result = match unsafe { error.as_ref() } {
                None => Ok(()),
                Some(error) if error.code() == USER_CANCELLED => Err(Stop::Cancelled),
                Some(error) => Err(Stop::Failed(error.localizedDescription().to_string())),
            };
            let _ = tx.send(result);
        });
        unsafe {
            let _: () = msg_send![
                workspace,
                setDefaultApplicationAtURL: &*url,
                toOpenContentType: &*content,
                completionHandler: &*handler
            ];
        }
        rx.recv_timeout(CONSENT_WAIT).unwrap_or_else(|_| {
            Err(Stop::Failed(
                "macOS did not answer the request in time".to_string(),
            ))
        })
    }

    /// Launch Services, for the macOS versions before 12 this app still supports.
    fn set_legacy(id: &str, identifier: &str) -> Result<(), Stop> {
        let content = NSString::from_str(id);
        let handler = NSString::from_str(identifier);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                Retained::as_ptr(&content).cast(),
                ROLES_ALL,
                Retained::as_ptr(&handler).cast(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(Stop::Failed(format!("Launch Services refused with error {status}")))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use std::path::Path;

    use super::Outcome;

    pub fn set_default(_bundle: &Path, _identifier: &str) -> Result<Outcome, String> {
        Err("Choosing the default app is only supported on macOS.".to_string())
    }
}
