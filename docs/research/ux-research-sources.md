# Pod Manager — UX research sources

Cited sources behind `docs/DESIGN.md` (deep-research pass, 2026-06-09; 22 sources fetched, 25 claims
3-vote adversarially verified, 8 high-confidence findings synthesised).

## Primary / authoritative
- **Theys et al., *Interacting with Computers* 2025** — Solid Pods raise perceived transparency/control but NOT trust/usability/intention-to-use. https://academic.oup.com/iwc/advance-article-abstract/doi/10.1093/iwc/iwaf017/8110646  *(the decisive product-strategy finding — R1)*
- **Apple WWDC 2019 #708** — "privacy assurances" (one plain sentence), just-in-time prompts, "Allow Once". https://developer.apple.com/videos/play/wwdc2019/708/
- **Android runtime permissions** — dangerous perms granted at runtime, graduated dialog, revoke anytime. https://source.android.com/docs/core/permissions/runtime_perms
- **Gray et al., CHI 2021 (dark patterns)** — asymmetric Accept/Reject = false hierarchy; consent-wall problems; GDPR valid-consent properties. https://dl.acm.org/doi/10.1145/3411764.3445779
- **Tan et al., CHI 2014** — a rationale raises grant rates (12% overall, up to 81%). https://people.eecs.berkeley.edu/~daw/papers/perm-chi14.pdf
- **NN/g — permission requests** — reason-first, jargon-free, benefit-framed. https://www.nngroup.com/articles/permission-requests/
- **1Password IA** — fixed two-tier item taxonomy + cross-cutting sidebar + Watchtower. https://support.1password.com/item-categories/ · https://support.1password.com/sidebar/
- **UK Gov Analysis Function — dashboards** — inverted pyramid, minimise scroll/clicks, WCAG. https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-testing-dashboards-for-design-and-accessibility/
- **WCAG 2.2 contrast** — 4.5:1 / 3:1. https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- **Tableau accessibility** — aggregate dense views, provide accessible underlying tables. https://help.tableau.com/current/pro/desktop/en-us/accessibility_best_practice.htm
- **Penny** (dev tool, presumes Solid familiarity) https://penny.vincenttunru.com/ · **PodOS** (dev web-component lib; content-type→viewer pattern; **no** share component) https://pod-os.org/

## Refuted (do NOT rely on)
- PodOS does **not** ship a sharing/permission component — build the consent manager fresh (0-3).
- GDPR Art. 7(4) "revocation as easy as granting" did **not** survive at this source (1-2) — treat
  one-click revoke as a strong UX norm / OS-level expectation, not a settled legal mandate.

## Carried open questions
Optimal common-tier categories (validate with users); which interventions actually move trust;
access-log IA for non-technical users; onboarding/empty-state design. See `DESIGN.md §11/§13`.
