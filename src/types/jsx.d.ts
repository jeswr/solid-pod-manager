import type React from "react";

// The <authorization-code-flow> custom element from
// @solid/reactive-authentication is not added to HTMLElementTagNameMap by the
// library, so declare it for JSX here (React 19 form — the JSX namespace lives
// in the `react` module now, not on the global). AGENTS.md §Mounting in Next.js.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "authorization-code-flow": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
