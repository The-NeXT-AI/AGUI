import { createContext, useContext } from "react";

export type DetailPanelProjectContextValue = {
  activeSessionId: string | null;
  key: string;
  root: string;
  workspaceId: string;
};

const DetailPanelProjectContext = createContext<DetailPanelProjectContextValue | null>(null);

export const DetailPanelProjectProvider = DetailPanelProjectContext.Provider;

export function useDetailPanelProjectContext(): DetailPanelProjectContextValue | null {
  return useContext(DetailPanelProjectContext);
}
