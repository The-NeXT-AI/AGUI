import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

/**
 * The "Popcorn" canvas — a document / presentation / workbook surface docked
 * in the detail pane (AGUI `PopcornElectron{Document,Presentation,Workbook}Panel`).
 * The mode switches the editing surface; content is held locally as a stand-in.
 */
const MODES = [
  { value: "document", label: "Document", placeholder: "Start writing a document…" },
  { value: "presentation", label: "Slides", placeholder: "Outline your slides, one per line…" },
  { value: "workbook", label: "Workbook", placeholder: "Workbook cells…" },
] as const;

export function PopcornPanel() {
  const [content, setContent] = useState("");
  return (
    <Tabs.Root defaultValue="document" className="flex h-full flex-col">
      <Tabs.List className="border-border-subtle flex shrink-0 gap-1 border-b px-2 pt-2">
        {MODES.map((m) => (
          <Tabs.Tab
            key={m.value}
            value={m.value}
            className="text-muted hover:text-fg data-active:bg-surface data-active:text-fg rounded-t-md px-3 py-1.5 text-[12.5px] transition-colors outline-none"
          >
            {m.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {MODES.map((m) => (
        <Tabs.Panel key={m.value} value={m.value} className="min-h-0 flex-1 outline-none">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={m.placeholder}
            className="text-fg placeholder:text-subtle h-full w-full resize-none bg-transparent p-4 text-[13.5px] leading-relaxed focus:outline-none"
          />
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
