/**
 * Recorded Pinterest API v5 shapes (api.pinterest.com/v5) — trimmed to the
 * fields the adapter reads.
 *
 * GET /v5/pins returns the user's pins: each has an `id`, a `title`, a
 * `description`, a `board_id`/`board_owner`, a `created_at`, a `link`, and a
 * `media` block whose `images` carry the hosted asset URLs. GET /v5/boards
 * returns the user's boards (`id`, `name`, `description`, `pin_count`).
 */
import type { FixtureRoute } from "../core/types.js";

export interface PinImageVariant {
  width: number;
  height: number;
  url: string;
}

export interface Pin {
  id: string;
  title: string;
  description?: string;
  board_id: string;
  created_at: string;
  link?: string;
  media?: { media_type: string; images?: Record<string, PinImageVariant> };
}

export interface PinsAnswer {
  items: Pin[];
  bookmark?: string;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  pin_count?: number;
}

export interface BoardsAnswer {
  items: Board[];
  bookmark?: string;
}

export const PINS: PinsAnswer = {
  items: [
    {
      id: "813034246246243478",
      title: "Mid-century desk setup",
      description: "Walnut, brass, and a single plant. Perfection.",
      board_id: "813034312345678901",
      created_at: "2026-05-10T11:20:00Z",
      link: "https://www.pinterest.com/pin/813034246246243478/",
      media: {
        media_type: "image",
        images: {
          "600x": { width: 600, height: 800, url: "https://i.pinimg.com/600x/ab/cd/ef.jpg" },
        },
      },
    },
    {
      id: "813034246246243479",
      title: "Sourdough crumb",
      description: "Open crumb after 24h cold proof.",
      board_id: "813034398765432109",
      created_at: "2026-05-12T08:05:00Z",
      link: "https://www.pinterest.com/pin/813034246246243479/",
      media: {
        media_type: "image",
        images: {
          "600x": { width: 600, height: 600, url: "https://i.pinimg.com/600x/12/34/56.jpg" },
        },
      },
    },
  ],
};

export const BOARDS: BoardsAnswer = {
  items: [
    { id: "813034312345678901", name: "Home office", description: "Desk goals.", pin_count: 87 },
    { id: "813034398765432109", name: "Baking", description: "Bread and pastry.", pin_count: 152 },
  ],
};

export const PINTEREST_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.pinterest.com/v5/pins", json: PINS },
  { url: "https://api.pinterest.com/v5/boards", json: BOARDS },
];
