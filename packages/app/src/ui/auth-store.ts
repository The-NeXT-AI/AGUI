import { create } from "zustand";

export interface AuthUser {
  name: string;
  email: string;
  plan: string;
}

interface AuthStore {
  user: AuthUser | null;
  signIn: (email: string) => void;
  signOut: () => void;
}

/**
 * Mock auth state. `signIn` fakes a session from an email; wire to a real
 * OAuth/session provider (the real app's `login` / `profile` flow) when ready.
 */
export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  signIn: (email) =>
    set({
      user: {
        name: email.split("@")[0] || "User",
        email: email || "demo@codex.dev",
        plan: "Pro",
      },
    }),
  signOut: () => set({ user: null }),
}));
