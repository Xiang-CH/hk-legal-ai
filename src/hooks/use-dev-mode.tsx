"use client";
import { createContext, useContext, useSyncExternalStore, useCallback, ReactNode } from "react";

interface DevModeContextType {
  isDevMode: boolean;
  toggleDevMode: () => void;
  isLoaded: boolean;
}

const DevModeContext = createContext<DevModeContextType | undefined>(undefined);

const STORAGE_KEY = "devMode";
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(l => l());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function getSnapshot(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored !== null ? (JSON.parse(stored) as boolean) : false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function DevModeProvider({ children }: { children: ReactNode }) {
  const isDevMode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // getServerSnapshot returns false (hide on SSR), getSnapshot returns true (show on client)
  const isLoaded = useSyncExternalStore(subscribe, () => true, () => false);

  const toggleDevMode = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(!isDevMode));
    notifyListeners();
  }, [isDevMode]);

  return (
    <DevModeContext.Provider value={{ isDevMode, toggleDevMode, isLoaded }}>
      {children}
    </DevModeContext.Provider>
  );
}

export function useDevMode() {
  const context = useContext(DevModeContext);
  if (context === undefined) {
    throw new Error("useDevMode must be used within a DevModeProvider");
  }
  return context;
}
