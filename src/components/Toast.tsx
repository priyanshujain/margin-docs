import { useEffect } from "react";
import { useToast } from "../store/useToast";

const DWELL_MS = 4200;
/** Long enough to read: a sentence of instructions should not vanish halfway through it. */
const DWELL_PER_CHAR_MS = 60;

export function Toast() {
  const message = useToast((s) => s.message);
  const dismiss = useToast((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(dismiss, Math.max(DWELL_MS, message.length * DWELL_PER_CHAR_MS));
    return () => clearTimeout(timer);
  }, [message, dismiss]);

  if (!message) return null;

  return (
    <div className="toast" role="status" title="Dismiss" onClick={dismiss}>
      {message}
    </div>
  );
}
