This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Integrations (Connect sources)

The `/connect` catalog ships 30 apps (see `docs/integrations-catalog.md`); the 8 Tier-A
adapters (Spotify, GitHub, Strava, Reddit, Discord, Twitch, Notion, Dropbox) run in
**demo mode** (fixture data, honestly labelled) until configured. To take one live, set
its env var at build time:

| App | Live when set | Also needs |
|---|---|---|
| Spotify | `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | — (secretless PKCE) |
| GitHub | `NEXT_PUBLIC_GITHUB_CLIENT_ID` | `NEXT_PUBLIC_GITHUB_TOKEN_PROXY` |
| Strava | `NEXT_PUBLIC_STRAVA_CLIENT_ID` | `NEXT_PUBLIC_STRAVA_TOKEN_PROXY` |
| Reddit | `NEXT_PUBLIC_REDDIT_CLIENT_ID` | — (installed-app flow) |
| Discord | `NEXT_PUBLIC_DISCORD_CLIENT_ID` | — (secretless PKCE) |
| Twitch | `NEXT_PUBLIC_TWITCH_CLIENT_ID` | `NEXT_PUBLIC_TWITCH_TOKEN_PROXY` |
| Notion | `NEXT_PUBLIC_NOTION_CLIENT_ID` | `NEXT_PUBLIC_NOTION_TOKEN_PROXY` |
| Dropbox | `NEXT_PUBLIC_DROPBOX_CLIENT_ID` | — (secretless PKCE) |

`*_TOKEN_PROXY` = a tiny serverless endpoint that forwards the PKCE code→token exchange
adding the client secret, for the platforms that refuse secretless public clients. Each
platform's full registration checklist is in its adapter's `metadata.requirements`
(rendered on the app's connect page). Register `<origin>/oauth-callback.html` as the
redirect URI everywhere. OAuth tokens live in memory only — never persisted.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
