import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import {
  ArrowUp,
  CircleAlert,
  CornerDownLeft,
  FileCode2,
  GitCompareArrows,
  MessageSquare,
  Mic,
  Paperclip,
  ScanText,
  Settings,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useCommands, useComposerControls } from "@the-next-ai/app";
import { useChatStore } from "@/chat/chat-store";
import { contextUsageForSession } from "@/chat/context-usage";
import { useUIStore, type BrowserAnnotationsDraft } from "@/ui/ui-store";
import { toast } from "@/ui/toast";
import { uid } from "@/ui/id";
import { t, useI18nStore, type Lang } from "@/lib/i18n";
import { cn } from "@/ui/cn";
import { Tip } from "@/ui/tooltip";
import type { Attachment, ContextUsage } from "@/chat/types";
import { useAspStore } from "@/asp/asp-store";
import { desktopApi } from "@/asp/desktop-api";
import type { AspSlashCommand } from "@/asp/desktop-api";
import { ApprovalInputCard, QuestionInputCard } from "@/asp/AspDialogs";
import { UIRegion } from "@/product/UIRegion";
import { useWorkspaceStore } from "@/workspaces/workspace-store";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorMention,
} from "@/shell/ComposerEditor";

/**
 * The floating composer — the signature AGUI element. A large rounded input
 * with a toolbar row below. Beyond plain text it supports:
 *  - file/image attachments (attach button, drag-drop, paste)
 *  - `/` slash commands (filters the registered commands)
 *  - `@` mentions (context/file suggestions)
 *  - a (mock) voice toggle
 * Enter sends, Shift+Enter inserts a newline.
 */

// Mock mention targets — replace with a real file/context source.
const MENTIONS = [
  { icon: "file", label: "src/math.ts", hint: "file" },
  { icon: "file", label: "package.json", hint: "file" },
  { icon: "file", label: "README.md", hint: "file" },
  { icon: "selection", label: "current selection", hint: "context" },
  { icon: "git-diff", label: "git diff", hint: "context" },
] as const;
const EDITOR_MENTIONS: ComposerEditorMention[] = MENTIONS.map(({ icon, label }) => ({
  icon,
  label,
}));
const MENTION_MENU_ICONS = {
  file: FileCode2,
  "git-diff": GitCompareArrows,
  selection: ScanText,
} as const;
const EMPTY_AGENT_COMMANDS: AspSlashCommand[] = [];
const COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS =
  "outline-none focus:outline-none focus-visible:outline-none";
const VOICE_LEVEL_BAR_COUNT = 36;
const IDLE_VOICE_LEVELS = createIdleVoiceLevels();

type VoiceRecordingState = "idle" | "starting" | "recording";
type VoiceDraftAnchor = { baseText: string; insertionOffset: number };

type BrowserSpeechRecognitionAlternative = {
  transcript: string;
};

type BrowserSpeechRecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative | undefined;
};

type BrowserSpeechRecognitionResultList = {
  length: number;
  [index: number]: BrowserSpeechRecognitionResult | undefined;
};

type BrowserSpeechRecognitionResultEvent = {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
};

type BrowserSpeechRecognitionErrorEvent = {
  error: string;
  message?: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  abort(): void;
  start(): void;
  stop(): void;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type BrowserWindowWithVoiceApis = Window &
  typeof globalThis & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitAudioContext?: typeof AudioContext;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };

