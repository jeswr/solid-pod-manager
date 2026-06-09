"use client";

import { AppWindow } from "lucide-react";
import { EmptyState } from "@/components/states";

export default function ConnectedAppsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Connected apps
        </h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          The apps that can read or write your data — and exactly which
          categories each one can touch. One-click revoke, any time.
        </p>
      </header>

      <EmptyState
        icon={AppWindow}
        title="Coming next"
        description="The permission manager arrives in the next release: a per-app list, per-category controls, and instant revoke. Your own data is never gated behind any grant."
      />
    </div>
  );
}
