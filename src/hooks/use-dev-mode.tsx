"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface DevModeContextType {
  isDevMode: boolean;
  toggleDevMode: () => void;
}

const DevModeContext = createContext<DevModeContextType | undefined>(undefined);

function getInitialDevMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const storedValue = localStorage.getItem("devMode");
  return storedValue !== null ? JSON.parse(storedValue) : false;
}

export function DevModeProvider({ children }: { children: ReactNode }) {
  const [isDevMode, setIsDevMode] = useState(getInitialDevMode);

  // Update localStorage when state changes
  useEffect(() => {
    localStorage.setItem("devMode", JSON.stringify(isDevMode));
  }, [isDevMode]);

  const toggleDevMode = () => setIsDevMode(prev => !prev);

  return (
    <DevModeContext.Provider value={{ isDevMode, toggleDevMode }}>
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