// The faces a PDF is set in.
//
// Nine of them are bundled and compiled into the binary by pdf.rs, one per weight and slope,
// because a document that typesets differently on two machines is not an export. The two things this app does not bundle
// are a monospace family for code and a math family for formulas, both of which are large and
// neither of which the editor shows on screen, so they come off the system instead and this module
// is how they are found.
//
// A family that is not installed is not an error. Typst is handed whatever was found and falls
// back through the rest of its book for anything missing, and the export still happens.

use std::collections::HashSet;

use fontdb::{Database, Family, Query};

/// Monospace families in descending order of preference, starting with the name Typst's `raw`
/// element asks for by default so that a machine which happens to have it needs no help. The rest
/// are what macOS, Windows and the common Linux desktops actually ship.
const MONOSPACE_FAMILIES: [&str; 8] = [
    "DejaVu Sans Mono",
    "SF Mono",
    "Menlo",
    "Monaco",
    "Andale Mono",
    "Consolas",
    "Liberation Mono",
    "Courier New",
];

/// Math families, again starting with Typst's own default. A math face is not interchangeable with
/// a text one: laying out an equation needs the OpenType MATH table, and Typst will not fall back
/// off this list on its own, so it is long on purpose.
const MATH_FAMILIES: [&str; 8] = [
    "New Computer Modern Math",
    "Latin Modern Math",
    "STIX Two Math",
    "Cambria Math",
    "XITS Math",
    "TeX Gyre Pagella Math",
    "DejaVu Math TeX Gyre",
    "Asana Math",
];

/// Loading the system font list walks several directories, so it happens once per compile rather
/// than once per family looked up.
fn system_db() -> Database {
    let mut db = Database::new();
    db.load_system_fonts();
    db
}

/// A key that is the same for every face of one font collection, so a `.ttc` is read once instead
/// of once per style. `with_face_data` hands back the whole collection either way, and Typst
/// expands it into every face it holds.
fn source_key(face: &fontdb::FaceInfo) -> String {
    match &face.source {
        fontdb::Source::File(path) => path.to_string_lossy().into_owned(),
        fontdb::Source::SharedFile(path, _) => path.to_string_lossy().into_owned(),
        fontdb::Source::Binary(_) => format!("{:?}:{}", face.id, face.index),
    }
}

fn installed(face: &fontdb::FaceInfo, family: &str) -> bool {
    face.families
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case(family))
}

fn faces_for(db: &Database, family: &str, into: &mut Vec<Vec<u8>>, seen: &mut HashSet<String>) {
    let styles = [
        (fontdb::Weight::NORMAL, fontdb::Style::Normal),
        (fontdb::Weight::NORMAL, fontdb::Style::Italic),
        (fontdb::Weight::BOLD, fontdb::Style::Normal),
        (fontdb::Weight::BOLD, fontdb::Style::Italic),
    ];
    for (weight, style) in styles {
        let query = Query {
            families: &[Family::Name(family)],
            weight,
            style,
            ..Query::default()
        };
        let Some(id) = db.query(&query) else { continue };
        // fontdb answers a query with its closest match rather than with nothing, so a family that
        // is not installed comes back as some unrelated face. Checking the name of what came back
        // is the only way to tell a hit from a substitution.
        let Some(face) = db.face(id) else { continue };
        if !installed(face, family) || !seen.insert(source_key(face)) {
            continue;
        }
        if let Some(bytes) = db.with_face_data(id, |data, _index| data.to_vec()) {
            into.push(bytes);
        }
    }
}

/// What this machine turned out to have.
///
/// The names matter as much as the bytes. Typst warns once per family it was asked for and could
/// not find, so a preamble naming a hopeful list of eight monospaces produces seven warnings on a
/// machine with one of them, and the export ends with a toast about fonts nobody chose. Naming only
/// what is here means naming nothing that is not.
pub struct Fallbacks {
    pub fonts: Vec<Vec<u8>>,
    pub monospace: Vec<String>,
    pub math: Vec<String>,
}

/// The faces the bundle is missing: a monospace for code blocks and a math family for formulas.
///
/// Every candidate that is installed is loaded, not just the first, so that the preamble can name
/// them in preference order and let Typst pick.
pub fn fallbacks() -> Fallbacks {
    let db = system_db();
    let mut fonts = Vec::new();
    let mut seen = HashSet::new();
    let monospace = collect_installed(&db, &MONOSPACE_FAMILIES, &mut fonts, &mut seen);
    let math = collect_installed(&db, &MATH_FAMILIES, &mut fonts, &mut seen);
    Fallbacks {
        fonts,
        monospace,
        math,
    }
}

fn collect_installed(
    db: &Database,
    families: &[&str],
    fonts: &mut Vec<Vec<u8>>,
    seen: &mut HashSet<String>,
) -> Vec<String> {
    families
        .iter()
        .filter(|family| {
            let before = fonts.len();
            faces_for(db, family, fonts, seen);
            // A family whose file was already loaded under another name is still installed, so the
            // count is not the test on its own.
            fonts.len() > before || db.faces().any(|face| installed(face, family))
        })
        .map(|family| (*family).to_string())
        .collect()
}
