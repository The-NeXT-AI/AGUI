import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import {
  Activity,
  AtSign,
  BrainCircuit,
  CircleHelp,
  FileCode2,
  GitCompareArrows,
  History,
  Minimize2,
  ScanText,
  SearchCode,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { createRoot } from "react-dom/client";
import { Fragment, Schema, Slice, type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";

type ComposerTagKind = "command" | "mention";
type ComposerTagIcon =
  | "command"
  | "compact"
  | "file"
  | "git-diff"
  | "help"
  | "history"
  | "mention"
  | "model"
  | "review"
  | "selection"
  | "shield"
  | "status";

export type ComposerEditorMention = {
  icon: Extract<ComposerTagIcon, "file" | "git-diff" | "mention" | "selection">;
  label: string;
};

export type ComposerEditorHandle = {
  focus(): void;
  setText(text: string, selectionOffset?: number): void;
};

type ComposerEditorProps = {
  ariaDescribedBy?: string;
  commands: string[];
  mentions: ComposerEditorMention[];
  onChange(text: string, selectionOffset: number): void;
  onFiles(files: File[]): void;
  onSuggestionKeyDown(event: globalThis.KeyboardEvent): boolean;
  onSubmit(): void;
  placeholder: string;
  value: string;
};

type LiveComposerEditorProps = Omit<ComposerEditorProps, "value">;
const EMPTY_COMPOSER_TAGS = new Set<string>();

const composerSchema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: {
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    composer_tag: {
      attrs: {
        icon: { default: "mention" },
        kind: { default: "mention" },
        value: { default: "" },
      },
      atom: true,
      group: "inline",
      inline: true,
      selectable: true,
      parseDOM: [
        {
          tag: "span[data-composer-tag]",
          getAttrs: (element) => {
            if (!(element instanceof HTMLElement)) return false;
            return {
              icon: composerTagIcon(element.dataset.composerTagIcon),
              kind: element.dataset.composerTagKind === "command" ? "command" : "mention",
              value: element.dataset.composerTag ?? "",
            };
          },
        },
      ],
      toDOM: (node) => [
        "span",
        {
          "data-composer-tag": node.attrs.value as string,
          "data-composer-tag-icon": node.attrs.icon as ComposerTagIcon,
          "data-composer-tag-kind": node.attrs.kind as ComposerTagKind,
        },
        node.attrs.value as string,
      ],
    },
  },
});

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, forwardedRef) {
    const mountRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const livePropsRef = useRef<LiveComposerEditorProps>(props);
    const initialDocumentRef = useRef({
      commands: props.commands,
      mentions: props.mentions,
      value: props.value,
    });
    livePropsRef.current = props;
    const commandsKey = props.commands.join("\u0000");
    const mentionsKey = props.mentions.join("\u0000");

    const setEditorText = (text: string, selectionOffset = text.length) => {
      const view = viewRef.current;
      if (!view) return;
      updateViewDocument(view, text, selectionOffset, livePropsRef.current);
    };

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus: () => viewRef.current?.focus(),
        setText: setEditorText,
      }),
      [],
    );

    useLayoutEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;

      const initialDocument = initialDocumentRef.current;
      const initialDoc = composerDocumentFromText(
        initialDocument.value,
        initialDocument.mentions,
        initialDocument.commands,
      );
      const view = new EditorView(mount, {
        state: EditorState.create({
          doc: initialDoc,
          schema: composerSchema,
          selection: selectionForPlainTextOffset(initialDoc, initialDocument.value.length),
        }),
        attributes: editorAttributes(livePropsRef.current),
        dispatchTransaction: (transaction) => dispatchComposerTransaction(view, transaction),
        handleDOMEvents: {
          beforeinput: (editorView, event) => {
            if (!(event instanceof InputEvent) || editorView.composing) return false;
            if (event.inputType === "insertParagraph") {
              event.preventDefault();
              livePropsRef.current.onSubmit();
              return true;
            }
            if (event.inputType === "insertLineBreak") {
              event.preventDefault();
              insertHardBreak(editorView);
              return true;
            }
            return false;
          },
        },
        handleDrop: (_editorView, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!files.length) return false;
          event.preventDefault();
          event.stopPropagation();
          livePropsRef.current.onFiles(files);
          return true;
        },
        handleKeyDown: (editorView, event) => {
          if (livePropsRef.current.onSuggestionKeyDown(event)) return true;
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            !event.isComposing &&
            !editorView.composing &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            deleteComposerSelection(editorView, event.key === "Backspace" ? "backward" : "forward");
            return true;
          }
          if (event.key !== "Enter" || event.isComposing || editorView.composing) return false;
          event.preventDefault();
          if (event.shiftKey) insertHardBreak(editorView);
          else livePropsRef.current.onSubmit();
          return true;
        },
        handlePaste: (editorView, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length) {
            event.preventDefault();
            livePropsRef.current.onFiles(files);
            return true;
          }

          const text = event.clipboardData?.getData("text/plain");
          if (text === undefined) return false;
          event.preventDefault();
          insertPlainText(editorView, text.replace(/\r\n?/g, "\n"), livePropsRef.current);
          return true;
        },
        nodeViews: {
          composer_tag: (node) => composerTagNodeView(node),
        },
      });
      viewRef.current = view;

      return () => {
        viewRef.current = null;
        view.destroy();
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.setProps({ attributes: editorAttributes(livePropsRef.current) });
      const currentText = composerTextFromDocument(view.state.doc);
      const desiredDoc = composerDocumentFromText(
        props.value,
        props.mentions,
        props.commands,
        true,
        composerTagValues(view.state.doc),
      );
      if (currentText !== props.value || !view.state.doc.eq(desiredDoc)) {
        const nextSelectionOffset =
          currentText === props.value
            ? plainTextOffsetForPosition(view.state.doc, view.state.selection.head)
            : props.value.length;
        updateViewDocument(view, props.value, nextSelectionOffset, livePropsRef.current, false);
      }
    }, [
      commandsKey,
      mentionsKey,
      props.ariaDescribedBy,
      props.commands,
      props.mentions,
      props.placeholder,
      props.value,
    ]);

    return <div ref={mountRef} className="composer-editor-host" />;

    function dispatchComposerTransaction(editorView: EditorView, transaction: Transaction) {
      const retainedTags = composerTagValues(editorView.state.doc);
      let nextState = editorView.state.apply(transaction);
      composerTagValues(nextState.doc).forEach((value) => retainedTags.add(value));
      const nextText = composerTextFromDocument(nextState.doc);
      const nextSelectionOffset = plainTextOffsetForPosition(
        nextState.doc,
        nextState.selection.head,
      );
      if (transaction.docChanged && !editorView.composing) {
        const normalizedDoc = composerDocumentFromText(
          nextText,
          livePropsRef.current.mentions,
          livePropsRef.current.commands,
          false,
          retainedTags,
        );
        if (!nextState.doc.eq(normalizedDoc)) {
          nextState = EditorState.create({
            doc: normalizedDoc,
            schema: composerSchema,
            selection: selectionForPlainTextOffset(normalizedDoc, nextSelectionOffset),
          });
        }
      }
      editorView.updateState(nextState);
      livePropsRef.current.onChange(
        composerTextFromDocument(nextState.doc),
        plainTextOffsetForPosition(nextState.doc, nextState.selection.head),
      );
    }
  },
);

