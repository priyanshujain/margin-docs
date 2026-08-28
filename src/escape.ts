import { useEffect, useRef } from "react";

type Handler = () => void;

const layers: Handler[] = [];
let bound = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top();
}

function pushLayer(handler: Handler): () => void {
  if (!bound) {
    window.addEventListener("keydown", onKeyDown, true);
    bound = true;
  }
  layers.push(handler);
  return () => {
    const i = layers.lastIndexOf(handler);
    if (i !== -1) layers.splice(i, 1);
  };
}

export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushLayer(() => latest.current());
  }, [active]);
}
