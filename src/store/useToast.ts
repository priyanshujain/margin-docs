import { create } from "zustand";

interface ToastState {
  message: string | null;
  notice: (message: string) => void;
  dismiss: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  notice: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}));

export const notify = (message: string) => useToast.getState().notice(message);
