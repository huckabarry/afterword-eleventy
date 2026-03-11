#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const POSTS_ROOT = path.join(ROOT_DIR, "src", "listening-albums");
const IMAGES_ROOT = path.join(ROOT_DIR, "src", "assets", "listening-images");
const DEFAULT_AUTHOR = "Bryan Robb";
const PROFILE_URL = "https://albumwhale.com/bryan";
const DEFAULT_LIST_PATH = "/bryan/listening-now";

const listPageHtmlCache = new Map();

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

function escapeYaml(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
}

function decodeHtmlEntities(value) {
  const text = String(value == null ? "" : value);
  const named = {
    amp: "&",
    apos: "'",
    quot: "\"",
    lt: "<",
    gt: ">",
    nbsp: " "
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
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
    });
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDate(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function dateParts(isoDate) {
  const date = new Date(isoDate);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return { year, month, day };
}

function getUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname || "";
    const ext = path.extname(pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  } catch (error) {
    return ".jpg";
  }

  return ".jpg";
}

function extractTag(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(xml || "").match(re);
  return match ? decodeHtmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
}

function extractLinkHref(entry) {
  const match = String(entry || "").match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return match ? match[1].trim() : "";
}

function toAbsoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch (error) {
    return url || "";
  }
}

function extractCoverFromContent(contentHtml, baseUrl) {
  const match = String(contentHtml || "").match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  return match && match[1] ? toAbsoluteUrl(match[1], baseUrl) : "";
}

function extractNoteFromContent(contentHtml, isoDate) {
  const withoutImages = String(contentHtml || "")
    .replace(/<a[^>]*>\s*<img[\s\S]*?\/?>\s*<\/a>/gi, " ")
    .replace(/<img[^>]*>/gi, " ");
  const text = stripHtml(withoutImages);

  if (!text) {
    return "";
  }

  const formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(isoDate));

  return text === formattedDate ? "" : text;
}

function parseAtomItems(xml, context = {}) {
  const entries = String(xml || "").match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const listUrl = String(context.listUrl || "").trim();
  const listSlug = String(context.listSlug || "").trim();
  const listName = String(context.listName || "").trim();

  return entries.map((entry) => {
    const id = extractTag(entry, "id");
    const title = extractTag(entry, "title");
    const updated = extractTag(entry, "updated");
    const published = extractTag(entry, "published");
    const link = extractLinkHref(entry);
    const contentHtml = extractTag(entry, "content");
    const isoDate = toIsoDate(published || updated || null);

    return {
      id,
      title,
      link,
      date: isoDate,
      cover: extractCoverFromContent(contentHtml, link || listUrl || PROFILE_URL) || null,
      note: extractNoteFromContent(contentHtml, isoDate),
      listUrl,
      listSlug,
      listName
    };
  });
}

function getAlbumAnchorId(link) {
  if (!link) {
    return "";
  }

  const hashIndex = link.indexOf("#");
  if (hashIndex === -1) {
    return "";
  }

  const fragment = link.slice(hashIndex + 1).trim();
  return fragment.startsWith("album_") ? fragment : "";
}