export function Composer() {
  const [text, setText] = useState("");
  const [selectionOffset, setSelectionOffset] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editing, setEditing] = useState<{ blockId: string; sessionId: string } | null>(null);
  const [recordingState, setRecordingState] = useState<VoiceRecordingState>("idle");
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [voiceLevels, setVoiceLevels] = useState<number[]>(IDLE_VOICE_LEVELS);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceRecordedChunksRef = useRef<Blob[]>([]);
  const voiceShouldSaveRecordingRef = useRef(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voiceAnimationFrameRef = useRef<number | null>(null);
  const voiceDurationTimerRef = useRef<number | null>(null);
  const voiceStartedAtRef = useRef(0);
  const voiceDraftAnchorRef = useRef<VoiceDraftAnchor | null>(null);
  const voiceApplyingTranscriptRef = useRef(false);
  const voiceFinalTranscriptRef = useRef("");
  const voiceInterimTranscriptRef = useRef("");
  const voiceRecognitionSegmentsRef = useRef<Map<number, { final: boolean; text: string }>>(
    new Map(),
  );

  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const removeQueuedPrompt = useChatStore((s) => s.removeQueuedPrompt);
  const steerQueuedPrompt = useChatStore((s) => s.steerQueuedPrompt);
  const lang = useI18nStore((state) => state.lang);
  const browserAnnotationsDraft = useUIStore((state) => state.browserAnnotationsDraft);
  const activeSession = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const activeSessionId = activeSession?.id;
  const streaming = Boolean(
    activeSession &&
    (activeSession.status === "streaming" ||
      activeSession.activeRunId ||
      activeSession.activeRunRequestId),
  );
  const workspaceInitialized = useWorkspaceStore((s) => s.initialized);
  const hasPendingApproval = useAspStore((s) =>
    activeSession
      ? s.approvalQueue.some((request) => request.uiSessionId === activeSession.id)
      : false,
  );
  const providers = useAspStore((s) => s.providers);
  const aspAvailable = useAspStore((s) => s.available);
  const aspInitialized = useAspStore((s) => s.initialized);
  const preferredProviderId = useAspStore((s) => s.activeProviderId);
  const draftProviderId = useChatStore((s) => s.draftSession?.providerId);
  const selectedProviderId = activeSession?.providerId || draftProviderId || preferredProviderId;
  const selectedProvider = providers.find(
    (provider) => provider.id === selectedProviderId && provider.enabled,
  );
  const queuedPrompts = activeSession?.queuedPrompts ?? [];
  const agentReadiness = !aspInitialized
    ? {
        title: t("composer.agent.connectingTitle"),
        description: t("composer.agent.connectingDescription"),
        configurable: false,
      }
    : !aspAvailable
      ? {
          title: t("composer.agent.runtimeUnavailableTitle"),
          description: t("composer.agent.runtimeUnavailableDescription"),
          configurable: false,
        }
      : !selectedProvider
        ? {
            title: t("composer.agent.notConfiguredTitle"),
            description: t("composer.agent.notConfiguredDescription"),
            configurable: true,
          }
        : null;
  const contextUsage = useMemo(
    () => (activeSession ? contextUsageForSession(activeSession, providers) : undefined),
    [activeSession, providers],
  );
  const hasActiveSession = useChatStore((s) =>
    Boolean(s.activeSessionId && s.sessions.some((session) => session.id === s.activeSessionId)),
  );
  const controls = useComposerControls();
  const commands = useCommands();
  const agentCommands = useChatStore(
    (state) =>
      state.sessions.find((session) => session.id === state.activeSessionId)?.availableCommands ??
      EMPTY_AGENT_COMMANDS,
  );
  const agentCommandNames = useMemo(
    () => agentCommands.map((command) => command.name),
    [agentCommands],
  );
  const left = controls.filter((c) => c.align === "left");
  const right = controls.filter((c) => c.align === "right");
  const recording = recordingState !== "idle";
  const voiceInputSupported = isVoiceInputSupported();
  const editingCurrentMessage = editing && editing.sessionId === activeSession?.id;
  const editingLockedByRun = Boolean(editingCurrentMessage && streaming);
  const [steeringQueuedPromptId, setSteeringQueuedPromptId] = useState<string | null>(null);

  const setTextWithSelection = (next: string, selectionOffset = next.length) => {
    setText(next);
    setSelectionOffset(selectionOffset);
    editorRef.current?.setText(next, selectionOffset);
  };

  // Edit-and-resend: when editUserMessage sets a draft, load it into the field.
  const editDraft = useUIStore((s) => s.editDraft);
  useEffect(() => {
    if (editDraft !== null) {
      setEditing(null);
      setTextWithSelection(editDraft);
      useUIStore.getState().setEditDraft(null);
      focusComposer();
    }
  }, [editDraft]);

  const composerInsertRequest = useUIStore((s) => s.composerInsertRequest);
  useEffect(() => {
    if (!composerInsertRequest) return;
    setEditing(null);
    const next = composerTextWithInsertion(
      text,
      composerInsertRequest.text,
      composerInsertRequest.mode,
    );
    setTextWithSelection(next.text, next.selectionOffset);
    useUIStore.getState().clearComposerInsertRequest();
    focusComposer();
  }, [composerInsertRequest, text]);

  const messageEditDraft = useUIStore((s) => s.messageEditDraft);
  useEffect(() => {
    if (!messageEditDraft) return;
    setEditing({ blockId: messageEditDraft.blockId, sessionId: messageEditDraft.sessionId });
    setTextWithSelection(messageEditDraft.text);
    setAttachments(messageEditDraft.attachments ?? []);
    useUIStore.getState().setMessageEditDraft(null);
    focusComposer();
  }, [messageEditDraft]);

  useEffect(() => {
    const nextAttachments =
      browserAnnotationsDraft?.annotations.length || browserAnnotationsDraft?.snapshots?.length
        ? browserAnnotationsAttachments(browserAnnotationsDraft)
        : [];
    setAttachments((prev) => syncBrowserAnnotationsAttachments(prev, nextAttachments));
  }, [browserAnnotationsDraft, lang]);

  const removeComposerAttachment = (attachmentId: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
    removeBrowserContextAttachment(attachmentId);
  };

  useEffect(() => {
    if (!workspaceInitialized || !activeSessionId) return;
    useChatStore.getState().restoreSessionRunSettings(activeSessionId);
  }, [activeSessionId, activeSession?.providerId, workspaceInitialized]);

  useEffect(() => {
    if (editing && editing.sessionId !== activeSession?.id) {
      setEditing(null);
      setTextWithSelection("", 0);
      setAttachments([]);
    }
  }, [activeSession?.id, editing]);

  /* ----- slash command menu (triggered at the start of the prompt) ----- */
  const slashTrigger = useMemo(
    () => composerSlashTrigger(text, selectionOffset),
    [selectionOffset, text],
  );
  const slashQuery = slashTrigger?.query.toLowerCase() ?? null;
  const slashList = useMemo(() => {
    if (slashQuery === null) return [];
    const local = Object.values(commands)
      .filter((command) => !command.hidden)
      .map((command) => ({ ...command, agentName: undefined as string | undefined }));
    const remote = agentCommands.map((command) => ({
      id: `asp.${command.name}`,
      title: `/${command.name} — ${command.description}`,
      handler: () => undefined,
      agentName: command.name,
      icon: SquareTerminal,
      keybinding: undefined as string | undefined,
    }));
    return [...remote, ...local]
      .filter((command) => command.title.toLowerCase().includes(slashQuery))
      .slice(0, 6);
  }, [agentCommands, commands, slashQuery]);
  const [slashActive, setSlashActive] = useState(0);
  useEffect(() => setSlashActive(0), [slashQuery]);

  /* ----- @mention menu (triggered by an @term immediately before the caret) ----- */
  const mentionTrigger = useMemo(
    () => composerMentionTrigger(text, selectionOffset),
    [selectionOffset, text],
  );
  const mentionQuery = mentionTrigger?.query.toLowerCase() ?? null;
  const mentionList = useMemo(() => {
    if (mentionQuery === null) return [];
    return MENTIONS.filter((m) => m.label.toLowerCase().includes(mentionQuery)).slice(0, 5);
  }, [mentionQuery]);
  const [mentionActive, setMentionActive] = useState(0);
  useEffect(() => setMentionActive(0), [mentionQuery]);

  const showSlash = slashList.length > 0;
  const showMention = !showSlash && mentionList.length > 0;

  const submit = () => {
    if ((!text.trim() && attachments.length === 0) || agentReadiness || editingLockedByRun) return;
    if (recording) finishVoiceInput({ abort: true, focus: false });
    const editBlockId = editingCurrentMessage ? editing.blockId : undefined;
    send(text, attachments, editBlockId ? { editBlockId } : undefined);
    setEditing(null);
    setTextWithSelection("", 0);
    setAttachments([]);
  };

  const insertQueuedPrompt = async (promptId: string) => {
    if (!activeSessionId || steeringQueuedPromptId) return;
    setSteeringQueuedPromptId(promptId);
    try {
      await steerQueuedPrompt(activeSessionId, promptId);
    } finally {
      setSteeringQueuedPromptId(null);
    }
  };

  const insertMention = (label: string) => {
    if (!mentionTrigger) return;
    const replacement = `@${label} `;
    const next = `${text.slice(0, mentionTrigger.start)}${replacement}${text.slice(mentionTrigger.end)}`;
    setTextWithSelection(next, mentionTrigger.start + replacement.length);
    focusComposer();
  };

  const onSuggestionKeyDown = (e: globalThis.KeyboardEvent) => {
    if (showSlash) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((i) => Math.min(i + 1, slashList.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashList[slashActive];
        if (cmd) {
          if (cmd.agentName && slashTrigger) {
            const replacement = `/${cmd.agentName} `;
            const next = `${text.slice(0, slashTrigger.start)}${replacement}${text.slice(slashTrigger.end)}`;
            setTextWithSelection(next, slashTrigger.start + replacement.length);
          } else {
            cmd.handler();
            setTextWithSelection("", 0);
          }
        }
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTextWithSelection("", 0);
        return true;
      }
    }
    if (showMention) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActive((i) => Math.min(i + 1, mentionList.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActive((i) => Math.max(i - 1, 0));
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const item = mentionList[mentionActive];
        if (item) insertMention(item.label);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return true;
      }
    }
    return false;
  };

  const focusComposer = () => {
    const focus = () => editorRef.current?.focus();
    focus();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(focus);
      window.setTimeout(focus, 0);
    }
  };

  const clearVoiceDurationTimer = () => {
    if (voiceDurationTimerRef.current === null || typeof window === "undefined") return;
    window.clearInterval(voiceDurationTimerRef.current);
    voiceDurationTimerRef.current = null;
  };

  const cleanupVoiceCapture = () => {
    if (voiceAnimationFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(voiceAnimationFrameRef.current);
      voiceAnimationFrameRef.current = null;
    }
    clearVoiceDurationTimer();
    try {
      voiceAudioSourceRef.current?.disconnect();
    } catch {
      // The node can already be disconnected after browser-level audio teardown.
    }
    voiceAudioSourceRef.current = null;
    const audioContext = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  };

  const persistVoiceRecording = async (blob: Blob) => {
    const api = desktopApi();
    if (api?.transport !== "electron" || !api.voice?.saveRecording || blob.size === 0) return;
    try {
      const saved = await api.voice.saveRecording({
        dataBase64: await blobToBase64(blob),
        extension: voiceRecordingExtension(blob.type),
        mime: blob.type || "audio/webm",
      });
      setAttachments((prev) => [
        ...prev,
        {
          id: uid("att"),
          kind: "file",
          mime: saved.mime,
          name: saved.name,
          path: saved.path,
          size: saved.size,
        },
      ]);
      focusComposer();
    } catch (error) {
      console.warn("Failed to save voice recording.", error);
      toast.error(t("composer.voiceErrorTitle"), t("composer.voiceSaveErrorDescription"));
    }
  };

  const stopVoiceMediaRecorder = (save: boolean) => {
    const recorder = voiceMediaRecorderRef.current;
    voiceMediaRecorderRef.current = null;
    voiceShouldSaveRecordingRef.current = save;
    if (!recorder) {
      voiceRecordedChunksRef.current = [];
      voiceShouldSaveRecordingRef.current = false;
      return;
    }
    if (recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch (error) {
      console.warn("Failed to stop voice recorder.", error);
      voiceRecordedChunksRef.current = [];
      voiceShouldSaveRecordingRef.current = false;
    }
  };

  const finishVoiceInput = (
    options: { abort?: boolean; focus?: boolean; skipRecognitionStop?: boolean } = {},
  ) => {
    stopVoiceMediaRecorder(!options.abort);
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      if (!options.skipRecognitionStop) {
        try {
          if (options.abort) recognition.abort();
          else recognition.stop();
        } catch {
          // SpeechRecognition throws if it has already stopped.
        }
      }
    }
    cleanupVoiceCapture();
    voiceDraftAnchorRef.current = null;
    voiceApplyingTranscriptRef.current = false;
    voiceFinalTranscriptRef.current = "";
    voiceInterimTranscriptRef.current = "";
    voiceRecognitionSegmentsRef.current.clear();
    setRecordingState("idle");
    setRecordingDurationMs(0);
    setVoiceLevels(IDLE_VOICE_LEVELS);
    if (options.focus !== false) focusComposer();
  };

  const applyVoiceTranscript = (transcript: string) => {
    const anchor = voiceDraftAnchorRef.current;
    if (!anchor) return;
    const normalizedTranscript = normalizeRecognizedText(transcript);
    const next = insertTranscriptAtAnchor(anchor, normalizedTranscript);
    voiceApplyingTranscriptRef.current = true;
    setTextWithSelection(next.text, next.selectionOffset);
    voiceApplyingTranscriptRef.current = false;
  };

  const handleVoiceRecognitionResult = (event: BrowserSpeechRecognitionResultEvent) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result?.[0];
      if (!result || !alternative) continue;
      voiceRecognitionSegmentsRef.current.set(i, {
        final: result.isFinal,
        text: normalizeRecognizedText(alternative.transcript),
      });
    }
    const segments = Array.from(voiceRecognitionSegmentsRef.current)
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .filter((value) => value.text);
    voiceFinalTranscriptRef.current = normalizeRecognizedText(
      segments
        .filter((value) => value.final)
        .map((value) => value.text)
        .join(" "),
    );
    voiceInterimTranscriptRef.current = normalizeRecognizedText(
      segments
        .filter((value) => !value.final)
        .map((value) => value.text)
        .join(" "),
    );
    applyVoiceTranscript(
      [voiceFinalTranscriptRef.current, voiceInterimTranscriptRef.current]
        .filter(Boolean)
        .join(" "),
    );
  };

  const handleVoiceRecognitionError = (event: BrowserSpeechRecognitionErrorEvent) => {
    if (event.error === "aborted") return;
    if (event.error === "no-speech") {
      toast.info(t("composer.voiceNoSpeechTitle"), t("composer.voiceNoSpeechDescription"));
      return;
    }
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      toast.error(t("composer.voicePermissionTitle"), t("composer.voicePermissionDescription"));
      return;
    }
    toast.error(
      t("composer.voiceErrorTitle"),
      event.message || t("composer.voiceErrorDescription"),
    );
  };

  const startVoiceLevelLoop = (analyser: AnalyserNode) => {
    if (voiceAnimationFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(voiceAnimationFrameRef.current);
    }
    const buffer = new Uint8Array(analyser.fftSize);
    let lastSampleAt = 0;
    const tick = (now: number) => {
      analyser.getByteTimeDomainData(buffer);
      if (now - lastSampleAt >= 48) {
        setVoiceLevels((prev) => nextVoiceLevels(prev, voiceLevelFromTimeDomainData(buffer)));
        lastSampleAt = now;
      }
      voiceAnimationFrameRef.current = window.requestAnimationFrame(tick);
    };
    voiceAnimationFrameRef.current = window.requestAnimationFrame(tick);
  };

  const startDesktopVoiceRecorder = (stream: MediaStream): boolean => {
    const api = desktopApi();
    if (
      api?.transport !== "electron" ||
      !api.voice?.saveRecording ||
      typeof MediaRecorder === "undefined"
    ) {
      return false;
    }
    const mimeType = preferredVoiceRecordingMimeType();
    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceRecordedChunksRef.current = [];
      voiceShouldSaveRecordingRef.current = true;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceRecordedChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const shouldSave = voiceShouldSaveRecordingRef.current;
        const chunks = voiceRecordedChunksRef.current;
        voiceRecordedChunksRef.current = [];
        voiceShouldSaveRecordingRef.current = false;
        if (!shouldSave || !chunks.length) return;
        const type = recorder.mimeType || mimeType || "audio/webm";
        void persistVoiceRecording(new Blob(chunks, { type }));
      };
      recorder.onerror = (event) => {
        console.warn("Voice recorder error.", event);
      };
      recorder.start(250);
      voiceMediaRecorderRef.current = recorder;
      return true;
    } catch (error) {
      console.warn("Failed to start voice recorder.", error);
      voiceRecordedChunksRef.current = [];
      voiceShouldSaveRecordingRef.current = false;
      return false;
    }
  };

  const ensureDesktopMicrophoneAccess = async () => {
    const api = desktopApi();
    if (api?.transport !== "electron" || !api.permissions?.requestMicrophone) return true;
    const result = await api.permissions.requestMicrophone();
    if (result.granted) return true;
    void api.permissions.openMicrophoneSettings?.();
    toast.error(
      t("composer.voicePermissionTitle"),
      t("composer.voiceDesktopPermissionDescription", {
        status: result.status,
        previousStatus: result.previousStatus ?? result.status,
      }),
    );
    return false;
  };

  const startVoiceInput = async () => {
    if (recordingState !== "idle") return;
    const SpeechRecognition = resolveSpeechRecognitionConstructor();
    const AudioContextCtor = resolveAudioContextConstructor();
    const canSaveDesktopRecording = canSaveDesktopVoiceRecording();
    if (
      !voiceInputSupported ||
      !AudioContextCtor ||
      (!SpeechRecognition && !canSaveDesktopRecording)
    ) {
      toast.error(t("composer.voiceUnsupportedTitle"), t("composer.voiceUnsupportedDescription"));
      return;
    }

    setRecordingState("starting");
    setRecordingDurationMs(0);
    setVoiceLevels(createIdleVoiceLevels());
    voiceDraftAnchorRef.current = {
      baseText: text,
      insertionOffset: boundedTextOffset(text, selectionOffset),
    };
    voiceFinalTranscriptRef.current = "";
    voiceInterimTranscriptRef.current = "";
    voiceRecognitionSegmentsRef.current.clear();

    try {
      if (!(await ensureDesktopMicrophoneAccess())) {
        finishVoiceInput({ abort: true, focus: false });
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      voiceStreamRef.current = stream;
      await waitForLiveAudioTrack(stream);

      const audioContext = new AudioContextCtor();
      voiceAudioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      voiceAudioSourceRef.current = source;
      startVoiceLevelLoop(analyser);

      const desktopRecorderStarted = startDesktopVoiceRecorder(stream);
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = speechRecognitionLanguage(lang);
        recognition.onresult = handleVoiceRecognitionResult;
        recognition.onerror = (event) => {
          if (desktopRecorderStarted && !isSpeechRecognitionPermissionError(event.error)) {
            console.warn(
              "Speech recognition failed; keeping desktop voice recording active.",
              event,
            );
            if (speechRecognitionRef.current === recognition) speechRecognitionRef.current = null;
            recognition.onend = null;
            recognition.onerror = null;
            recognition.onresult = null;
            return;
          }
          handleVoiceRecognitionError(event);
          finishVoiceInput({ abort: true, focus: false });
        };
        recognition.onend = () => {
          if (speechRecognitionRef.current !== recognition) return;
          if (desktopRecorderStarted) {
            speechRecognitionRef.current = null;
            return;
          }
          finishVoiceInput({ skipRecognitionStop: true });
        };
        speechRecognitionRef.current = recognition;
        try {
          recognition.start();
        } catch (error) {
          speechRecognitionRef.current = null;
          if (!desktopRecorderStarted) throw error;
          console.warn("Speech recognition could not start; using desktop audio recording.", error);
        }
      } else if (!desktopRecorderStarted) {
        throw new Error("No supported voice input engine is available.");
      }

      voiceStartedAtRef.current = Date.now();
      voiceDurationTimerRef.current = window.setInterval(() => {
        setRecordingDurationMs(Date.now() - voiceStartedAtRef.current);
      }, 250);
      setRecordingState("recording");
    } catch (error) {
      finishVoiceInput({ abort: true, focus: false });
      if (isMicrophonePermissionError(error)) {
        toast.error(t("composer.voicePermissionTitle"), t("composer.voicePermissionDescription"));
      } else {
        toast.error(t("composer.voiceErrorTitle"), t("composer.voiceErrorDescription"));
      }
    }
  };

  const toggleVoiceInput = () => {
    if (recording) {
      finishVoiceInput();
    } else {
      void startVoiceInput();
    }
  };

  useEffect(() => {
    const recognitionSegments = voiceRecognitionSegmentsRef.current;
    return () => {
      const recorder = voiceMediaRecorderRef.current;
      voiceMediaRecorderRef.current = null;
      voiceRecordedChunksRef.current = [];
      voiceShouldSaveRecordingRef.current = false;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // MediaRecorder may already have stopped during teardown.
        }
      }
      const recognition = speechRecognitionRef.current;
      speechRecognitionRef.current = null;
      if (recognition) {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        try {
          recognition.abort();
        } catch {
          // Browser may already have stopped recognition.
        }
      }
      if (voiceAnimationFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(voiceAnimationFrameRef.current);
        voiceAnimationFrameRef.current = null;
      }
      if (voiceDurationTimerRef.current !== null && typeof window !== "undefined") {
        window.clearInterval(voiceDurationTimerRef.current);
        voiceDurationTimerRef.current = null;
      }
      try {
        voiceAudioSourceRef.current?.disconnect();
      } catch {
        // Ignore disconnect races during unmount or session changes.
      }
      voiceAudioSourceRef.current = null;
      const audioContext = voiceAudioContextRef.current;
      voiceAudioContextRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => undefined);
      }
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current = null;
      voiceDraftAnchorRef.current = null;
      voiceApplyingTranscriptRef.current = false;
      voiceFinalTranscriptRef.current = "";
      voiceInterimTranscriptRef.current = "";
      recognitionSegments.clear();
      setRecordingState("idle");
      setRecordingDurationMs(0);
      setVoiceLevels(IDLE_VOICE_LEVELS);
    };
  }, [activeSessionId]);

  const addFiles = (files: FileList | File[]) => {
    const selectedFiles = Array.from(files);
    if (!selectedFiles.length) return;
    selectedFiles.forEach((file) => {
      const kind: Attachment["kind"] = file.type.startsWith("image/") ? "image" : "file";
      const base: Attachment = {
        id: uid("att"),
        name: file.name,
        kind,
        path: desktopApi()?.files.getPath(file) || undefined,
        mime: file.type,
        size: file.size,
      };
      if (kind === "image") {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments((prev) => [...prev, { ...base, url: String(reader.result) }]);
          focusComposer();
        };
        reader.readAsDataURL(file);
      } else {
        setAttachments((prev) => [...prev, base]);
      }
    });
    focusComposer();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const canSend =
    (!!text.trim() || attachments.length > 0) && !agentReadiness && !editingLockedByRun;

  return (
    <div className="mobile-composer bg-canvas shrink-0 px-3 pt-2 pb-4">
      {/* slash command menu */}
      {showSlash ? (
        <UIRegion
          id="composer.slashMenu"
          data={{ commands: slashList.map((item) => ({ id: item.id, title: item.title })) }}
        >
          <div className="composer-suggestion-menu ui-popover-surface mx-auto mb-1 w-full max-w-[var(--thread-max-width)] overflow-hidden rounded-lg">
            {slashList.map((cmd, i) => {
              const Icon = cmd.icon ?? SquareTerminal;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  data-active={i === slashActive ? "true" : undefined}
                  onMouseEnter={() => setSlashActive(i)}
                  onClick={() => {
                    if (cmd.agentName && slashTrigger) {
                      const replacement = `/${cmd.agentName} `;
                      const next = `${text.slice(0, slashTrigger.start)}${replacement}${text.slice(slashTrigger.end)}`;
                      setTextWithSelection(next, slashTrigger.start + replacement.length);
                    } else {
                      cmd.handler();
                      setTextWithSelection("", 0);
                    }
                    focusComposer();
                  }}
                  className={cn(
                    "composer-suggestion-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px]",
                  )}
                >
                  <span className="composer-suggestion-icon" aria-hidden="true">
                    <Icon size={14} strokeWidth={2.1} />
                  </span>
                  <span className="flex-1">{cmd.title}</span>
                  {cmd.keybinding ? (
                    <kbd className="composer-suggestion-meta text-[11px]">{cmd.keybinding}</kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        </UIRegion>
      ) : null}

      {/* @mention menu */}
      {showMention ? (
        <UIRegion id="composer.mentionMenu" data={{ mentions: mentionList }}>
          <div className="composer-suggestion-menu ui-popover-surface mx-auto mb-1 w-full max-w-[var(--thread-max-width)] overflow-hidden rounded-lg">
            {mentionList.map((item, i) => {
              const Icon = MENTION_MENU_ICONS[item.icon];
              return (
                <button
                  key={item.label}
                  type="button"
                  data-active={i === mentionActive ? "true" : undefined}
                  onMouseEnter={() => setMentionActive(i)}
                  onClick={() => insertMention(item.label)}
                  className={cn(
                    "composer-suggestion-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px]",
                  )}
                >
                  <span className="composer-suggestion-icon" aria-hidden="true">
                    <Icon size={14} strokeWidth={2.1} />
                  </span>
                  <span className="flex-1">{item.label}</span>
                  <span className="composer-suggestion-meta text-[11px]">{item.hint}</span>
                </button>
              );
            })}
          </div>
        </UIRegion>
      ) : null}

      <div className="relative mx-auto w-full max-w-[var(--thread-max-width)]">
        <UIRegion id="composer.interactions">
          {hasPendingApproval ? <ApprovalInputCard /> : <QuestionInputCard />}
        </UIRegion>

        {agentReadiness ? (
          <UIRegion id="composer.readiness" data={agentReadiness}>
            <div
              id="composer-agent-readiness"
              role="status"
              className="border-warning/35 bg-warning/[0.08] relative z-20 mb-2 flex flex-col items-stretch gap-2.5 rounded-[12px] border px-3 py-2.5 text-left shadow-[var(--shadow-card)] sm:flex-row sm:items-start"
            >
              <CircleAlert size={16} className="text-warning mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-fg text-[13px] font-medium">{agentReadiness.title}</div>
                <div className="text-muted mt-0.5 text-[12px] leading-5">
                  {agentReadiness.description}
                </div>
              </div>
              {agentReadiness.configurable ? (
                <button
                  type="button"
                  onClick={() => useUIStore.getState().openSettings("agents")}
                  className="ui-button min-h-9 shrink-0 px-2.5 py-1.5 text-[12px] sm:min-h-0"
                >
                  <Settings size={13} />
                  {t("composer.agent.openSettings")}
                </button>
              ) : null}
            </div>
          </UIRegion>
        ) : null}

        {queuedPrompts.length ? (
          <UIRegion
            id="composer.queue"
            data={{
              count: queuedPrompts.length,
              prompts: queuedPrompts.map((prompt) => ({
                id: prompt.id,
                attachmentCount: prompt.attachments?.length ?? 0,
                text: prompt.text,
              })),
            }}
          >
            <div className="border-border-subtle bg-surface/76 supports-[backdrop-filter]:bg-surface/62 relative z-10 mx-auto w-[calc(100%-32px)] overflow-hidden rounded-t-[14px] rounded-b-none border border-b-0 px-2.5 py-1.5 backdrop-blur-xl sm:w-[calc(100%-64px)] sm:px-3">
              <div className="no-scrollbar max-h-32 overflow-y-auto">
                {queuedPrompts.map((prompt, index) => (
                  <div
                    key={prompt.id}
                    className="border-border-subtle/60 flex min-h-8 items-center gap-2 border-t px-0 py-0.5 first:border-t-0"
                  >
                    <span className="bg-surface-hover text-subtle flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[11px] tabular-nums">
                      {index + 1}
                    </span>
                    <span className="text-fg min-w-0 flex-1 truncate text-[13px] leading-5">
                      {prompt.text || t("composer.queue.attachmentOnly")}
                    </span>
                    {prompt.attachments?.length ? (
                      <span className="text-subtle flex shrink-0 items-center gap-1 text-[11px]">
                        <Paperclip size={11} />
                        {prompt.attachments.length}
                      </span>
                    ) : null}
                    <Tip label={t("composer.queue.remove")} side="top">
                      <button
                        type="button"
                        aria-label={t("composer.queue.remove")}
                        onClick={() =>
                          activeSessionId && removeQueuedPrompt(activeSessionId, prompt.id)
                        }
                        className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tip>
                    <Tip label={t("composer.queue.insert")} side="top">
                      <button
                        type="button"
                        aria-label={t("composer.queue.insert")}
                        disabled={steeringQueuedPromptId !== null}
                        onClick={() => void insertQueuedPrompt(prompt.id)}
                        className="text-muted hover:bg-surface-hover hover:text-fg flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-[7px] px-2 transition-colors disabled:opacity-40"
                      >
                        <CornerDownLeft size={14} strokeWidth={2.1} />
                        <span className="hidden text-[12px] font-medium sm:inline">
                          {t("composer.queue.insert")}
                        </span>
                      </button>
                    </Tip>
                  </div>
                ))}
              </div>
            </div>
          </UIRegion>
        ) : null}

        <UIRegion
          id="composer.card"
          data={{ attachmentCount: attachments.length, canSend, streaming }}
        >
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            className="ui-composer-surface relative z-20 w-full rounded-[18px] transition-[border-color,box-shadow] duration-200 sm:rounded-[20px]"
          >
            {editing ? (
              <div className="border-border-subtle text-muted flex items-center gap-2 border-b px-4 py-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate">{t("composer.editingMessage")}</span>
                <button
                  type="button"
                  title={t("common.cancel")}
                  aria-label={t("common.cancel")}
                  onClick={() => {
                    setEditing(null);
                    setText("");
                    setAttachments([]);
                  }}
                  className="ui-icon-button h-6 w-6 rounded-md"
                >
                  <X size={13} />
                </button>
              </div>
            ) : null}
            {/* attachment preview row */}
            {attachments.length > 0 ? (
              <UIRegion
                id="composer.attachments"
                data={{
                  attachments: attachments.map((item) => ({
                    id: item.id,
                    name: item.name,
                    kind: item.kind,
                    mime: item.mime,
                    size: item.size,
                  })),
                }}
              >
                <div className="flex flex-wrap gap-2 px-4 pt-3">
                  {attachments.map((a) => (
                    <div key={a.id} className="group relative">
                      {a.kind === "image" && a.url ? (
                        <img
                          src={a.url}
                          alt={a.name}
                          className="border-border-subtle h-16 w-16 rounded-[8px] border object-cover"
                        />
                      ) : (
                        <div className="border-border-subtle bg-surface text-muted flex h-16 max-w-[160px] items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11px]">
                          {isBrowserAnnotationsAttachment(a) ? (
                            <MessageSquare size={12} className="shrink-0" />
                          ) : (
                            <Paperclip size={12} className="shrink-0" />
                          )}
                          <span className="truncate">{a.name}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        aria-label={t("composer.removeAttachment", { name: a.name })}
                        onClick={() => removeComposerAttachment(a.id)}
                        className="ui-icon-button border-border bg-surface text-subtle hover:text-danger absolute -top-2 -right-2 h-6 w-6 rounded-full border sm:-top-1.5 sm:-right-1.5 sm:h-5 sm:w-5"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </UIRegion>
            ) : null}

            <UIRegion id="composer.textarea" data={{ text, canSend, streaming }}>
              <div className="relative">
                {!text ? (
                  <div className="text-subtle pointer-events-none absolute inset-x-4 top-3.5 z-10 text-[16px] leading-relaxed sm:text-[15px]">
                    {t("composer.placeholder")}
                  </div>
                ) : null}
                <ComposerEditor
                  ref={editorRef}
                  value={text}
                  placeholder={t("composer.placeholder")}
                  ariaDescribedBy={agentReadiness ? "composer-agent-readiness" : undefined}
                  mentions={EDITOR_MENTIONS}
                  commands={agentCommandNames}
                  onChange={(next, nextSelectionOffset) => {
                    setText(next);
                    setSelectionOffset(nextSelectionOffset);
                    if (recording && !voiceApplyingTranscriptRef.current) {
                      voiceDraftAnchorRef.current = {
                        baseText: next,
                        insertionOffset: boundedTextOffset(next, nextSelectionOffset),
                      };
                      voiceFinalTranscriptRef.current = "";
                      voiceInterimTranscriptRef.current = "";
                      voiceRecognitionSegmentsRef.current.clear();
                    }
                  }}
                  onFiles={addFiles}
                  onSuggestionKeyDown={onSuggestionKeyDown}
                  onSubmit={submit}
                />
              </div>
            </UIRegion>
            {recording ? (
              <UIRegion
                id="composer.voiceRecorder"
                data={{ durationMs: recordingDurationMs, state: recordingState }}
              >
                <div
                  role="status"
                  aria-live="polite"
                  className="composer-voice-recorder mx-3 mt-1 flex min-w-0 items-center gap-2 rounded-[10px] px-2.5 py-2 sm:mx-3.5 sm:rounded-[8px]"
                >
                  <span className="composer-voice-dot shrink-0" aria-hidden="true" />
                  <span className="composer-voice-label text-muted shrink-0 text-[12px] leading-none font-medium">
                    {recordingState === "starting"
                      ? t("composer.voiceStarting")
                      : t("composer.voiceListening", {
                          duration: formatRecordingDuration(recordingDurationMs),
                        })}
                  </span>
                  <VoiceWaveform levels={voiceLevels} />
                </div>
              </UIRegion>
            ) : null}
            <UIRegion id="composer.toolbar" data={{ canSend, streaming }}>
              <div className="flex min-w-0 items-center justify-between gap-1 px-2 pt-1 pb-2 sm:px-2.5 sm:pb-2.5">
                <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                  <UIRegion id="composer.attachButton">
                    <button
                      type="button"
                      title={t("composer.attachFiles")}
                      aria-label={t("composer.attachFiles")}
                      onClick={() => fileRef.current?.click()}
                      className={cn(
                        COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS,
                        "ui-icon-button h-10 w-10 rounded-[10px] sm:h-8 sm:w-8 sm:rounded-[8px]",
                      )}
                    >
                      <Paperclip size={17} />
                    </button>
                  </UIRegion>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files) addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <UIRegion id="composer.leftControls">
                    {left.map((c) => (
                      <div key={c.id} className="flex items-center">
                        {c.render()}
                      </div>
                    ))}
                  </UIRegion>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <UIRegion id="composer.rightControls">
                    {right.map((c) => (
                      <div key={c.id} className="flex items-center">
                        {c.render()}
                      </div>
                    ))}
                  </UIRegion>
                  {hasActiveSession ? (
                    <UIRegion id="composer.contextIndicator" data={contextUsage}>
                      <ContextIndicator usage={contextUsage} />
                    </UIRegion>
                  ) : null}
                  <UIRegion id="composer.voiceButton" data={{ recording }}>
                    <button
                      type="button"
                      title={recording ? t("composer.voiceStop") : t("composer.voiceInput")}
                      aria-label={recording ? t("composer.voiceStop") : t("composer.voiceInput")}
                      aria-pressed={recording}
                      onClick={toggleVoiceInput}
                      className={cn(
                        COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS,
                        "flex h-10 w-10 items-center justify-center rounded-full transition-colors sm:h-8 sm:w-8",
                        recording
                          ? "composer-voice-button-active"
                          : "text-muted hover:bg-surface-hover hover:text-fg",
                      )}
                    >
                      <Mic size={16} />
                    </button>
                  </UIRegion>
                  {streaming ? (
                    <UIRegion id="composer.stopButton">
                      <button
                        type="button"
                        onClick={stop}
                        title={t("action.stop")}
                        aria-label={t("action.stop")}
                        className={cn(
                          COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS,
                          "bg-surface text-fg hover:bg-surface-hover flex h-10 w-10 items-center justify-center rounded-full transition-colors sm:h-8 sm:w-8",
                        )}
                      >
                        <Square size={14} fill="currentColor" />
                      </button>
                    </UIRegion>
                  ) : null}
                  {!streaming || canSend ? (
                    <UIRegion id="composer.sendButton" data={{ canSend }}>
                      <button
                        type="button"
                        onClick={submit}
                        disabled={!canSend}
                        title={
                          agentReadiness?.title ??
                          (streaming ? t("composer.queue.add") : t("action.send"))
                        }
                        aria-label={
                          agentReadiness?.title ??
                          (streaming ? t("composer.queue.add") : t("action.send"))
                        }
                        className={cn(
                          COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS,
                          "bg-accent text-accent-fg flex h-10 w-10 items-center justify-center rounded-full transition-opacity disabled:opacity-30 sm:h-8 sm:w-8",
                        )}
                      >
                        <ArrowUp size={18} strokeWidth={2.5} />
                      </button>
                    </UIRegion>
                  ) : null}
                </div>
              </div>
            </UIRegion>
          </div>
        </UIRegion>
      </div>
    </div>
  );
}

type ComposerTrigger = { end: number; query: string; start: number };

function composerTextWithInsertion(
  currentText: string,
  insertionText: string,
  mode: "append" | "replace" = "append",
): { text: string; selectionOffset: number } {
  const insertion = insertionText.trim();
  if (!insertion) return { text: currentText, selectionOffset: currentText.length };
  if (mode === "replace" || !currentText.trim()) {
    return { text: insertion, selectionOffset: insertion.length };
  }
  const base = currentText.trimEnd();
  const separator = base.endsWith("\n") ? "\n" : "\n\n";
  const text = `${base}${separator}${insertion}`;
  return { text, selectionOffset: text.length };
}

function browserAnnotationsAttachments(draft: BrowserAnnotationsDraft): Attachment[] {
  return [
    ...draft.annotations.map((annotation, index) =>
      browserAnnotationAttachment(draft, annotation, index),
    ),
    ...(draft.snapshots ?? []).map((snapshot, index) =>
      browserSnapshotAttachment(draft, snapshot, index),
    ),
  ];
}

function browserAnnotationAttachment(
  draft: BrowserAnnotationsDraft,
  annotation: BrowserAnnotationsDraft["annotations"][number],
  index: number,
): Attachment {
  const content = formatBrowserAnnotationContext(draft, annotation, index);
  return {
    id: browserAnnotationAttachmentId(draft.browserId, annotation, index),
    content,
    kind: "file",
    mime: "application/json",
    name: browserAnnotationLabel(annotation, index),
    size: content.length,
    source: "browser_annotations",
  };
}

function syncBrowserAnnotationsAttachments(
  attachments: Attachment[],
  nextAttachments: Attachment[],
): Attachment[] {
  const withoutBrowserAnnotations = attachments.filter(
    (attachment) => !isBrowserAnnotationsAttachment(attachment),
  );
  if (!nextAttachments.length) {
    return withoutBrowserAnnotations.length === attachments.length
      ? attachments
      : withoutBrowserAnnotations;
  }
  const existing = attachments.filter(isBrowserAnnotationsAttachment);
  if (
    existing.length === nextAttachments.length &&
    existing.every((attachment, index) => {
      const next = nextAttachments[index];
      return (
        next &&
        attachment.id === next.id &&
        attachment.name === next.name &&
        attachment.content === next.content
      );
    })
  ) {
    return attachments;
  }
  return [...nextAttachments, ...withoutBrowserAnnotations];
}

function isBrowserAnnotationsAttachment(attachment: Attachment): boolean {
  return (
    attachment.source === "browser_annotations" ||
    attachment.id.startsWith("browser-snapshot:") ||
    attachment.id.startsWith("browser-annotation:") ||
    attachment.id.startsWith("browser-annotations:")
  );
}

function removeBrowserContextAttachment(attachmentId: string): void {
  if (
    !attachmentId.startsWith("browser-snapshot:") &&
    !attachmentId.startsWith("browser-annotation:") &&
    !attachmentId.startsWith("browser-annotations:")
  ) {
    return;
  }
  const ui = useUIStore.getState();
  const draft = ui.browserAnnotationsDraft;
  if (!draft) return;
  const annotations = draft.annotations.filter(
    (annotation, index) =>
      browserAnnotationAttachmentId(draft.browserId, annotation, index) !== attachmentId,
  );
  const snapshots = (draft.snapshots ?? []).filter(
    (snapshot) => `browser-snapshot:${draft.browserId}:${snapshot.id}` !== attachmentId,
  );
  if (
    annotations.length === draft.annotations.length &&
    snapshots.length === (draft.snapshots ?? []).length
  )
    return;
  if (!annotations.length && !snapshots.length) {
    ui.clearBrowserAnnotationsDraft(draft.browserId);
    return;
  }
  ui.setBrowserAnnotationsDraft({
    ...draft,
    annotations,
    snapshots,
    updatedAt: Date.now(),
  });
}

function browserSnapshotAttachment(
  draft: BrowserAnnotationsDraft,
  snapshot: NonNullable<BrowserAnnotationsDraft["snapshots"]>[number],
  index: number,
): Attachment {
  const content = formatBrowserSnapshotContext(draft, snapshot, index);
  return {
    id: `browser-snapshot:${draft.browserId}:${snapshot.id}`,
    content,
    kind: snapshot.screenshotDataUrl ? "image" : "file",
    mime: snapshot.mimeType ?? "application/json",
    name: browserSnapshotLabel(index),
    size: content.length,
    source: "browser_annotations",
    ...(snapshot.screenshotDataUrl ? { url: snapshot.screenshotDataUrl } : {}),
  };
}

function browserAnnotationAttachmentId(
  browserId: string,
  annotation: BrowserAnnotationsDraft["annotations"][number],
  index: number,
): string {
  return `browser-annotation:${browserId}:${annotation.id || `${index + 1}-${annotation.createdAt}`}`;
}

function browserAnnotationLabel(
  annotation: BrowserAnnotationsDraft["annotations"][number],
  index: number,
): string {
  const note = annotation.note.trim();
  if (note) return `${index + 1}. ${truncateText(note, 56)}`;
  return t("composer.browserAnnotationLabel", { index: index + 1 });
}

function browserSnapshotLabel(index: number): string {
  return t("composer.browserSnapshotLabel", { index: index + 1 });
}

function browserAnnotationsLabel(count: number): string {
  return t(
    count === 1 ? "composer.browserAnnotationsCountOne" : "composer.browserAnnotationsCount",
    { count },
  );
}

function formatBrowserAnnotationContext(
  draft: BrowserAnnotationsDraft,
  annotation: BrowserAnnotationsDraft["annotations"][number],
  index: number,
): string {
  const countLabel = browserAnnotationsLabel(draft.annotations.length);
  const payload = {
    type: "browser_annotation",
    count: draft.annotations.length,
    source: {
      title: draft.title,
      url: draft.url,
      capturedAt: new Date(draft.updatedAt).toISOString(),
    },
    annotation: {
      number: index + 1,
      id: annotation.id,
      type: annotation.type,
      note: annotation.note,
      selector: annotation.selector,
      tagName: annotation.tagName,
      text: annotation.text,
      rect: annotation.rect,
      viewport: annotation.viewport,
      styles: annotation.styles,
      createdAt: new Date(annotation.createdAt).toISOString(),
    },
  };
  return [
    t("composer.browserAnnotationsPromptIntro", { countLabel }),
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n\n");
}

function formatBrowserSnapshotContext(
  draft: BrowserAnnotationsDraft,
  snapshot: NonNullable<BrowserAnnotationsDraft["snapshots"]>[number],
  index: number,
): string {
  const payload = {
    type: "browser_snapshot",
    number: index + 1,
    id: snapshot.id,
    source: {
      title: snapshot.title || draft.title,
      url: snapshot.url || draft.url,
      capturedAt: new Date(snapshot.createdAt).toISOString(),
    },
    screenshot: {
      includedInComposer: Boolean(snapshot.screenshotDataUrl),
      mimeType: snapshot.mimeType,
    },
    pageText: truncateText(snapshot.text, 20_000),
    html: snapshot.html ? truncateText(snapshot.html, 40_000) : undefined,
  };
  return [
    t("composer.browserSnapshotPromptIntro"),
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n\n");
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function composerSlashTrigger(text: string, selectionOffset: number): ComposerTrigger | null {
  const caret = Math.max(0, Math.min(text.length, selectionOffset));
  const beforeCaret = text.slice(0, caret);
  const match = /^\/([\w.-]*)$/.exec(beforeCaret);
  return match ? { end: caret, query: match[1], start: 0 } : null;
}

function composerMentionTrigger(text: string, selectionOffset: number): ComposerTrigger | null {
  const caret = Math.max(0, Math.min(text.length, selectionOffset));
  const beforeCaret = text.slice(0, caret);
  const match = /@([\w./-]*)$/.exec(beforeCaret);
  if (!match || (match.index > 0 && !/\s/.test(beforeCaret[match.index - 1]))) return null;
  return { end: caret, query: match[1], start: match.index };
}

function VoiceWaveform({ levels }: { levels: number[] }) {
  return (
    <div className="composer-voice-waveform min-w-0 flex-1" aria-hidden="true">
      <div className="composer-voice-waveform-track">
        {levels.map((level, index) => (
          <span
            key={index}
            style={
              {
                "--voice-index": index,
                "--voice-level": level,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}

function isVoiceInputSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    resolveAudioContextConstructor() &&
    (resolveSpeechRecognitionConstructor() || canSaveDesktopVoiceRecording()),
  );
}

function canSaveDesktopVoiceRecording(): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  const api = desktopApi();
  return api?.transport === "electron" && Boolean(api.voice?.saveRecording);
}

function resolveSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const voiceWindow = window as BrowserWindowWithVoiceApis;
  return voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition ?? null;
}

function resolveAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const voiceWindow = window as BrowserWindowWithVoiceApis;
  return window.AudioContext ?? voiceWindow.webkitAudioContext ?? null;
}

function preferredVoiceRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function voiceRecordingExtension(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes("mp4")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("wav")) return "wav";
  return "webm";
}

async function waitForLiveAudioTrack(stream: MediaStream): Promise<void> {
  const [track] = stream.getAudioTracks();
  if (!track) throw new DOMException("No microphone audio track was created.", "NotFoundError");
  if (track.readyState !== "live") {
    throw new DOMException("Microphone audio track is not live.", "NotReadableError");
  }
  if (!track.muted) return;
  await new Promise<void>((resolve, reject) => {
    let timeout = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      track.removeEventListener("unmute", handleUnmute);
      track.removeEventListener("ended", handleEnded);
    };
    const handleUnmute = () => {
      cleanup();
      resolve();
    };
    const handleEnded = () => {
      cleanup();
      reject(new DOMException("Microphone audio track ended.", "NotReadableError"));
    };
    track.addEventListener("unmute", handleUnmute);
    track.addEventListener("ended", handleEnded);
    timeout = window.setTimeout(() => {
      cleanup();
      reject(new DOMException("Microphone audio track stayed muted.", "NotReadableError"));
    }, 1_500);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read voice recording."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separatorIndex = result.indexOf(",");
      resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function speechRecognitionLanguage(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}

function createIdleVoiceLevels(): number[] {
  return Array.from({ length: VOICE_LEVEL_BAR_COUNT }, (_, index) => {
    const baseline = 0.16 + Math.abs(Math.sin(index * 0.72)) * 0.16;
    return Number(baseline.toFixed(3));
  });
}

function nextVoiceLevels(levels: number[], nextLevel: number): number[] {
  const normalized = Math.max(0.08, Math.min(1, nextLevel));
  const source = levels.length === VOICE_LEVEL_BAR_COUNT ? levels : IDLE_VOICE_LEVELS;
  return [...source.slice(1), normalized];
}

function voiceLevelFromTimeDomainData(buffer: Uint8Array): number {
  if (buffer.length === 0) return 0.08;
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const centered = (buffer[i] - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / buffer.length);
  return Math.max(0.08, Math.min(1, rms * 7.5));
}

function formatRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeRecognizedText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1");
}

function boundedTextOffset(text: string, offset: number): number {
  return Math.max(0, Math.min(text.length, offset));
}

function insertTranscriptAtAnchor(anchor: VoiceDraftAnchor, transcript: string) {
  const insertionOffset = boundedTextOffset(anchor.baseText, anchor.insertionOffset);
  const before = anchor.baseText.slice(0, insertionOffset);
  const after = anchor.baseText.slice(insertionOffset);
  if (!transcript) return { text: anchor.baseText, selectionOffset: insertionOffset };

  const leadingSpace =
    before && !/\s$/.test(before) && !/^[\s,.;:!?，。；：！？]/.test(transcript) ? " " : "";
  const trailingSpace =
    after && !/\s$/.test(transcript) && !/^[\s,.;:!?，。；：！？]/.test(after) ? " " : "";
  const inserted = `${leadingSpace}${transcript}${trailingSpace}`;
  return {
    text: `${before}${inserted}${after}`,
    selectionOffset: before.length + inserted.length,
  };
}

function isMicrophonePermissionError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name);
}

function isSpeechRecognitionPermissionError(error: string): boolean {
  return error === "not-allowed" || error === "service-not-allowed";
}

function ContextIndicator({ usage }: { usage?: ContextUsage }) {
  const hasWindow = Boolean(usage && usage.size > 0);
  const used = Math.max(0, usage?.used ?? 0);
  const size = Math.max(0, usage?.size ?? 0);
  const usedKnown = Boolean(usage && usage.usedKnown !== false);
  const hasUsage = hasWindow || usedKnown;
  const ratio = hasWindow && usedKnown ? Math.min(used / size, 1) : 0;
  const percent = Math.round(ratio * 100);
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const usedLabel = usedKnown ? formatCompactTokenCount(used) : t("common.unknown");
  const sizeLabel = formatCompactTokenCount(size);
  const tooltip = hasUsage ? (
    <div className="grid min-w-32 gap-1">
      <div className="font-medium">{t("composer.contextUsage")}</div>
      <div className="text-subtle flex justify-between gap-4">
        <span>{t("composer.contextUsedTotal")}</span>
        <span>
          {usedLabel} / {hasWindow ? sizeLabel : t("common.unknown")}
        </span>
      </div>
      {hasWindow && usedKnown ? (
        <div className="text-subtle flex justify-between gap-4">
          <span>{t("composer.contextUsagePercent")}</span>
          <span>{percent}%</span>
        </div>
      ) : null}
    </div>
  ) : (
    t("composer.contextUsageUnavailable")
  );

  return (
    <Tip label={tooltip} side="top" closeOnClick={false}>
      <span
        role="meter"
        aria-label={t("composer.contextUsage")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasWindow ? percent : 0}
        aria-valuetext={
          hasWindow && usedKnown
            ? t("composer.contextUsageValue", {
                percent,
                size: sizeLabel,
                used: usedLabel,
              })
            : hasWindow
              ? t("composer.contextUsageWindowValue", { size: sizeLabel })
              : hasUsage
                ? t("composer.contextUsageUsedValue", { used: usedLabel })
                : t("composer.contextUsageUnavailable")
        }
        tabIndex={0}
        className={cn(
          COMPOSER_BOTTOM_BUTTON_FOCUS_CLASS,
          "relative flex h-10 w-10 shrink-0 cursor-default items-center justify-center rounded-full sm:h-8 sm:w-8",
          hasWindow && usedKnown
            ? ratio >= 0.9
              ? "text-danger"
              : ratio >= 0.75
                ? "text-warning"
                : "text-success"
            : "text-subtle",
        )}
      >
        <svg aria-hidden="true" viewBox="0 0 32 32" className="h-4 w-4 -rotate-90">
          <circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeWidth="3.2"
          />
          <circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="3.2"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
      </span>
    </Tip>
  );
}

function formatCompactTokenCount(value: number): string {
  if (Math.abs(value) < 1_000) return Math.round(value).toLocaleString();
  const unit = Math.abs(value) >= 1_000_000 ? "M" : "K";
  const divisor = unit === "M" ? 1_000_000 : 1_000;
  const compact = value / divisor;
  const digits = Math.abs(compact) < 10 ? 1 : 0;
  return `${compact.toFixed(digits)}${unit}`;
}
