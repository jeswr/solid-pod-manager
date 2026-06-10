/**
 * Recorded GitHub REST v3 shapes (api.github.com) — trimmed to the fields the
 * adapter reads. Sources: GET /user, GET /user/repos?sort=pushed.
 */
import type { FixtureRoute } from "../core/types.js";

export interface GitHubUser {
  login: string;
  name: string | null;
  bio: string | null;
  html_url: string;
  created_at: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  html_url: string;
  private: boolean;
  pushed_at: string;
}

export const USER: GitHubUser = {
  login: "alice-dev",
  name: "Alice Verify",
  bio: "Building things on the open web.",
  html_url: "https://github.com/alice-dev",
  created_at: "2014-03-18T09:12:00Z",
};

export const REPOS: GitHubRepo[] = [
  {
    id: 901234,
    name: "solid-pod-manager",
    full_name: "alice-dev/solid-pod-manager",
    description: "A consumer dashboard for your Solid pod.",
    language: "TypeScript",
    html_url: "https://github.com/alice-dev/solid-pod-manager",
    private: false,
    pushed_at: "2026-06-01T17:40:00Z",
  },
  {
    id: 845671,
    name: "recipe-graph",
    full_name: "alice-dev/recipe-graph",
    description: "Recipes as linked data.",
    language: "Python",
    html_url: "https://github.com/alice-dev/recipe-graph",
    private: false,
    pushed_at: "2026-04-12T08:05:00Z",
  },
  {
    id: 712309,
    name: "dotfiles",
    full_name: "alice-dev/dotfiles",
    description: null,
    language: "Shell",
    html_url: "https://github.com/alice-dev/dotfiles",
    private: true,
    pushed_at: "2025-11-30T22:13:00Z",
  },
];

export const GITHUB_FIXTURES: readonly FixtureRoute[] = [
  { url: "https://api.github.com/user/repos", json: REPOS },
  { url: "https://api.github.com/user", json: USER },
];
