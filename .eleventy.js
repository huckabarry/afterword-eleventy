const GhostAdminAPI = require("@tryghost/admin-api");
const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const rssPlugin = require("@11ty/eleventy-plugin-rss");

const ghostApiUrl = process.env.GHOST_ADMIN_URL || process.env.GHOST_URL || "https://lowvelocity.org";
const ghostApiKey = process.env.GHOST_ADMIN_KEY;
const canUseGhostApi = Boolean(ghostApiUrl && ghostApiKey);
const ghostApi = canUseGhostApi
  ? new GhostAdminAPI({
      url: ghostApiUrl,
      key: ghostApiKey,
      version: "v5.71"
    })
  : null;

const INCLUDED_SITE_TAGS = [
  "afterword",
  "status",
  "gallery",
  "photos",
  "listening",
  "now-playing",
  "books",
  "now-reading"
];

const TAG_DESCRIPTIONS = {
  afterword: "Longer posts from Low Velocity.",
  status: "Short posts and status updates.",
  gallery: "Photo posts and visual entries.",
  photos: "Photo posts and visual entries.",
  listening: "Listening posts and music notes.",
  "now-playing": "Listening posts and music notes.",
  books: "Reading posts and books.",
  "now-reading": "Reading posts and books."
};

let ghostPostsPromise;

function postHasTag(post, slug) {
  return (post.tags || []).some((tag) => tag && tag.slug === slug);
}

function parseTagSlugs(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}

function isUsablePhotoUrl(url) {
  const value = String(url || "");

  if (!value) {
    return false;
  }

  if (/\.(png)(\?|$)/i.test(value)) {
    return false;
  }

  if (/favicon|bookwyrm|avatar|screenshot|screen-shot|screen_shot/i.test(value)) {
    return false;
  }

  return true;
}

function getImageAlt(fragment, fallback = "") {
  const match = String(fragment || "").match(/\salt=["']([^"']*)["']/i);
  return match ? match[1] : fallback;
}

