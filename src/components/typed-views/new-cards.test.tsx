// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate; see docs/MODEL-PROVENANCE.md
//
// jsdom render tests for the four NEW typed cards (Profile / Note / Task / Issue).
// Each renders its pure model and surfaces the model's key fields as friendly UI
// — never a raw RDF predicate / `#it` subject IRI. The models are plain objects
// (the pure layer already extracted them), so these renders are deterministic and
// need no pod, no auth, no network. The empty-state path is asserted too.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProfileCardList } from "./profile-card";
import { NoteCardList } from "./note-card";
import { TaskCardList } from "./task-card";
import { IssueCardList } from "./issue-card";

const URL = "https://alice.example/data/x.ttl";

describe("ProfileCardList", () => {
  it("renders name, nickname, bio and a homepage action", () => {
    render(
      <ProfileCardList
        url={URL}
        model={{
          items: [
            {
              id: "https://alice.example/profile/card#me",
              name: "Ada Lovelace",
              nickname: "ada",
              bio: "First programmer.",
              homepage: "https://ada.example/",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(screen.getByText("First programmer.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /visit homepage/i });
    expect(link).toHaveAttribute("href", "https://ada.example/");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("shows the empty state when there are no profiles", () => {
    render(<ProfileCardList url={URL} model={{ items: [] }} />);
    expect(screen.getByText(/no profile found/i)).toBeInTheDocument();
  });
});

describe("NoteCardList", () => {
  it("renders the title and a body preview, no raw predicate text", () => {
    render(
      <NoteCardList
        url={URL}
        model={{
          items: [
            { id: `${URL}#it`, title: "Shopping list", text: "Milk\nEggs", modified: "2026-06-11T10:00:00Z" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Shopping list")).toBeInTheDocument();
    expect(screen.getByText(/Milk/)).toBeInTheDocument();
    // The subject IRI must never appear as visible text.
    expect(screen.queryByText(`${URL}#it`)).not.toBeInTheDocument();
    expect(screen.queryByText(/schema:text/)).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no notes", () => {
    render(<NoteCardList url={URL} model={{ items: [] }} />);
    expect(screen.getByText(/no notes found/i)).toBeInTheDocument();
  });
});

describe("TaskCardList", () => {
  it("renders the title, due badge and priority badge", () => {
    render(
      <TaskCardList
        url={URL}
        model={{
          items: [
            {
              id: `${URL}#it`,
              title: "Write report",
              description: "Draft it",
              due: "2999-06-20T17:00:00Z",
              completed: false,
              priority: "high",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Write report")).toBeInTheDocument();
    expect(screen.getByText(/Due/)).toBeInTheDocument();
    expect(screen.getByText(/High priority/)).toBeInTheDocument();
  });

  it("flags an overdue incomplete task", () => {
    render(
      <TaskCardList
        url={URL}
        model={{
          items: [
            { id: `${URL}#it`, title: "Late", due: "2000-01-01T00:00:00Z", completed: false, priority: "none" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });

  it("shows a completed task as done (accessible label)", () => {
    render(
      <TaskCardList
        url={URL}
        model={{ items: [{ id: `${URL}#it`, title: "Done", completed: true, priority: "none" }] }}
      />,
    );
    expect(screen.getByLabelText(/completed/i)).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks", () => {
    render(<TaskCardList url={URL} model={{ items: [] }} />);
    expect(screen.getByText(/no tasks found/i)).toBeInTheDocument();
  });
});

describe("IssueCardList", () => {
  it("renders title, a state badge and a friendly assignee handle (not the raw WebID)", () => {
    render(
      <IssueCardList
        url={URL}
        model={{
          items: [
            {
              id: `${URL}#it`,
              title: "Login is broken",
              description: "500 on submit",
              state: "in-progress",
              created: "2026-06-11T09:00:00Z",
              assignee: "https://alice.example/profile/card#me",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Login is broken")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    // The friendly handle (host) is shown; the raw WebID IRI is never visible text.
    expect(screen.getByText("alice.example")).toBeInTheDocument();
    expect(screen.queryByText("https://alice.example/profile/card#me")).not.toBeInTheDocument();
  });

  it("renders open and closed state labels", () => {
    render(
      <IssueCardList
        url={URL}
        model={{
          items: [
            { id: `${URL}#a`, title: "Open one", state: "open" },
            { id: `${URL}#b`, title: "Closed one", state: "closed" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("shows the empty state when there are no issues", () => {
    render(<IssueCardList url={URL} model={{ items: [] }} />);
    expect(screen.getByText(/no issues found/i)).toBeInTheDocument();
  });
});
