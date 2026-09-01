import { useEffect, useState, type ComponentProps } from "react";
import {
  Blocks,
  Bot,
  CalendarClock,
  CircleDot,
  Code2,
  Database,
  FileCode2,
  FileText,
  Folder,
  GitPullRequest,
  Github,
  Globe,
  Image,
  Layers,
  PanelLeft,
  PanelRight,
  Puzzle,
  RefreshCw,
  Rss,
  Search,
  Settings,
  Sparkles,
  Terminal,
  TestTube2,
  Wrench,
  Zap,
} from "lucide-react";
import type { ExtensionIconContribution } from "@the-next-ai/extensions";
import type { IconType } from "@the-next-ai/app";
import { productConfig } from "@/product/product-config";
import { readExtensionAsset } from "./extension-store";

type ExtensionIconInput = string | ExtensionIconContribution | undefined;
type IconProps = ComponentProps<IconType>;

const ICONS: Record<string, IconType> = {
  blocks: Blocks,
  bot: Bot,
  calendar: CalendarClock,
  calendarclock: CalendarClock,
  circledot: CircleDot,
  code: Code2,
  code2: Code2,
  database: Database,
  file: FileText,
  filecode: FileCode2,
  filecode2: FileCode2,
  filetext: FileText,
  folder: Folder,
  github: Github,
  gitpullrequest: GitPullRequest,
  globe: Globe,
  issue: CircleDot,
  image: Image,
  layers: Layers,
  panel: PanelRight,
  panelleft: PanelLeft,
  panelright: PanelRight,
  plugin: Puzzle,
  puzzle: Puzzle,
  refresh: RefreshCw,
  refreshcw: RefreshCw,
  rss: Rss,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  terminal: Terminal,
  testtube: TestTube2,
  testtube2: TestTube2,
  tool: Wrench,
  wrench: Wrench,
  zap: Zap,
};

export function resolveExtensionIcon(extensionId: string, icon: ExtensionIconInput): IconType {
  return (
    resolveOptionalExtensionIcon(extensionId, icon) ??
    iconByName(productConfig.extensions.defaultPanelIcon) ??
    Blocks
  );
}

export function resolveOptionalExtensionIcon(
  extensionId: string,
  icon: ExtensionIconInput,
): IconType | undefined {
  const name = iconName(icon);
  if (name) {
    const component = iconByName(name);
    if (component) return component;
  }
  const path = iconAssetPath(icon);
  return path ? extensionAssetIcon(extensionId, path) : undefined;
}

function extensionAssetIcon(extensionId: string, path: string): IconType {
  function ExtensionAssetIcon({ size = 16, className }: IconProps) {
    const [dataUrl, setDataUrl] = useState<string | null>(null);

    useEffect(() => {
      let canceled = false;
      void readExtensionAsset(extensionId, path)
        .then(assetDataUrl)
        .then((nextDataUrl) => {
          if (!canceled) setDataUrl(nextDataUrl);
        })
        .catch(() => {
          if (!canceled) setDataUrl(null);
        });
      return () => {
        canceled = true;
      };
    }, []);

    if (!dataUrl) return <Blocks size={size} className={className} />;
    const renderedSize = typeof size === "number" ? `${size}px` : size;
    return (
      <img
        src={dataUrl}
        alt=""
        draggable={false}
        className={className}
        style={{ height: renderedSize, width: renderedSize }}
      />
    );
  }
  ExtensionAssetIcon.displayName = `ExtensionAssetIcon(${extensionId})`;
  return ExtensionAssetIcon;
}

function iconName(icon: ExtensionIconInput): string {
  if (typeof icon !== "string") return "";
  if (isAssetPath(icon)) return "";
  return icon;
}

function iconAssetPath(icon: ExtensionIconInput): string {
  if (typeof icon === "string") return isAssetPath(icon) ? icon : "";
  return icon?.path || icon?.dark || icon?.light || "";
}

function iconByName(name: string): IconType | undefined {
  return ICONS[normalizeIconName(name)];
}

function normalizeIconName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isAssetPath(value: string): boolean {
  const text = value.trim();
  return (
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("/") ||
    /\.(svg|png|jpg|jpeg|gif|webp|ico)$/i.test(text)
  );
}

function assetDataUrl(asset: {
  mimeType: string;
  encoding: "utf8" | "base64";
  data: string;
}): string | null {
  if (!asset.mimeType.startsWith("image/")) return null;
  if (asset.encoding === "base64") return `data:${asset.mimeType};base64,${asset.data}`;
  return `data:${asset.mimeType};charset=utf-8,${encodeURIComponent(asset.data)}`;
}