function extractAllImages(post) {
  const html = String(post && post.html ? post.html : "");
  const cleanedHtml = html
    .replace(/<figure[^>]*class=["'][^"']*kg-bookmark-card[^"']*["'][\s\S]*?<\/figure>/gi, "")
    .replace(/<div[^>]*class=["'][^"']*kg-bookmark-card[^"']*["'][\s\S]*?<\/div>/gi, "")
    .replace(/<figure[^>]*class=["'][^"']*kg-embed-card[^"']*["'][\s\S]*?<\/figure>/gi, "")
    .replace(/<div[^>]*class=["'][^"']*kg-embed-card[^"']*["'][\s\S]*?<\/div>/gi, "");
  const matches = [];
  const seen = new Set();
  const imagePattern = /<img(?![^>]*class=["'][^"']*kg-bookmark-(?:thumbnail|icon)[^"']*["'])[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imagePattern.exec(cleanedHtml))) {
    const fragment = match[0];
    const classMatch = fragment.match(/\bclass=["']([^"']+)["']/i);
    const classNames = classMatch ? classMatch[1] : "";
    if (/(^|\s)(avatar|author|profile|icon)(\s|$)/i.test(classNames)) {
      continue;
    }

    const src = match[1];

    if (!isUsablePhotoUrl(src) || seen.has(src)) {
      continue;
    }

    seen.add(src);
    matches.push({
      src,
      alt: getImageAlt(fragment, post.title || "")
    });
  }

  if (!matches.length && post && post.feature_image && isUsablePhotoUrl(post.feature_image)) {
    matches.push({
      src: post.feature_image,
      alt: post.title || ""
    });
  }

  return matches;
}

function extractFirstImage(post) {
  return extractAllImages(post)[0] || null;
}

function stripFirstImage(html) {
  const source = String(html || "");
  const patterns = [
    /<figure[^>]*class=["'][^"']*kg-image-card[^"']*["'][\s\S]*?<\/figure>/i,
    /<figure[^>]*class=["'][^"']*kg-gallery-card[^"']*["'][\s\S]*?<\/figure>/i,
    /<figure[\s\S]*?<img[^>]*>[\s\S]*?<\/figure>/i,
    /<p>\s*<img[^>]*>\s*<\/p>/i,
    /<img[^>]*>/i
  ];

  for (const pattern of patterns) {
    if (pattern.test(source)) {
      return source.replace(pattern, "").trim();
    }
  }

  return source;
}

function stripBookmarkCardImages(html) {
  const source = String(html || "");

  return source
    .replace(
      /<(figure|div)([^>]*class=["'][^"']*kg-bookmark-card[^"']*["'][^>]*)>[\s\S]*?<\/\1>/gi,
      (block) => block.replace(/<img\b[^>]*>/gi, "")
    )
    .replace(/<div[^>]*class=["'][^"']*kg-bookmark-thumbnail[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<span[^>]*class=["'][^"']*kg-bookmark-icon[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<img[^>]*class=["'][^"']*kg-bookmark-(?:thumbnail|icon)[^"']*["'][^>]*>/gi, "");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getStatusLabel(post) {
  if (postHasTag(post, "status")) {
    return "";
  }

  return post.title || "";
}

function isUntitledPost(post) {
  const title = String(post && post.title ? post.title : "").trim().toLowerCase();
  return !title || title === "untitled";
}

function getPlainTextPreview(post, maxLength = 220) {
  const text = String(post && post.html ? post.html : "")
    .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}…`;
}

function getStatusPreview(post) {
  const excerpt = String(post && post.excerpt ? post.excerpt : "").trim();

  if (excerpt) {
    return excerpt;
  }

  const preview = getPlainTextPreview(post);

  if (preview) {
    return preview;
  }

  return String(post && post.title ? post.title : "").trim();
}

function firstWords(value, count = 7) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length <= count) {
    return words.join(" ");
  }

  return `${words.slice(0, count).join(" ")}…`;
}

function isUntitledLikeTitle(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[\(\[\{]\s*/, "")
    .replace(/\s*[\)\]\}]$/, "");

  return !normalized || normalized === "untitled";
}

function getLocalPostSlug(post) {
  const ghostSlug = String(post && post.slug ? post.slug : "").trim();

  if (!postHasTag(post, "status")) {
    return ghostSlug;
  }

  if (ghostSlug && ghostSlug !== "untitled") {
    return ghostSlug;
  }

  const words = getStatusPreview(post).split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  const derivedSlug = slugify(words);

  return derivedSlug || ghostSlug || "status";
}

function getLocalPostUrl(post) {
  return `/${getLocalPostSlug(post)}/`;
}

function normalizeDate(value, fallback = new Date(0).toISOString()) {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString();
}

function getPostPublishedTime(post) {
  return new Date(post && post.published_at ? post.published_at : 0).getTime();
}

function getPostUpdatedTime(post) {
  return new Date(post && post.updated_at ? post.updated_at : 0).getTime();
}

function comparePostsDesc(a, b) {
  const publishedDiff = getPostPublishedTime(b) - getPostPublishedTime(a);
  if (publishedDiff !== 0) {
    return publishedDiff;
  }

  const updatedDiff = getPostUpdatedTime(b) - getPostUpdatedTime(a);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return getLocalPostSlug(b).localeCompare(getLocalPostSlug(a));
}

function getCollectionIndex(posts, currentPost) {
  const items = Array.isArray(posts) ? posts : [];
  const currentId = currentPost && currentPost.id;
  const currentSlug = currentPost && currentPost.slug;
  const currentLocalSlug = currentPost ? getLocalPostSlug(currentPost) : "";

  return items.findIndex((post) => {
    if (currentId && post.id === currentId) {
      return true;
    }

    if (currentSlug && post.slug === currentSlug) {
      return true;
    }

    return currentLocalSlug && getLocalPostSlug(post) === currentLocalSlug;
  });
}

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdataSafe(value) {
  return String(value == null ? "" : value).replace(/]]>/g, "]]]]><![CDATA[>");
}

async function browseGhostPosts() {
  if (!ghostApi) {
    console.warn("[lowvelocity-eleventy] Ghost API env vars missing; returning no Ghost posts.");
    return [];
  }

  const filter = `status:published+tag:[${INCLUDED_SITE_TAGS.join(",")}]`;
  const limit = 100;
  let page = 1;
  let totalPages = 1;
  const posts = [];

  do {
    const batch = await ghostApi.posts.browse({
      formats: "html",
      include: "tags,authors",
      filter,
      limit,
      page
    });

    posts.push(...batch);

    const pagination = batch.meta && batch.meta.pagination ? batch.meta.pagination : null;
    totalPages = pagination && pagination.pages ? pagination.pages : batch.length === limit ? page + 1 : page;
    page += 1;
  } while (page <= totalPages);

  return posts
    .map((post) => ({
      ...post,
      published_at: normalizeDate(post.published_at),
      updated_at: normalizeDate(post.updated_at || post.published_at, normalizeDate(post.published_at))
    }))
    .sort(comparePostsDesc);
}

async function getGhostPosts() {
  if (!ghostPostsPromise) {
    ghostPostsPromise = browseGhostPosts();
  }

  return ghostPostsPromise;
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(syntaxHighlight);
  eleventyConfig.addPlugin(rssPlugin);
  eleventyConfig.addLayoutAlias("base", "layouts/default.njk");
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  eleventyConfig.addFilter("dateReadable", (date) => new Date(date).toDateString());

  eleventyConfig.addFilter("dateDisplay", (date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC"
    }).formatToParts(new Date(date));

    const day = parts.find((part) => part.type === "day")?.value || "";
    const month = parts.find((part) => part.type === "month")?.value || "";

    return `${day} ${month}`.trim();
  });

  eleventyConfig.addFilter("htmlDateString", (dateObj) => new Date(dateObj).toISOString().split("T")[0]);
  eleventyConfig.addFilter("rfc3339Date", (dateObj) => new Date(dateObj).toISOString());
  eleventyConfig.addFilter("rfc822Date", (dateObj) => new Date(dateObj).toUTCString());
  eleventyConfig.addFilter("xmlEscape", (value) => xmlEscape(value));
  eleventyConfig.addFilter("cdataSafe", (value) => cdataSafe(value));
  eleventyConfig.addFilter("getReadingTime", (html) => {
    const text = String(html || "").replace(/<[^>]*>/g, " ");
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.ceil(words / 200));
  });

  eleventyConfig.addFilter("withTagSlug", (posts, slug) => (posts || []).filter((post) => postHasTag(post, slug)));
  eleventyConfig.addFilter("withAnyTagSlugs", (posts, slugs) => {
    const tagSlugs = parseTagSlugs(slugs);
    return (posts || []).filter((post) => tagSlugs.some((slug) => postHasTag(post, slug)));
  });
  eleventyConfig.addFilter("withoutTagSlug", (posts, slug) => (posts || []).filter((post) => !postHasTag(post, slug)));
  eleventyConfig.addFilter("withoutAnyTagSlugs", (posts, slugs) => {
    const tagSlugs = parseTagSlugs(slugs);
    return (posts || []).filter((post) => !tagSlugs.some((slug) => postHasTag(post, slug)));
  });
  eleventyConfig.addFilter("onlyUntitledPosts", (posts) => (posts || []).filter((post) => isUntitledPost(post)));
  eleventyConfig.addFilter("onlyTitledPosts", (posts) => (posts || []).filter((post) => !isUntitledPost(post)));
  eleventyConfig.addFilter("withoutUntitledStatusPosts", (posts) => {
    return (posts || []).filter((post) => !(postHasTag(post, "status") && isUntitledPost(post)));
  });
  eleventyConfig.addFilter("byPublishedDateDesc", (posts) => [...(posts || [])].sort(comparePostsDesc));
  eleventyConfig.addFilter("hasTagSlug", (post, slug) => postHasTag(post, slug));
  eleventyConfig.addFilter("feedTitle", (post) => getStatusLabel(post));
  eleventyConfig.addFilter("localPostUrl", (post) => getLocalPostUrl(post));
  eleventyConfig.addFilter("localPostSlug", (post) => getLocalPostSlug(post));
  eleventyConfig.addFilter("statusPreview", (post) => getStatusPreview(post));
  eleventyConfig.addFilter("firstWords", (value, count = 7) => firstWords(value, count));
  eleventyConfig.addFilter("isUntitledLikeTitle", (value) => isUntitledLikeTitle(value));
  eleventyConfig.addFilter("rssDescription", (post) => {
    const excerpt = String(post && post.excerpt ? post.excerpt : "").trim();
    return excerpt || getPlainTextPreview(post, 400);
  });
  eleventyConfig.addFilter("getPreviousPost", (posts, currentPost) => {
    const index = getCollectionIndex(posts, currentPost);
    return index >= 0 ? posts[index + 1] || null : null;
  });
  eleventyConfig.addFilter("getNextPost", (posts, currentPost) => {
    const index = getCollectionIndex(posts, currentPost);
    return index > 0 ? posts[index - 1] || null : null;
  });
  eleventyConfig.addFilter("firstImage", (post) => extractFirstImage(post));
  eleventyConfig.addFilter("stripFirstImage", (html) => stripFirstImage(html));
  eleventyConfig.addFilter("feedHtml", (html) => stripBookmarkCardImages(html));

  eleventyConfig.addCollection("posts", async () => {
    return await getGhostPosts();
  });

  eleventyConfig.addCollection("photoPosts", async () => {
    const posts = await getGhostPosts();

    return posts
      .filter((post) => postHasTag(post, "gallery") || postHasTag(post, "photos"))
      .flatMap((post) =>
        extractAllImages(post).map((image, index) => ({
          ...post,
          image,
          imageIndex: index
        }))
      );
  });

  eleventyConfig.addCollection("bookPosts", async () => {
    const posts = await getGhostPosts();

    return posts
      .filter((post) => postHasTag(post, "books") || postHasTag(post, "now-reading"))
      .map((post) => ({
        ...post,
        firstImage: extractFirstImage(post)
      }))
      .filter((post) => post.firstImage);
  });

  eleventyConfig.addCollection("tagPages", async () => {
    const posts = await getGhostPosts();
    const tags = new Map();

    posts.forEach((post) => {
      (post.tags || []).forEach((tag) => {
        if (!tag || !tag.slug || tag.slug === "now" || tag.visibility === "internal") {
          return;
        }

        if (!tags.has(tag.slug)) {
          tags.set(tag.slug, {
            ...tag,
            url: `/tags/${tag.slug}/`,
            description: TAG_DESCRIPTIONS[tag.slug] || "",
            posts: []
          });
        }

        tags.get(tag.slug).posts.push(post);
      });
    });

    return Array.from(tags.values())
      .map((tag) => ({
        ...tag,
        posts: tag.posts.sort(comparePostsDesc)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site"
    },
    passthroughFileCopy: true
  };
};
