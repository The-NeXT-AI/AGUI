import { useEffect, useState } from "react";

export function useCoarsePointer(): boolean {
  const [coarsePointer, setCoarsePointer] = useState(() => coarsePointerMatches());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const media = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarsePointer(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return coarsePointer;
}

function coarsePointerMatches(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
}
