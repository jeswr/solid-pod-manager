/**
 * Recorded Notion API shapes (api.notion.com/v1, Notion-Version 2022-06-28) —
 * trimmed to the fields the adapter reads. Source: POST /v1/search (pages and
 * databases mixed; titles live in different places per object kind).
 */
import type { FixtureRoute } from "../core/types.js";

export interface NotionRichText {
  plain_text: string;
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, { type: string; title?: NotionRichText[] }>;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  title: NotionRichText[];
  description: NotionRichText[];
}

export interface NotionSearchAnswer {
  results: (NotionPage | NotionDatabase)[];
  next_cursor: string | null;
  has_more: boolean;
}

export const SEARCH: NotionSearchAnswer = {
  results: [
    {
      object: "page",
      id: "59833787-2cf9-4fdf-8782-e53db20768a5",
      created_time: "2026-02-10T11:00:00.000Z",
      last_edited_time: "2026-06-01T09:30:00.000Z",
      url: "https://www.notion.so/Reading-notes-598337872cf94fdf8782e53db20768a5",
      properties: {
        title: { type: "title", title: [{ plain_text: "Reading notes" }] },
      },
    },
    {
      object: "page",
      id: "7c1958e1-9f96-4b9a-9b16-65e1a8c2cbb1",
      created_time: "2026-03-22T15:45:00.000Z",
      last_edited_time: "2026-05-28T18:12:00.000Z",
      url: "https://www.notion.so/Trip-planning-7c1958e19f964b9a9b1665e1a8c2cbb1",
      properties: {
        title: { type: "title", title: [{ plain_text: "Trip planning" }] },
      },
    },
    {
      object: "database",
      id: "d9824bdc-8445-4327-be8b-5b47500af6ce",
      created_time: "2025-12-01T08:00:00.000Z",
      last_edited_time: "2026-06-05T07:55:00.000Z",
      url: "https://www.notion.so/d9824bdc84454327be8b5b47500af6ce",
      title: [{ plain_text: "Habit tracker" }],
      description: [{ plain_text: "Daily habits, one row per day." }],
    },
  ],
  next_cursor: null,
  has_more: false,
};

export const NOTION_FIXTURES: readonly FixtureRoute[] = [
  { method: "POST", url: "https://api.notion.com/v1/search", json: SEARCH },
];
