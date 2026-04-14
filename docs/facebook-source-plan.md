# Plan: Add Facebook as AI Agent Source

## Context

Add Facebook public posts and hiking group posts as a new research source
in the AI agent. When a user requests an AI Guide for a hut or ferrata,
the agent will search Facebook for relevant posts and include them in the
context sent to Gemini.

---

## Step 1 — Get credentials (manual setup)

1. Go to **developers.facebook.com** → "My Apps" → "Create App"
2. Choose type: **Consumer** (personal use, no business verification needed)
3. Add product: **Facebook Login**
4. Note your `App ID` and `App Secret` from "App Settings → Basic"
5. Open the **Graph API Explorer** at `developers.facebook.com/tools/explorer`
6. Generate a **User Access Token** with permissions:
   - `user_posts`
   - `groups_access_member_info`
7. Extend it to a **long-lived token** (60-day expiry) — call this endpoint once:
   ```
   GET https://graph.facebook.com/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={APP_ID}
     &client_secret={APP_SECRET}
     &fb_exchange_token={SHORT_TOKEN}
   ```
8. Add to your `.env`:
   ```
   FACEBOOK_ACCESS_TOKEN=EAAxxxx...
   ```

> **Tip — improve results before testing**: Join 3–5 Italian hiking groups on Facebook.
> The API only returns posts your account can see, so group membership directly
> improves the quality of results for Bergamo/Lombardy huts:
> - "Escursionisti Bergamo e dintorni"
> - "Rifugi alpini italiani"
> - "Alpinismo e trekking - Alpi Orobie"

---

## Step 2 — Implementation

### New file: `agent/sources/facebook.ts`

**Search strategy (two calls in parallel):**

1. `GET /search?q={name}&type=post&fields=message,created_time,from,permalink_url`
   → Returns public posts + posts from groups you are a member of
2. `GET /search?q={name}&type=page&fields=id,name` → Find the official page,
   then `GET /{page_id}/posts?fields=message,created_time` for recent posts

**Formatting:**
```
• "{message snippet (300 chars)}" — {author} ({YYYY-MM})
  {permalink_url}
```

Limit: 5 posts total, skip posts with empty `message`, skipped automatically
if `FACEBOOK_ACCESS_TOKEN` is not set in `.env`.

### `agent/orchestrator.ts`

Add `fetchFacebookPosts` to the `Promise.allSettled` array alongside the other sources.

### `agent/types.ts`

Add `FacebookPost` and `FacebookSearchResponse` interfaces (no `any`).

### `.env.example`

Add:
```
FACEBOOK_ACCESS_TOKEN=   # optional — Facebook Graph API long-lived user token
```

---

## Files to modify

| File | Change |
|---|---|
| `agent/sources/facebook.ts` | **New file** — Graph API search + formatting |
| `agent/orchestrator.ts` | Add `fetchFacebookPosts` to sources |
| `agent/types.ts` | Add Facebook API response interfaces |
| `.env.example` | Document new env var |

---

## Realistic expectations

| Content | Available? |
|---|---|
| Posts from hiking groups you are a member of | ✓ |
| Posts from public pages (official rifugio pages) | ✓ |
| General public posts your account can see | ✓ |
| Posts from private/closed groups | ✗ |
| All public posts globally | ✗ (API removed in v3.3, 2019) |

---

## Verification

1. Add `FACEBOOK_ACCESS_TOKEN` to `.env` and restart the server (`npm run dev`)
2. Click "Genera AI Guide" on a Bergamo hut
3. Open `agent-sources-dump.txt` and check for:
   ```
   --- FACEBOOK | success: true ---
   URL: https://graph.facebook.com/search?...
   ```
4. Confirm posts are relevant and not from unrelated pages
