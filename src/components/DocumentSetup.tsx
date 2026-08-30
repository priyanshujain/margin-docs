// Document setup: the panel the filename in the title bar opens.
//
// The sibling book app puts the same thing behind the same gesture. Its title bar shows the book's
// title, clicking it opens Book setup, and the faces the book is set in are a section of that
// panel. This is that panel for a document editor, so the two apps answer a click on the title the
// same way, and the two font pickers are the same picker.
//
// What a document has to set up is a shorter list than a book's. There is no author, no ISBN and no
// trim size, because none of those are things a markdown file holds: its metadata is frontmatter,
// which src/model/doc.ts carries opaque and never parses. What is left is the two things that are
// genuinely the document's own, its name on disk and the faces it is set in.
//
// A draft, applied on Save, which is again the sibling's shape. Nothing here touches the open
// document until the button is pressed: changing a face and pressing Escape leaves the page exactly
// as it was. The specimen at the foot of the panel is what stands in for a live preview, and it is
// the better trade for a rename, where "applied as you type" would mean a file moving on disk once
// per keystroke.

import { useEffect, useRef, useState } from "react";
import { icons } from "margin-shared";
import { useEscapeLayer } from "../escape";
import { useKeyContext } from "../keys/keymap";
import {
  BUNDLED_FONTS,
  DEFAULT_FONTS,
  FONT_PAIRINGS,
  decodeRef,
  encodeRef,
  fontStack,
  fontsEqual,
  pairingFor,
  type DocumentFonts,
  type FontRef,
} from "../model/fonts";
import { fontsListSystem } from "../api/fonts";
import { useDocumentFonts } from "../store/useDocumentFonts";
import { notify } from "../store/useToast";
import { useWorkspace } from "../store/useWorkspace";
import { splitExtension } from "./FileTree";
import { Icon } from "./Icon";

/**
 * The machine's font book, asked once per launch and kept for every later open of this panel.
 *
 * It walks several directories on the Rust side and cannot change while the app is running, so a
 * second ask would be the same list at the same cost.
 */
let systemFontCache: string[] | null = null;

interface Draft {
  name: string;
  fonts: DocumentFonts;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * One slot's picker: the six that travel with the app, then whatever this machine has.
 *
 * A stored family the machine no longer has is put back at the top of its own group rather than
 * dropped, so the select shows what the document actually asks for instead of silently reading as
 * some other face.
 */
function FontSelect({
  value,
  system,
  onChange,
}: {
  value: FontRef;
  system: readonly string[];
  onChange: (ref: FontRef) => void;
}) {
  const missing = value.kind === "system" && !system.includes(value.family) ? [value.family] : [];
  return (
    <select
      value={encodeRef(value)}
      style={{ fontFamily: fontStack(value) }}
      onChange={(e) => onChange(decodeRef(e.target.value))}
    >
      <optgroup label="Bundled">
        {BUNDLED_FONTS.map((f) => (
          <option key={f.id} value={`b:${f.id}`}>
            {f.label}
          </option>
        ))}
      </optgroup>
      {(system.length > 0 || missing.length > 0) && (
        <optgroup label="System">
          {[...missing, ...system].map((family) => (
            <option key={family} value={`s:${family}`}>
              {family}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function DocumentSetup({ path, onClose }: { path: string; onClose: () => void }) {
  const fonts = useDocumentFonts((s) => s.fonts);
  const setFonts = useDocumentFonts((s) => s.setFonts);
  const renameEntry = useWorkspace((s) => s.renameEntry);

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const { base, hidden } = splitExtension(fileName);

  const [draft, setDraft] = useState<Draft>(() => ({ name: base, fonts }));
  const [system, setSystem] = useState<string[]>(() => systemFontCache ?? []);
  // Open on the two selects when the document is in a pair no preset names, because that is the
  // state somebody arrived at by using them and the panel should not hide the controls that got
  // them there.
  const [advanced, setAdvanced] = useState(() => pairingFor(fonts) === null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEscapeLayer(true, onClose);
  useKeyContext("overlay");

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    if (systemFontCache) return;
    let live = true;
    void fontsListSystem().then((list) => {
      systemFontCache = list;
      if (live) setSystem(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSlot = (slot: "body" | "heading", ref: FontRef) =>
    set({ fonts: { ...draft.fonts, [slot]: ref } });

  const activePreset = pairingFor(draft.fonts);
  const usesSystem = draft.fonts.body.kind === "system" || draft.fonts.heading.kind === "system";

  const save = () => {
    if (!fontsEqual(draft.fonts, fonts)) setFonts(draft.fonts);

    // The rename goes last and the panel closes either way. A file that could not be renamed is a
    // toast and not a reason to throw away the face the user just chose, and the two are unrelated
    // enough that failing one must not roll back the other.
    const trimmed = draft.name.trim();
    if (trimmed && trimmed !== base) {
      renameEntry(path, `${trimmed}${hidden}`).catch((e) =>
        notify(`Could not rename: ${String(e)}`),
      );
    }
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="panel panel-setup"
        role="dialog"
        aria-modal="true"
        aria-label="Document setup"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>Document setup</h2>
          <button className="icon-button" onClick={onClose} title="Close (⎋)" aria-label="Close">
            <Icon d={icons.CLOSE} />
          </button>
        </div>

        <div className="panel-body">
          {/* The file on disk, and the only thing that ever renames it. A document's H1 is content
              and is left alone: a path is what git, every other editor and every relative link from
              another document already agreed on. Markdown's own extension is hidden here the same
              way the file tree hides it, and put back on the way out. */}
          <Field label="Name">
            <input
              ref={nameRef}
              value={draft.name}
              placeholder={base}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set({ name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                save();
              }}
            />
          </Field>

          <div className="field">
            <span className="field-label">Typography</span>
            <div className="font-presets">
              {FONT_PAIRINGS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="font-preset"
                  data-on={activePreset === p.id}
                  onClick={() => set({ fonts: { body: p.body, heading: p.heading } })}
                >
                  <span className="font-preset-demo" style={{ fontFamily: fontStack(p.heading) }}>
                    Ag
                  </span>
                  <span className="font-preset-name">{p.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="font-advanced" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? "Hide custom fonts" : "Customize fonts"}
            </button>
          </div>

          {advanced && (
            <>
              <Field label="Body font">
                <FontSelect
                  value={draft.fonts.body}
                  system={system}
                  onChange={(ref) => setSlot("body", ref)}
                />
              </Field>
              <Field label="Heading font">
                <FontSelect
                  value={draft.fonts.heading}
                  system={system}
                  onChange={(ref) => setSlot("heading", ref)}
                />
              </Field>
              {usesSystem && (
                <p className="font-note">
                  A font off this machine looks right here and in a PDF exported here, but it is not
                  part of the app, so another computer may not have it.
                </p>
              )}
            </>
          )}

          {/* A heading and a line of prose in the pair being chosen, which is the smallest sample
              that shows both slots and the relationship between them. */}
          <div className="font-sample" style={{ fontFamily: fontStack(draft.fonts.body) }}>
            <span
              className="font-sample-title"
              style={{ fontFamily: fontStack(draft.fonts.heading) }}
            >
              What lives where
            </span>
            She read the first line twice, and the whole quiet house seemed to lean in to listen.
          </div>
        </div>

        <div className="panel-foot">
          {!fontsEqual(draft.fonts, DEFAULT_FONTS) && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => set({ fonts: DEFAULT_FONTS })}
            >
              Reset fonts
            </button>
          )}
          <button className="btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
