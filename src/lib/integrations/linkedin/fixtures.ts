/**
 * Recorded LinkedIn API shapes (api.linkedin.com/v2) — trimmed to the fields
 * the adapter reads.
 *
 * The member-data positions endpoint returns the member's work history. Each
 * element carries a `title`, a `companyName`, and a `timePeriod` with a
 * `startDate`/`endDate` (year + month; an absent endDate means "present").
 * Modelled here as a flat, faithful subset of the program's response.
 */
import type { FixtureRoute } from "../core/types.js";

export interface LiYearMonth {
  year: number;
  month?: number;
}

export interface LiPosition {
  id: string;
  title: string;
  companyName: string;
  location?: string;
  description?: string;
  timePeriod: { startDate: LiYearMonth; endDate?: LiYearMonth };
}

export interface LiPositionsAnswer {
  elements: LiPosition[];
}

export const POSITIONS: LiPositionsAnswer = {
  elements: [
    {
      id: "1234567890",
      title: "Senior Software Engineer",
      companyName: "Acme Corp",
      location: "London, United Kingdom",
      description: "Led the platform team building the data-portability product.",
      timePeriod: { startDate: { year: 2022, month: 3 } },
    },
    {
      id: "1234567891",
      title: "Software Engineer",
      companyName: "Globex",
      location: "Manchester, United Kingdom",
      timePeriod: { startDate: { year: 2019, month: 6 }, endDate: { year: 2022, month: 2 } },
    },
  ],
};

export const LINKEDIN_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.linkedin.com/v2/positions", json: POSITIONS },
];
