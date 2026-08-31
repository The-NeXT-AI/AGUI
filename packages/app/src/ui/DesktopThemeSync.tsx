import { useEffect } from "react";
import { desktopApi, type DesktopThemeState } from "@/asp/desktop-api";
import { useUIStore } from "@/ui/ui-store";

type ThemeChangedDetail = {
  type?: unknown;
};

/** Keeps the renderer theme and Electron's native window material in lockstep. */
export function DesktopThemeSync() {
  useEffect(() => {
    const themeApi = desktopApi()?.theme;
    if (!themeApi) return undefined;

    let disposed = false;
    let selectionSync = Promise.resolve<DesktopThemeState | null>(null);

    const applyRemoteState = (state: DesktopThemeState | null) => {
      if (disposed || !state || state.theme === useUIStore.getState().theme) return;
      useUIStore.getState().setTheme(state.theme);
    };

    const publishSelection = (theme: string) => {
      selectionSync = selectionSync
        .catch(() => null)
        .then(() => themeApi.setSelection(theme))
        .then((state) => {
          applyRemoteState(state);
          return state;
        })
        .catch(() => null);
      return selectionSync;
    };

    const publishCurrentAppearance = (appearance?: "dark" | "light") => {
      const resolved =
        appearance ?? (document.documentElement.dataset.theme === "light" ? "light" : "dark");
      const theme = useUIStore.getState().theme;
      void selectionSync
        .catch(() => null)
        .then(() => themeApi.setAppearance({ appearance: resolved, theme }))
        .then(applyRemoteState)
        .catch(() => undefined);
    };

    const handleThemeChanged = (event: Event) => {
      const type = (event as CustomEvent<ThemeChangedDetail>).detail?.type;
      if (type === "dark" || type === "light") publishCurrentAppearance(type);
    };

    const unsubscribeRemote = themeApi.onState(applyRemoteState);
    const unsubscribeStore = useUIStore.subscribe((state, previous) => {
      if (state.theme !== previous.theme) void publishSelection(state.theme);
    });
    window.addEventListener("agui-theme-changed", handleThemeChanged);

    void themeApi
      .state()
      .then((state) => {
        if (state) {
          applyRemoteState(state);
          return;
        }
        return publishSelection(useUIStore.getState().theme).then(() => {
          publishCurrentAppearance();
        });
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribeRemote();
      unsubscribeStore();
      window.removeEventListener("agui-theme-changed", handleThemeChanged);
    };
  }, []);

  return null;
}
