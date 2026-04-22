"use client";

import { useEffect } from "react";
import { useUIStore } from "~/stores/ui-store";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const isDarkMode = useUIStore((s) => s.isDarkMode);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
  }, [isDarkMode]);

  return <>{children}</>;
}