function editorAttributes(props: LiveComposerEditorProps): Record<string, string> {
  const attributes: Record<string, string> = {
    "aria-label": props.placeholder,
    "aria-multiline": "true",
    class: "composer-editor",
    role: "textbox",
    spellcheck: "true",
  };
  if (props.ariaDescribedBy) attributes["aria-describedby"] = props.ariaDescribedBy;
  return attributes;
}

function updateViewDocument(
  view: EditorView,
  text: string,
  selectionOffset: number,
  props: Pick<LiveComposerEditorProps, "commands" | "mentions" | "onChange">,
  notify = true,
) {
  const doc = composerDocumentFromText(text, props.mentions, props.commands);
  const nextState = EditorState.create({
    doc,
    schema: composerSchema,
    selection: selectionForPlainTextOffset(doc, selectionOffset),
  });
  view.updateState(nextState);
  if (notify) {
    props.onChange(
      composerTextFromDocument(doc),
      plainTextOffsetForPosition(doc, nextState.selection.head),
    );
  }
}

function insertPlainText(
  view: EditorView,
  text: string,
  props: Pick<LiveComposerEditorProps, "commands" | "mentions">,
) {
  if (!text) return;
  const nodes = composerInlineNodesFromText(text, props.mentions, props.commands);
  const slice = new Slice(Fragment.from(nodes), 0, 0);
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
}

