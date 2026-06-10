"use client";

import { useRecentActivity } from "@/components/use-activity";
import { ActivityFeed, ActivityEmpty } from "@/components/activity-feed";
import { ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";

export default function ActivityPage() {
  const { data, loading, error } = useRecentActivity(50);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Activity</h1>
        <p className="measure mt-1 text-muted-foreground text-pretty">
          The most recent changes across your pod, newest first — whichever app
          made them. (Your pod doesn&apos;t keep a log of who <em>read</em> your
          data, so we don&apos;t invent one.)
        </p>
      </header>

      {error ? (
        <ErrorState error={error} />
      ) : loading ? (
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </ul>
      ) : !data || data.length === 0 ? (
        <ActivityEmpty />
      ) : (
        <ActivityFeed entries={data} />
      )}
    </div>
  );
}
