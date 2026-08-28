import { useEffect } from "react";
import { useToast } from "../store/useToast";

const DWELL_MS = 4200;

export function Toast() {
  const message = useToast((s) => s.message);
  const dismiss = useToast((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(dismiss, DWELL_MS);
    return () => clearTimeout(timer);
  }, [message, dismiss]);

  if (!message) return null;

  return (
    <div className="toast" role="status" title="Dismiss" onClick={dismiss}>
      {message}
    </div>
  );
}
