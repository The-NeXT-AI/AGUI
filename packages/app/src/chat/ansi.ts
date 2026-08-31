/**
 * Minimal ANSI SGR (graphics) parser — enough to colorize terminal output.
 * Maps SGR codes onto the `--color-ansi-*` / `--color-ansi-bright-*` tokens so
 * output follows the active theme. Returns styled segments for rendering.
 */
export interface AnsiSegment {
  text: string;
  /** Tailwind classes (e.g. `text-ansi-green font-bold`). */
  cls: string;
}

export interface AnsiState {
  bg: string;
  bold: boolean;
  dim: boolean;
  fg: string;
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export function parseAnsi(input: string): AnsiSegment[] {
  return parseAnsiWithState(input).segments;
}

export function parseAnsiWithState(
  input: string,
  initialState: AnsiState = emptyAnsiState(),
): { segments: AnsiSegment[]; state: AnsiState } {
  if (!input.includes("\x1b[")) {
    return {
      segments: input ? [{ text: input, cls: ansiClassName(initialState) }] : [],
      state: initialState,
    };
  }

  const segments: AnsiSegment[] = [];
  let { bg, bold, dim, fg } = initialState;
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const flush = (text: string) => {
    if (!text) return;
    segments.push({ text, cls: ansiClassName({ bg, bold, dim, fg }) });
  };

  const apply = (code: number) => {
    if (code === 0) {
      bold = dim = false;
      fg = "";
      bg = "";
    } else if (code === 1) bold = true;
    else if (code === 2) dim = true;
    else if (code === 22) bold = dim = false;
    else if (code >= 30 && code <= 37) fg = NAMES[code - 30];
    else if (code >= 40 && code <= 47) bg = NAMES[code - 40];
    else if (code >= 90 && code <= 97) fg = `bright-${NAMES[code - 90]}`;
    else if (code >= 100 && code <= 107) bg = `bright-${NAMES[code - 100]}`;
    else if (code === 39) fg = "";
    else if (code === 49) bg = "";
  };

  while ((match = re.exec(input)) !== null) {
    flush(input.slice(last, match.index));
    last = match.index + match[0].length;
    const params = match[1] || "0";
    for (const raw of params.split(";")) {
      apply(Number(raw));
    }
  }
  flush(input.slice(last));
  return { segments, state: { bg, bold, dim, fg } };
}

export function emptyAnsiState(): AnsiState {
  return { bg: "", bold: false, dim: false, fg: "" };
}

function ansiClassName({ bg, bold, dim, fg }: AnsiState): string {
  return [
    bold && "font-semibold",
    dim && "opacity-60",
    fg && `text-ansi-${fg}`,
    bg && `bg-ansi-${bg}`,
  ]
    .filter(Boolean)
    .join(" ");
}
