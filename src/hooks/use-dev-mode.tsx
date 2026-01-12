"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface DevModeContextType {
  isDevMode: boolean;
  toggleDevMode: () => void;
  isLoaded: boolean;
}

const DevModeContext = createContext<DevModeContextType | undefined>(undefined);

export function DevModeProvider({ children }: { children: ReactNode }) {
  const [isDevMode, setIsDevMode] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const storedValue = localStorage.getItem("devMode");
    if (storedValue !== null) {
      setIsDevMode(JSON.parse(storedValue));
    }
    setIsLoaded(true);
  }, []);

  // Save to localStorage when changed
  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem("devMode", JSON.stringify(isDevMode));
    }
  }, [isDevMode, isLoaded]);

  const toggleDevMode = () => setIsDevMode(prev => !prev);

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