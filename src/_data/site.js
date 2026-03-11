require("dotenv").config();
const fs = require("fs");
const path = require("path");

const defaultHomeIntro =
  "Afterword is a personal site for essays, status updates, reading notes, listening posts, and photos.";

function readHomeIntro() {
  const introPath = path.join(__dirname, "..", "home-intro.md");

  try {
    if (!fs.existsSync(introPath)) {
      return defaultHomeIntro;
    }

    return fs
      .readFileSync(introPath, "utf8")
      .replace(/\r\n/g, "\n")
      .trim() || defaultHomeIntro;
  } catch (error) {
    console.warn(`[afterword-eleventy] unable to read home intro markdown: ${error.message}`);
    return defaultHomeIntro;
  }
}

module.exports = async function () {
  const configuredUrl = process.env.SITE_URL || "https://afterword.blog";
  const normalizedSiteUrl = /^https?:\/\//i.test(configuredUrl)
    ? configuredUrl
    : `https://${configuredUrl}`;
  const homeIntro = readHomeIntro();
  const data = {
    title: process.env.SITE_TITLE || "Afterword",
    description: homeIntro,
    homeIntro,
    logo: process.env.SITE_LOGO || "/assets/site/avatar.jpg",
    url: normalizedSiteUrl,
    lang: "en"
  };

  data.domain = new URL(normalizedSiteUrl).hostname;
  data.relMe = [
    process.env.REL_ME_MASTODON || "https://urbanists.social/@bryan",
    process.env.REL_ME_BLUESKY || "https://bsky.app/profile/afterword.blog"
  ].filter(Boolean);
  data.webmentions = {
    username: data.domain,
    endpoint: `https://webmention.io/${data.domain}/webmention`,
    pingback: `https://webmention.io/${data.domain}/xmlrpc`,
    api: "https://webmention.io/api/mentions.jf2"
  };
  data.albumWhaleUrl = process.env.ALBUM_WHALE_URL || "https://albumwhale.com/bryan/listening-now";
  data.microblogUrl = process.env.MICROBLOG_URL || "https://micro.blog/bryan";
  data.navigation = [
    {
      label: "Home",
      url: "/"
    },
    {
      label: "Photos",
      url: "/photos/"
    },
    {
      label: "Listening",
      url: "/listening-now/"
    },
    {
      label: "Books",
      url: "/tags/books/"
    },
    {
      label: "About",
      url: "/about/"
    }
  ];

  return data;
};
