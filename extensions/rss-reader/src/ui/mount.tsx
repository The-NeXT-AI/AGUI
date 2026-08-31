import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

export function mount(element: ReactNode): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing extension root element.");
  createRoot(root).render(element);
}