function insertHardBreak(view: EditorView) {
  const hardBreak = composerSchema.nodes.hard_break;
  view.dispatch(view.state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
}

function deleteComposerSelection(view: EditorView, direction: "backward" | "forward") {
  const { selection } = view.state;
  if (!selection.empty) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return;
  }

  const tagRange = adjacentComposerTagDeletionRange(view.state.doc, selection.head, direction);
  if (tagRange) {
    view.dispatch(view.state.tr.delete(tagRange.from, tagRange.to).scrollIntoView());
    return;
  }

  const adjacentNode =
    direction === "backward" ? selection.$head.nodeBefore : selection.$head.nodeAfter;
  if (!adjacentNode) return;
  const distance = adjacentNode.isText
    ? adjacentTextUnitLength(adjacentNode.text ?? "", direction)
    : adjacentNode.nodeSize;
  const from = direction === "backward" ? selection.head - distance : selection.head;
  const to = direction === "backward" ? selection.head : selection.head + distance;
  view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
}

function adjacentComposerTagDeletionRange(
  doc: ProseMirrorNode,
  position: number,
  direction: "backward" | "forward",
): { from: number; to: number } | null {
  const resolved = doc.resolve(position);

  if (direction === "backward") {
    const nodeBefore = resolved.nodeBefore;
    if (nodeBefore?.type === composerSchema.nodes.composer_tag) {
      return { from: position - nodeBefore.nodeSize, to: position };
    }
    if (!nodeBefore?.isText || !nodeBefore.text?.endsWith(" ")) return null;

    const tagEnd = position - 1;
    const tag = doc.resolve(tagEnd).nodeBefore;
    return tag?.type === composerSchema.nodes.composer_tag
      ? { from: tagEnd - tag.nodeSize, to: position }
      : null;
  }

  const nodeAfter = resolved.nodeAfter;
  if (nodeAfter?.type !== composerSchema.nodes.composer_tag) return null;

  const tagEnd = position + nodeAfter.nodeSize;
  const trailingNode = doc.resolve(tagEnd).nodeAfter;
  const trailingSpace = trailingNode?.isText && trailingNode.text?.startsWith(" ") ? 1 : 0;
  return { from: position, to: tagEnd + trailingSpace };
}

function adjacentTextUnitLength(text: string, direction: "backward" | "forward"): number {
  const value = direction === "backward" ? Array.from(text).at(-1) : Array.from(text)[0];
  return value?.length ?? 1;
}

function composerDocumentFromText(
  text: string,
  mentions: ComposerEditorMention[],
  commands: string[],
  allowTerminalKnownTags = true,
  retainedTerminalTags: ReadonlySet<string> = EMPTY_COMPOSER_TAGS,
) {
  return composerSchema.node("doc", null, [
    composerSchema.node(
      "paragraph",
      null,
      composerInlineNodesFromText(
        text,
        mentions,
        commands,
        allowTerminalKnownTags,
        retainedTerminalTags,
      ),
    ),
  ]);
}

