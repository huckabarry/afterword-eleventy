# Afterword Eleventy

Eleventy project derived from the existing Afterword site structure, but with a simpler data layer:

- Ghost is the primary source for posts.
- Album Whale powers the listening pages.
- Book pages are preserved through Ghost posts tagged `books` and `now-reading`.
- Photo/archive rendering, feeds, and tags follow the existing site templates.

## Data sources

Ghost tags pulled into the site:

- `afterword`
- `status`
- `gallery`
- `listening`
- `now-playing`
- `books`
- `now-reading`
- `photos`

Album Whale feed:

- `https://albumwhale.com/bryan/listening-now.atom`

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

## Run

```bash
npm install
npm run dev
```
