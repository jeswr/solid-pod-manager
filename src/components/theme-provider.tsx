"use client";

import type * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App-wide theme provider. Combined mode: the OS `prefers-color-scheme`
 * sets the default; the header toggle writes a manual override. Pod Manager
 * is an extended-use, returning-user tool, so user control is warranted
 * (color-mode-and-theme skill).
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
