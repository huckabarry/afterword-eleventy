# Afterword Eleventy

Eleventy project derived from the existing Afterword site structure, but with a simpler data layer:

- Ghost is the primary source for posts.
- Album Whale is synced into local Markdown posts and cover assets.
- BookWyrm is synced into local Markdown posts and cover assets.
- Photo/archive rendering, feeds, and tags follow the existing site templates.

## Data sources

Ghost tags pulled into the site:

- `afterword`
- `status`
- `gallery`
- `photos`

Synced locally:

- `https://albumwhale.com/bryan/listening-now.atom`
- `https://bookwyrm.social/user/bryan/rss`

Ghost is not used for books or listening entries.

## Environment

Create a `.env` file with:

```bash
GHOST_ADMIN_URL=https://lowvelocity.org
GHOST_ADMIN_KEY=your_admin_api_key
SITE_URL=https://afterword.blog
SITE_TITLE="Afterword"
SITE_LOGO=/assets/site/avatar.jpg
MICROBLOG_URL=https://micro.blog/bryan
```

## Sync local media posts

Before building, sync the local Markdown sources:

```bash
npm run sync:bookwyrm
npm run sync:albumwhale
```

## Run

```bash
npm install
npm run dev
```