function composerInlineNodesFromText(
  text: string,
  mentions: ComposerEditorMention[],
  commands: string[],
  allowTerminalKnownTags = true,
  retainedTerminalTags: ReadonlySet<string> = EMPTY_COMPOSER_TAGS,
) {
  const nodes: ProseMirrorNode[] = [];
  const knownMentions = mentions
    .filter((mention) => mention.label)
    .map((mention) => ({
      icon: mention.icon,
      value: mention.label.startsWith("@") ? mention.label : `@${mention.label}`,
    }))
    .sort((left, right) => right.value.length - left.value.length);
  const knownCommands = new Set(
    commands.filter(Boolean).map((value) => (value.startsWith("/") ? value : `/${value}`)),
  );
  let textStart = 0;
  let index = 0;

  const flushText = (end: number) => {
    if (textStart >= end) return;
    const value = text.slice(textStart, end);
    const chunks = value.split("\n");
    chunks.forEach((chunk, chunkIndex) => {
      if (chunk) nodes.push(composerSchema.text(chunk));
      if (chunkIndex < chunks.length - 1) nodes.push(composerSchema.nodes.hard_break.create());
    });
  };

  while (index < text.length) {
    const tag = composerTagAt(
      text,
      index,
      knownMentions,
      knownCommands,
      allowTerminalKnownTags,
      retainedTerminalTags,
    );
    if (!tag) {
      index += 1;
      continue;
    }
    flushText(index);
    nodes.push(composerSchema.nodes.composer_tag.create(tag));
    index += tag.value.length;
    textStart = index;
  }
  flushText(text.length);
  return nodes;
}

function composerTagAt(
  text: string,
  index: number,
  knownMentions: Array<{ icon: ComposerTagIcon; value: string }>,
  knownCommands: Set<string>,
  allowTerminalKnownTags: boolean,
  retainedTerminalTags: ReadonlySet<string>,
): { icon: ComposerTagIcon; kind: ComposerTagKind; value: string } | null {
  if (index > 0 && !/\s/.test(text[index - 1])) return null;

  if (text[index] === "@") {
    const mention = knownMentions.find(
      ({ value }) => text.startsWith(value, index) && hasTagEndBoundary(text, index + value.length),
    );
    const hasExplicitBoundary = mention ? index + mention.value.length < text.length : false;
    return mention &&
      (hasExplicitBoundary || allowTerminalKnownTags || retainedTerminalTags.has(mention.value))
      ? { icon: mention.icon, kind: "mention", value: mention.value }
      : null;
  }

  if (text[index] !== "/" || (index > 0 && text[index - 1] !== "\n")) return null;
  const value = /^\/[A-Za-z][\w.-]*/.exec(text.slice(index))?.[0];
  if (!value || !hasTagEndBoundary(text, index + value.length)) return null;
  const hasExplicitBoundary = index + value.length < text.length;
  return hasExplicitBoundary ||
    retainedTerminalTags.has(value) ||
    (allowTerminalKnownTags && knownCommands.has(value))
    ? { icon: commandTagIcon(value), kind: "command", value }
    : null;
}