function extractAlbumBlockHtml(listHtml, albumId) {
  if (!listHtml || !albumId) {
    return "";
  }

  const escapedId = albumId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(id=["']${escapedId}["'][\\s\\S]*?)(?=\\bid=["']album_\\d+["']|$)`, "i");
  const match = listHtml.match(re);
  return match && match[1] ? match[1] : "";
}

function extractCoverFromAlbumBlock(blockHtml, pageUrl) {
  if (!blockHtml) {
    return "";
  }

  const imageMatch = blockHtml.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (imageMatch && imageMatch[1]) {
    return toAbsoluteUrl(imageMatch[1], pageUrl);
  }

  const imageAnchor = blockHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*Image:/i);
  if (imageAnchor && imageAnchor[1]) {
    return toAbsoluteUrl(imageAnchor[1], pageUrl);
  }

  return "";
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "afterword.blog albumwhale sync script",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

function parseProfileListPaths(profileHtml) {
  const matches = Array.from(String(profileHtml || "").matchAll(/href=["'](\/bryan\/[^"'?#]+)["']/g));
  const paths = matches
    .map((match) => match[1])
    .filter((value) => {
      const parts = String(value || "")
        .split("/")
        .filter(Boolean);
      return parts.length === 2 && parts[0] === "bryan";
    });

  const unique = Array.from(new Set(paths));
  if (!unique.includes(DEFAULT_LIST_PATH)) {
    unique.push(DEFAULT_LIST_PATH);
  }

  return unique;
}

function getListSlug(listPath) {
  const parts = String(listPath || "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

function getListName(listSlug) {
  return String(listSlug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function getListPageHtml(listUrl) {
  const target = String(listUrl || "").trim();
  if (!target) {
    return "";
  }

  if (listPageHtmlCache.has(target)) {
    return listPageHtmlCache.get(target);
  }

  const html = await fetchText(target);
  listPageHtmlCache.set(target, html);
  return html;
}

async function fetchAlbumWhaleList(listPath) {
  const listUrl = toAbsoluteUrl(listPath, PROFILE_URL);
  const listSlug = getListSlug(listPath);
  const listName = getListName(listSlug);
  const feedUrl = `${listUrl}.atom`;
  const feedXml = await fetchText(feedUrl);
  const albums = parseAtomItems(feedXml, { listUrl, listSlug, listName });
  const needsScrape = albums.some((item) => !item.cover && getAlbumAnchorId(item.link));
  const listHtml = needsScrape ? await getListPageHtml(listUrl) : "";

  return albums.map((album) => {
    if (album.cover) {
      return album;
    }

    const albumId = getAlbumAnchorId(album.link);
    if (!albumId || !listHtml) {
      return album;
    }

    const block = extractAlbumBlockHtml(listHtml, albumId);
    const cover = extractCoverFromAlbumBlock(block, listUrl);

    return {
      ...album,
      cover: cover || null
    };
  });
}

async function fetchAlbumWhale() {
  const profileHtml = await fetchText(PROFILE_URL);
  const listPaths = parseProfileListPaths(profileHtml);
  const combined = [];

  for (const listPath of listPaths) {
    try {
      const listAlbums = await fetchAlbumWhaleList(listPath);
      combined.push(...listAlbums);
    } catch (error) {
      console.warn(`[albumwhale-sync] unable to fetch ${listPath}: ${error.message}`);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const album of combined) {
    const key = String(
      album &&
        `${String(album.id || "").trim()}|${String(album.link || "").trim()}|${String(album.title || "").trim()}`
    ).trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(album);
  }

  return deduped.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
}

async function downloadFile(url, destination) {
  if (!url) {
    return false;
  }

  if (fs.existsSync(destination)) {
    return false;
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "afterword.blog albumwhale sync script"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(destination, buffer);
  return true;
}

function createMarkdown({
  title,
  isoDate,
  slug,
  albumWhaleUrl,
  albumWhaleList,
  albumWhaleListName,
  coverPublicPath,
  albumWhaleOrder,
  note
}) {
  const frontMatter = [
    "---",
    `title: "${escapeYaml(title)}"`,
    `date: ${isoDate}`,
    "tags:",
    "  - listening",
    `slug: "${escapeYaml(slug)}"`,
    `author: "${escapeYaml(DEFAULT_AUTHOR)}"`,
    `albumwhale_url: "${escapeYaml(albumWhaleUrl || "")}"`,
    ...(albumWhaleList ? [`albumwhale_list: "${escapeYaml(albumWhaleList)}"`] : []),
    `albumwhale_order: ${Number.isInteger(albumWhaleOrder) ? albumWhaleOrder : 9999}`,
    ...(note ? [`excerpt: "${escapeYaml(note)}"`] : []),
    "---",
    ""
  ];

  const body = [];

  if (coverPublicPath) {
    body.push(`![](${coverPublicPath})`, "");
  }

  if (note) {
    body.push(note, "");
  }

  if (albumWhaleListName) {
    body.push(`Source list: ${albumWhaleListName}.`, "");
  }

  if (albumWhaleUrl) {
    body.push(`Listened on [Album Whale](${albumWhaleUrl}).`, "");
  }

  if (!body.length) {
    body.push("Listening entry.", "");
  }

  return frontMatter.concat(body).join("\n");
}

async function main() {
  const albums = await fetchAlbumWhale();

  if (!Array.isArray(albums) || albums.length === 0) {
    console.log("[albumwhale-sync] no entries found");
    return;
  }

  let createdPosts = 0;
  let updatedPosts = 0;
  let downloadedImages = 0;
  let existingImages = 0;
  let failedImages = 0;

  for (const [albumIndex, album] of albums.entries()) {
    const title = String(album && album.title ? album.title : "").trim() || "Untitled album";
    const albumWhaleUrl = String(album && album.link ? album.link : "").trim();
    const albumWhaleList = String(album && album.listSlug ? album.listSlug : "").trim();
    const albumWhaleListName = String(album && album.listName ? album.listName : "").trim();
    const isoDate = toIsoDate(album && album.date ? album.date : undefined);
    const { year, month, day } = dateParts(isoDate);
    const slugBase = slugify(title).slice(0, 90) || "album";
    const baseName = `${year}-${month}-${day}-${slugBase}`;

    const postDir = path.join(POSTS_ROOT, year, month);
    await fsp.mkdir(postDir, { recursive: true });
    const postPath = path.join(postDir, `${baseName}.md`);

    let coverPublicPath = "";
    const coverUrl = String(album && album.cover ? album.cover : "").trim();

    if (coverUrl) {
      const hash = crypto.createHash("sha1").update(coverUrl).digest("hex").slice(0, 8);
      const ext = getUrlExtension(coverUrl);
      const imageName = `${baseName}-${hash}${ext}`;
      const imageDir = path.join(IMAGES_ROOT, year);
      const imagePath = path.join(imageDir, imageName);

      await fsp.mkdir(imageDir, { recursive: true });

      try {
        const downloaded = await downloadFile(coverUrl, imagePath);
        if (downloaded) {
          downloadedImages += 1;
        } else {
          existingImages += 1;
        }

        coverPublicPath = `/assets/listening-images/${year}/${imageName}`;
      } catch (error) {
        failedImages += 1;
        console.warn(`[albumwhale-sync] cover download failed for "${title}": ${error.message}`);
      }
    }

    const markdown = createMarkdown({
      title,
      isoDate,
      slug: baseName,
      albumWhaleUrl,
      albumWhaleList,
      albumWhaleListName,
      coverPublicPath,
      albumWhaleOrder: albumIndex,
      note: String(album && album.note ? album.note : "").trim()
    });

    const alreadyExists = fs.existsSync(postPath);
    const previous = alreadyExists ? await fsp.readFile(postPath, "utf8") : "";

    if (previous !== markdown) {
      await fsp.writeFile(postPath, markdown, "utf8");
      if (alreadyExists) {
        updatedPosts += 1;
      } else {
        createdPosts += 1;
      }
    }

  }

  // Do not prune local listening history when feeds are partial/truncated.
  // We only create/update items we can currently fetch and preserve older files.

  console.log(
    `[albumwhale-sync] posts created: ${createdPosts}, posts updated: ${updatedPosts}, image downloads: ${downloadedImages}, image already present: ${existingImages}, image download failures: ${failedImages}`
  );
}

main().catch((error) => {
  console.error(`[albumwhale-sync] fatal error: ${error.stack || error.message}`);
  process.exit(1);
});
