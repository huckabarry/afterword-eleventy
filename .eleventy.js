const fs = require("fs");

const ghostApiUrl = process.env.GHOST_ADMIN_URL || process.env.GHOST_URL || "https://lowvelocity.org";
const ghostApiKey = process.env.GHOST_ADMIN_KEY;
const canUseGhostApi = Boolean(ghostApiUrl && ghostApiKey);
let ghostApi = null;

const INCLUDED_SITE_TAGS = ["afterword", "status", "gallery", "photos", "now"];

const TAG_DESCRIPTIONS = {
  afterword: "Longer posts from Low Velocity.",
  status: "Short posts and status updates.",
  gallery: "Photo posts and visual entries.",
  photos: "Photo posts and visual entries.",
  listening: "Album Whale listening history.",
  "now-playing": "Album Whale listening history.",
  books: "BookWyrm reading history.",
  "now-reading": "Books currently in progress."
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

function isListeningPost(post) {
  return postHasTag(post, "listening") || postHasTag(post, "now-playing");
}

function isBookPost(post) {
  return postHasTag(post, "books") || postHasTag(post, "now-reading");
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

function toTagName(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function decodeHtmlEntities(value) {
  const text = String(value == null ? "" : value);
  const namedEntities = {
    amp: "&",
    apos: "'",
    quot: "\"",
    lt: "<",
    gt: ">",
    nbsp: " ",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    ndash: "-",
    mdash: "-"
  };
  const toCodePoint = (num) => {
    if (!Number.isInteger(num) || num < 0 || num > 0x10ffff) {
      return "";
    }

    try {
      return String.fromCodePoint(num);
    } catch (error) {
      return "";
    }
  };

  return text
    .replace(/&#(\d+);/g, (_, dec) => toCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => toCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name) => {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(namedEntities, key) ? namedEntities[key] : match;
    });
}

function getPlainTextPreview(post, maxLength = 220) {
  const text = decodeHtmlEntities(
    String(post && post.html ? post.html : "")
      .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}…`;
}

function getStatusPreview(post) {
  const excerpt = decodeHtmlEntities(String(post && post.excerpt ? post.excerpt : "").trim());

  if (excerpt) {
    return excerpt;
  }

  const preview = getPlainTextPreview(post);
  if (preview) {
    return preview;
  }

  return decodeHtmlEntities(String(post && post.title ? post.title : "").trim());
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

function getBaseLocalPostSlug(post) {
  const ghostSlug = String(post && post.slug ? post.slug : "").trim();

  if (!postHasTag(post, "status")) {
    return ghostSlug;
  }

  if (ghostSlug && ghostSlug !== "untitled") {
    return ghostSlug;
  }

  const words = getStatusPreview(post)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  const derivedSlug = slugify(words);

  return derivedSlug || ghostSlug || "status";
}

function getLocalPostSlug(post) {
  const assignedSlug = String(post && post.local_permalink_slug ? post.local_permalink_slug : "").trim();
  return assignedSlug || getBaseLocalPostSlug(post);
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
  const value = new Date(post && post.published_at ? post.published_at : 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function getPostUpdatedTime(post) {
  const value = new Date(post && post.updated_at ? post.updated_at : 0).getTime();
  return Number.isFinite(value) ? value : 0;
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

  const aListeningOrder = Number.isFinite(Number(a && a.albumwhale_order)) ? Number(a.albumwhale_order) : null;
  const bListeningOrder = Number.isFinite(Number(b && b.albumwhale_order)) ? Number(b.albumwhale_order) : null;
  if (
    isListeningPost(a) &&
    isListeningPost(b) &&
    aListeningOrder !== null &&
    bListeningOrder !== null &&
    aListeningOrder !== bListeningOrder
  ) {
    return aListeningOrder - bListeningOrder;
  }

  return getBaseLocalPostSlug(b).localeCompare(getBaseLocalPostSlug(a));
}

function dedupePostsByIdentity(posts) {
  const seen = new Set();

  return (posts || []).filter((post) => {
    const identity = String(
      post && (post.id || post.uuid || post.albumwhale_url || post.bookwyrm_url)
        ? post.id || post.uuid || post.albumwhale_url || post.bookwyrm_url
        : ""
    ).trim();

    if (!identity) {
      return true;
    }

    if (seen.has(identity)) {
      return false;
    }

    seen.add(identity);
    return true;
  });
}

function getPostDayKey(post) {
  const value = String(post && post.published_at ? post.published_at : "").trim();
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString().slice(0, 10).replace(/-/g, "");
}

function getPostIdentitySuffix(post) {
  const source = String(
    post && (post.id || post.uuid || post.updated_at || post.published_at)
      ? post.id || post.uuid || post.updated_at || post.published_at
      : ""
  ).trim();
  if (!source) {
    return "";
  }

  return slugify(source).slice(-8);
}

function assignUniqueLocalSlugs(posts) {
  const used = new Set();

  return (posts || []).map((post, index) => {
    const baseSlug = getBaseLocalPostSlug(post);
    if (!baseSlug) {
      return post;
    }

    let candidate = baseSlug;

    if (used.has(candidate)) {
      const dayKey = getPostDayKey(post);
      const identitySuffix = getPostIdentitySuffix(post);
      const fallbackCandidates = [
        dayKey ? `${baseSlug}-${dayKey}` : "",
        dayKey && identitySuffix ? `${baseSlug}-${dayKey}-${identitySuffix}` : "",
        identitySuffix ? `${baseSlug}-${identitySuffix}` : ""
      ].filter(Boolean);

      candidate = fallbackCandidates.find((value) => !used.has(value)) || "";

      let counter = 2;
      while (!candidate || used.has(candidate)) {
        candidate = `${baseSlug}-${counter}`;
        counter += 1;
      }
    }

    used.add(candidate);

    return {
      ...post,
      local_permalink_slug: candidate
    };
  });
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

function toAbsoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch (error) {
    return value || "";
  }
}

function convertHtmlToAbsoluteUrls(html, base) {
  return String(html || "").replace(/\b(href|src)=["']([^"']+)["']/gi, (match, attr, value) => {
    return `${attr}="${toAbsoluteUrl(value, base)}"`;
  });
}

function getGhostApi() {
  if (!canUseGhostApi) {
    return null;
  }

  if (!ghostApi) {
    const GhostAdminAPI = require("@tryghost/admin-api");
    ghostApi = new GhostAdminAPI({
      url: ghostApiUrl,
      key: ghostApiKey,
      version: "v5.71"
    });
  }

  return ghostApi;
}

function stripFrontMatter(source) {
  const text = String(source || "").replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n")) {
    return text;
  }

  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return text;
  }

  return text.slice(end + 5);
}

function readLocalMarkdownBody(filePath) {
  if (!filePath) {
    return "";
  }

  try {
    return stripFrontMatter(fs.readFileSync(filePath, "utf8")).trim();
  } catch (error) {
    console.warn(`[afterword] unable to read local markdown ${filePath}: ${error.message}`);
    return "";
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdownToHtml(text) {
  return escapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      return `<img src="${escapeHtml(src || "")}" alt="${escapeHtml(alt || "")}">`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    });
}

function markdownToSimpleHtml(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const htmlBlocks = [];
  const paragraphLines = [];
  const listItems = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }

    htmlBlocks.push(`<p>${paragraphLines.map((line) => inlineMarkdownToHtml(line)).join("<br>")}</p>`);
    paragraphLines.length = 0;
  };

  const flushList = () => {
    if (!listItems.length) {
      return;
    }

    htmlBlocks.push(
      `<ul>${listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</ul>`
    );
    listItems.length = 0;
  };

  normalized.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      return;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      htmlBlocks.push(`<h${level}>${inlineMarkdownToHtml(headingMatch[2])}</h${level}>`);
      return;
    }

    const listMatch = line.match(/^-\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      return;
    }

    const imageOnlyMatch = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (imageOnlyMatch) {
      flushParagraph();
      flushList();
      htmlBlocks.push(
        `<p><img src="${escapeHtml(imageOnlyMatch[2])}" alt="${escapeHtml(imageOnlyMatch[1])}"></p>`
      );
      return;
    }

    flushList();
    paragraphLines.push(rawLine);
  });

  flushParagraph();
  flushList();

  return htmlBlocks.join("\n");
}

function parseLocalPostTags(value, requiredTag) {
  const rawTags = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

  const normalized = rawTags.map((tag) => slugify(tag)).filter(Boolean);
  const required = slugify(requiredTag || "");

  if (required && !normalized.includes(required)) {
    normalized.unshift(required);
  }

  const seen = new Set();

  return normalized
    .filter((tag) => {
      if (seen.has(tag)) {
        return false;
      }

      seen.add(tag);
      return true;
    })
    .map((tagSlug) => ({
      slug: tagSlug,
      name: toTagName(tagSlug),
      visibility: "public"
    }));
}

function createLocalMarkdownPost(item, options = {}) {
  const { idPrefix = "local-post", requiredTag = "" } = options;
  const data = (item && item.data) || {};
  const slug = slugify(data.slug || item.fileSlug || "");
  const publishedAt = normalizeDate(
    data.published_at || data.date || item.date,
    item && item.date ? new Date(item.date).toISOString() : new Date().toISOString()
  );
  const updatedAt = normalizeDate(data.updated_at || data.modified_at || publishedAt, publishedAt);
  const title = String(data.title || "").trim() || "Untitled";
  const html = markdownToSimpleHtml(readLocalMarkdownBody(item && item.inputPath ? item.inputPath : ""));
  const excerpt = decodeHtmlEntities(String(data.excerpt || "").trim());
  const featureImage = data.feature_image || data.featureImage || "";
  const albumWhaleUrl = String(data.albumwhale_url || "").trim();
  const bookWyrmUrl = String(data.bookwyrm_url || "").trim();
  const authorName = String(data.author || data.author_name || "Bryan Robb").trim() || "Bryan Robb";
  const albumWhaleOrder = Number.isFinite(Number(data.albumwhale_order)) ? Number(data.albumwhale_order) : null;
  const bookAuthor = String(data.book_author || "").trim() || null;

  return {
    id: `${idPrefix}:${slug || item.fileSlug || item.inputPath}`,
    uuid: `${idPrefix}:${slug || item.fileSlug || item.inputPath}`,
    slug: slug || item.fileSlug || "post",
    title,
    html,
    excerpt,
    feature_image: featureImage || null,
    albumwhale_url: albumWhaleUrl || null,
    bookwyrm_url: bookWyrmUrl || null,
    albumwhale_order: albumWhaleOrder,
    book_author: bookAuthor,
    visibility: "published",
    published_at: publishedAt,
    updated_at: updatedAt,
    tags: parseLocalPostTags(data.tags, requiredTag),
    primary_author: {
      name: authorName
    },
    authors: [
      {
        name: authorName
      }
    ]
  };
}

function createLocalListeningPost(item) {
  return createLocalMarkdownPost(item, {
    idPrefix: "local-listening",
    requiredTag: "listening"
  });
}

function createLocalBookPost(item) {
  return createLocalMarkdownPost(item, {
    idPrefix: "local-book",
    requiredTag: "books"
  });
}

async function browseGhostPosts() {
  const api = getGhostApi();

  if (!api) {
    console.warn("[afterword] Ghost API env vars missing; returning no Ghost posts.");
    return [];
  }

  const filter = `status:published+tag:[${INCLUDED_SITE_TAGS.join(",")}]`;
  const limit = 100;
  let page = 1;
  let totalPages = 1;
  const posts = [];

  do {
    const batch = await api.posts.browse({
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

async function getGhostNowPosts() {
  const posts = await getGhostPosts();
  return posts.filter((post) => postHasTag(post, "now"));
}

function getLocalListeningPosts(collectionApi) {
  if (!collectionApi || typeof collectionApi.getFilteredByGlob !== "function") {
    return [];
  }

  return collectionApi
    .getFilteredByGlob("src/listening-albums/**/*.md")
    .filter((item) => !(item.fileSlug || "").startsWith("_"))
    .map((item) => createLocalListeningPost(item));
}

function getLocalBookPosts(collectionApi) {
  if (!collectionApi || typeof collectionApi.getFilteredByGlob !== "function") {
    return [];
  }

  return collectionApi
    .getFilteredByGlob("src/reading-books/**/*.md")
    .filter((item) => !(item.fileSlug || "").startsWith("_"))
    .map((item) => createLocalBookPost(item));
}

async function getMergedPosts(collectionApi) {
  const ghostPosts = await getGhostPosts();
  const localListeningPosts = getLocalListeningPosts(collectionApi);
  const localBookPosts = getLocalBookPosts(collectionApi);
  const merged = assignUniqueLocalSlugs(
    dedupePostsByIdentity([...ghostPosts, ...localListeningPosts, ...localBookPosts]).sort(comparePostsDesc)
  );

  console.log(
    `[afterword] merged posts: ghost=${ghostPosts.length}, local-listening=${localListeningPosts.length}, local-books=${localBookPosts.length}, total=${merged.length}`
  );

  return merged;
}

module.exports = function (eleventyConfig) {
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
  eleventyConfig.addFilter("absoluteUrl", (value, base) => toAbsoluteUrl(value, base));
  eleventyConfig.addFilter("htmlToAbsoluteUrls", (html, base) => convertHtmlToAbsoluteUrls(html, base));
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

  eleventyConfig.addCollection("posts", async (collectionApi) => {
    return await getMergedPosts(collectionApi);
  });

  eleventyConfig.addCollection("listeningPosts", async (collectionApi) => {
    return assignUniqueLocalSlugs(getLocalListeningPosts(collectionApi)).sort(comparePostsDesc);
  });

  eleventyConfig.addCollection("ghostNowPosts", async () => {
    return await getGhostNowPosts();
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

  eleventyConfig.addCollection("bookPosts", async (collectionApi) => {
    const posts = assignUniqueLocalSlugs(getLocalBookPosts(collectionApi)).sort(comparePostsDesc);

    return posts.map((post) => ({
      ...post,
      firstImage: extractFirstImage(post)
    }));
  });

  eleventyConfig.addCollection("tagPages", async (collectionApi) => {
    const posts = await getMergedPosts(collectionApi);
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