function hasTagEndBoundary(text: string, index: number) {
  return index >= text.length || /[\s.,;:!?()[\]{}"']/.test(text[index]);
}

function composerTextFromDocument(doc: ProseMirrorNode): string {
  let text = "";
  doc.descendants((node) => {
    if (node.isText) text += node.text ?? "";
    else if (node.type === composerSchema.nodes.hard_break) text += "\n";
    else if (node.type === composerSchema.nodes.composer_tag) text += node.attrs.value as string;
  });
  return text;
}

function composerTagValues(doc: ProseMirrorNode): Set<string> {
  const values = new Set<string>();
  doc.descendants((node) => {
    if (node.type === composerSchema.nodes.composer_tag) {
      values.add(String(node.attrs.value ?? ""));
    }
  });
  return values;
}

function selectionForPlainTextOffset(doc: ProseMirrorNode, offset: number) {
  return TextSelection.create(doc, positionForPlainTextOffset(doc, offset));
}

function positionForPlainTextOffset(doc: ProseMirrorNode, offset: number): number {
  const target = Math.max(0, offset);
  let plainOffset = 0;
  let position = 1;
  const paragraph = doc.firstChild;
  if (!paragraph) return position;

  for (const node of paragraph.content.content) {
    const value = plainTextForNode(node);
    if (target <= plainOffset + value.length) {
      if (node.isText) return position + Math.max(0, target - plainOffset);
      return target === plainOffset ? position : position + node.nodeSize;
    }
    plainOffset += value.length;
    position += node.nodeSize;
  }
  return position;
}

function plainTextOffsetForPosition(doc: ProseMirrorNode, targetPosition: number): number {
  let plainOffset = 0;
  let position = 1;
  const paragraph = doc.firstChild;
  if (!paragraph) return plainOffset;

  for (const node of paragraph.content.content) {
    const value = plainTextForNode(node);
    if (targetPosition <= position + node.nodeSize) {
      if (node.isText) {
        return plainOffset + Math.max(0, Math.min(value.length, targetPosition - position));
      }
      return targetPosition <= position ? plainOffset : plainOffset + value.length;
    }
    plainOffset += value.length;
    position += node.nodeSize;
  }
  return plainOffset;
}

function plainTextForNode(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type === composerSchema.nodes.hard_break) return "\n";
  if (node.type === composerSchema.nodes.composer_tag) return node.attrs.value as string;
  return "";
}

function composerTagNodeView(node: ProseMirrorNode): NodeView {
  const kind = node.attrs.kind === "command" ? "command" : "mention";
  const iconName = composerTagIcon(node.attrs.icon);
  const value = String(node.attrs.value ?? "");
  const dom = document.createElement("span");
  dom.className = "composer-tag";
  dom.contentEditable = "false";
  dom.dataset.composerTag = value;
  dom.dataset.composerTagIcon = iconName;
  dom.dataset.composerTagKind = kind;
  dom.setAttribute("aria-label", value);

  const icon = document.createElement("span");
  icon.className = "composer-tag-icon";
  icon.setAttribute("aria-hidden", "true");
  const iconRoot = createRoot(icon);
  iconRoot.render(
    createElement(COMPOSER_TAG_ICONS[iconName], {
      "aria-hidden": true,
      focusable: false,
      size: 12,
      strokeWidth: 2.2,
    }),
  );

  const label = document.createElement("span");
  label.className = "composer-tag-label";
  label.textContent = kind === "mention" && value.startsWith("@") ? value.slice(1) : value;
  dom.append(icon, label);
  return { destroy: () => iconRoot.unmount(), dom };
}

const COMPOSER_TAG_ICONS: Record<ComposerTagIcon, LucideIcon> = {
  command: SquareTerminal,
  compact: Minimize2,
  file: FileCode2,
  "git-diff": GitCompareArrows,
  help: CircleHelp,
  history: History,
  mention: AtSign,
  model: BrainCircuit,
  review: SearchCode,
  selection: ScanText,
  shield: ShieldCheck,
  status: Activity,
};

function composerTagIcon(value: unknown): ComposerTagIcon {
  return typeof value === "string" && value in COMPOSER_TAG_ICONS
    ? (value as ComposerTagIcon)
    : "mention";
}

function commandTagIcon(value: string): ComposerTagIcon {
  const command = value.replace(/^\//, "").toLowerCase();
  if (/(diff|change|patch)/.test(command)) return "git-diff";
  if (/(review|inspect|search|find)/.test(command)) return "review";
  if (/(compact|summari[sz]e|shorten)/.test(command)) return "compact";
  if (/(help|docs?|guide)/.test(command)) return "help";
  if (/(resume|history|session|thread)/.test(command)) return "history";
  if (/(approval|permission|sandbox|security)/.test(command)) return "shield";
  if (/(model|agent|reason)/.test(command)) return "model";
  if (/(status|doctor|health|usage)/.test(command)) return "status";
  return "command";
}
