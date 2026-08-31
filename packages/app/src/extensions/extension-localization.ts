import type {
  AppExtensionManifest,
  ExtensionConfigurationProperty,
  ExtensionLocalizedContribution,
} from "@/asp/desktop-api";
import type { Lang } from "@/lib/i18n";

export function localizedManifestDisplayName(manifest: AppExtensionManifest, lang: Lang): string {
  return localizedBundle(manifest, lang)?.displayName || manifest.displayName || manifest.name;
}

export function localizedManifestDescription(manifest: AppExtensionManifest, lang: Lang): string {
  return localizedBundle(manifest, lang)?.description || manifest.description || "";
}

export function localizedContributionText(
  manifest: AppExtensionManifest,
  lang: Lang,
  contributionId: string,
  field: keyof ExtensionLocalizedContribution,
  fallback: string | undefined,
): string {
  const localized = localizedContribution(manifest, lang, contributionId);
  const value = localized?.[field];
  return typeof value === "string" && value.trim() ? value : fallback || "";
}

export function localizedConfigurationTitle(manifest: AppExtensionManifest, lang: Lang): string {
  return (
    localizedBundle(manifest, lang)?.configuration?.title ||
    manifest.contributes?.configuration?.title ||
    ""
  );
}

export function localizedConfigurationProperty(
  manifest: AppExtensionManifest,
  lang: Lang,
  key: string,
  property: ExtensionConfigurationProperty,
): {
  description: string;
  enumLabel: (value: unknown) => string;
  title: string;
} {
  const localized =
    localizedBundle(manifest, lang)?.configuration?.properties?.[key] ??
    localizedContribution(manifest, lang, key);
  const enumLabels = localized?.enumLabels ?? property.enumLabels ?? {};
  return {
    title: localized?.title || property.title || readableConfigurationKey(key),
    description: localized?.description || property.description || "",
    enumLabel: (value) => enumLabels[String(value)] || String(value),
  };
}

function localizedContribution(
  manifest: AppExtensionManifest,
  lang: Lang,
  contributionId: string,
): ExtensionLocalizedContribution | undefined {
  return localizedBundle(manifest, lang)?.contributions?.[contributionId];
}

function localizedBundle(manifest: AppExtensionManifest, lang: Lang) {
  const bundles = manifest.localizations ?? {};
  const preferred = lang === "zh" ? ["zh", "zh-CN", "zh-Hans"] : ["en", "en-US"];
  for (const key of preferred) {
    if (bundles[key]) return bundles[key];
  }
  const prefix = `${lang}-`;
  const matchedKey = Object.keys(bundles).find((key) => key.toLowerCase().startsWith(prefix));
  return matchedKey ? bundles[matchedKey] : undefined;
}

function readableConfigurationKey(key: string): string {
  const lastSegment = key.split(".").filter(Boolean).pop() || key;
  return lastSegment
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
