"use client";

import { Activity } from "lucide-react";
import { EmptyState } from "@/components/states";

export default function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Activity</h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          A plain-language record of which app read or wrote which data, and
          when.
        </p>
      </header>

      <EmptyState
        icon={Activity}
        title="Coming soon"
        description="Your access log will appear here — readable, filterable by app and category, with no jargon."
      />
    </div>
  );
}
