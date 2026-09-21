import { defineConfig } from "vitepress";

const SITE_URL = "https://qacut.com";
const SITE_DESCRIPTION =
  "Screenshots an AI agent can act on. Screen recordings people will actually watch. Free and open source for Windows.";

// The docs are written with QACut itself: process docs exported from the
// studio land under docs/ as markdown with their images and clips beside
// them. VitePress turns the folder into the site; nothing else to do.
export default defineConfig({
  title: "QACut",
  description: SITE_DESCRIPTION,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE_URL },
  head: [
    ["link", { rel: "icon", href: "/favicon.png" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "QACut" }],
    ["meta", { property: "og:title", content: "QACut: screen capture that hands off" }],
    ["meta", { property: "og:description", content: SITE_DESCRIPTION }],
    ["meta", { property: "og:url", content: "https://qacut.com/" }],
    ["meta", { property: "og:image", content: "https://qacut.com/og.png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "QACut: screen capture that hands off" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "QACut: screen capture that hands off" }],
    ["meta", { name: "twitter:description", content: SITE_DESCRIPTION }],
    ["meta", { name: "twitter:image", content: "https://qacut.com/og.png" }],
  ],
  // Per-page Open Graph and Twitter tags. The home page keeps the
  // site-wide values above; every other page describes itself. VitePress
  // drops a site head tag when the page sets the same one, so these win.
  transformPageData(pageData) {
    if (pageData.relativePath === "index.md") return;
    const path = pageData.relativePath.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1");
    const url = `${SITE_URL}/${path}`;
    const title = pageData.frontmatter.title || pageData.title || "QACut";
    const description = pageData.frontmatter.description || pageData.description || SITE_DESCRIPTION;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    );
  },
  themeConfig: {
    siteTitle: '<span class="qa">QA</span>Cut',
    logo: "/logo.png",
    nav: [
      { text: "Docs", link: "/docs/getting-started" },
      {
        text: "Use cases",
        items: [
          {
            text: "QACut Basic",
            items: [
              { text: "Copy and paste a screenshot", link: "/use-cases/copy-and-paste" },
              { text: "Mark up a screenshot and paste it", link: "/use-cases/mark-up-and-paste" },
              { text: "Send screenshots to an AI agent", link: "/use-cases/agent-feedback-loops" },
            ],
          },
          {
            text: "QACut Bundles",
            items: [
              { text: "Organize screenshots into a document", link: "/use-cases/organize-and-export" },
              { text: "Auto-capture a process", link: "/use-cases/automated-process-capture" },
              { text: "Hand a bundle to an agent with your brand kit", link: "/use-cases/agent-with-brand-kit" },
              { text: "A task list of UI fixes for an agent", link: "/use-cases/task-list-for-agents" },
            ],
          },
          {
            text: "QACut Studio",
            items: [
              { text: "Polished screen recordings", link: "/use-cases/polished-screen-recordings" },
              { text: "Record with narration", link: "/use-cases/record-with-microphone" },
              { text: "Add your camera", link: "/use-cases/record-with-camera" },
              { text: "Brand a recording", link: "/use-cases/record-with-brand" },
            ],
          },
          { text: "All use cases", link: "/use-cases/" },
        ],
      },
      { text: "Changelog", link: "/changelog" },
      { text: "Feedback", link: "/feedback" },
      { text: "Download", link: "/download" },
      { text: "GitHub", link: "https://github.com/mcinnisdev/qacut" },
    ],
    sidebar: {
      "/use-cases/": [
        { text: "All use cases", link: "/use-cases/" },
        {
          text: "QACut Basic",
          items: [
            { text: "Overview", link: "/use-cases/quick-shots" },
            { text: "Copy and paste a screenshot", link: "/use-cases/copy-and-paste" },
            { text: "Mark up and paste", link: "/use-cases/mark-up-and-paste" },
            { text: "Send to an AI agent", link: "/use-cases/agent-feedback-loops" },
          ],
        },
        {
          text: "QACut Bundles",
          items: [
            { text: "Overview", link: "/use-cases/bundles" },
            { text: "Organize and export a document", link: "/use-cases/organize-and-export" },
            { text: "Auto-capture a process", link: "/use-cases/automated-process-capture" },
            { text: "Agent with your brand kit", link: "/use-cases/agent-with-brand-kit" },
            { text: "Task list for an agent", link: "/use-cases/task-list-for-agents" },
          ],
        },
        {
          text: "QACut Studio",
          items: [
            { text: "Overview", link: "/use-cases/studio" },
            { text: "Polished screen recordings", link: "/use-cases/polished-screen-recordings" },
            { text: "Record with narration", link: "/use-cases/record-with-microphone" },
            { text: "Add your camera", link: "/use-cases/record-with-camera" },
            { text: "Brand a recording", link: "/use-cases/record-with-brand" },
          ],
        },
      ],
      "/docs/": [
        {
          text: "Start here",
          items: [
            { text: "Getting started", link: "/docs/getting-started" },
            { text: "Keyboard shortcuts", link: "/docs/shortcuts" },
            { text: "Prompt library", link: "/docs/prompts" },
          ],
        },
        {
          text: "QACut Basic",
          items: [{ text: "Quick shots", link: "/docs/quick" }],
        },
        {
          text: "QACut Bundles",
          items: [
            { text: "Bundles for agents", link: "/docs/qacut" },
            { text: "Brand kit", link: "/docs/brand-kit" },
          ],
        },
        {
          text: "QACut Studio",
          items: [{ text: "Polished screen recordings", link: "/docs/studio" }],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/mcinnisdev/qacut" },
      { icon: "x", link: "https://x.com/qa_cut" },
    ],
    // The footer is Footer.vue, mounted in theme/index.ts.
    search: { provider: "local" },
  },
});
