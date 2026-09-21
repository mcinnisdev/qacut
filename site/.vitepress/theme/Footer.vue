<script setup lang="ts">
// Site-wide footer. VitePress's own footer is one line and hides itself on
// sidebar pages, so this one is mounted through the layout-bottom slot on
// every page. On sidebar pages it steps right, out from under the fixed
// sidebar, by the same width VPContent does.
import { useSidebar } from "vitepress/theme";

const { hasSidebar } = useSidebar();

const columns = [
  {
    title: "Product",
    links: [
      { text: "Download", href: "/download" },
      { text: "Changelog", href: "/changelog" },
      { text: "Keyboard shortcuts", href: "/docs/shortcuts" },
      { text: "Prompt library", href: "/docs/prompts" },
    ],
  },
  {
    title: "Learn",
    links: [
      { text: "Getting started", href: "/docs/getting-started" },
      { text: "QACut Basic", href: "/use-cases/quick-shots" },
      { text: "QACut Bundles", href: "/use-cases/bundles" },
      { text: "QACut Studio", href: "/use-cases/studio" },
    ],
  },
  {
    title: "Community",
    links: [
      { text: "GitHub", href: "https://github.com/mcinnisdev/qacut" },
      { text: "Report a bug / Request a feature", href: "/feedback" },
      { text: "hello@qacut.com", href: "mailto:hello@qacut.com" },
    ],
  },
];

const external = (href: string) => /^https?:/.test(href);
</script>

<template>
  <footer class="qc-footer" :class="{ 'has-sidebar': hasSidebar }">
    <div class="qc-footer-inner">
      <div class="qc-footer-brand">
        <a href="/" class="qc-footer-logo" aria-label="QACut home">
          <img src="/logo.png" alt="" width="256" height="256" />
          <span><span class="qa">QA</span>Cut</span>
        </a>
        <p class="qc-footer-tag">Screen capture that hands off.</p>
        <p class="qc-footer-legal">Free and open source under the <a href="https://github.com/mcinnisdev/qacut/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a>. © 2026 Nick McInnis.<br /><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
      </div>
      <nav v-for="col in columns" :key="col.title" class="qc-footer-col" :aria-label="col.title">
        <h2>{{ col.title }}</h2>
        <ul>
          <li v-for="l in col.links" :key="l.href">
            <a :href="l.href" :target="external(l.href) ? '_blank' : undefined" :rel="external(l.href) ? 'noreferrer' : undefined">{{ l.text }}</a>
          </li>
        </ul>
      </nav>
    </div>
  </footer>
</template>

<style scoped>
.qc-footer {
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: var(--qc-fs-small);
  line-height: var(--qc-lh-body);
}
@media (min-width: 960px) {
  .qc-footer.has-sidebar {
    padding-left: var(--vp-sidebar-width);
  }
}
.qc-footer-inner {
  max-width: var(--qc-max);
  margin: 0 auto;
  padding: var(--qc-s-7) var(--qc-s-5);
  display: grid;
  grid-template-columns: 1.6fr repeat(3, 1fr);
  gap: var(--qc-s-6);
}
.qc-footer-brand {
  min-width: 0;
}
.qc-footer-logo {
  display: inline-flex;
  align-items: center;
  gap: var(--qc-s-1);
  font-size: var(--qc-fs-lead);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.qc-footer-logo img {
  height: var(--qc-s-6);
  width: auto;
}
.qc-footer-logo .qa {
  color: var(--vp-c-brand-1);
}
.qc-footer-tag {
  margin: var(--qc-s-3) 0 0;
  color: var(--vp-c-text-1);
  font-weight: 500;
}
.qc-footer-legal {
  margin: var(--qc-s-4) 0 0;
  color: var(--vp-c-text-3);
}
.qc-footer-col h2 {
  margin: 0 0 var(--qc-s-3);
  padding: 0;
  border: none;
  font-size: var(--qc-fs-eyebrow);
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-text-1);
}
.qc-footer-col ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--qc-s-2);
}
.qc-footer-col a {
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.12s ease;
}
.qc-footer-col a:hover {
  color: var(--vp-c-brand-1);
}
@media (max-width: 860px) {
  .qc-footer-inner {
    grid-template-columns: 1fr 1fr;
    padding: var(--qc-s-6) var(--qc-s-4);
  }
  .qc-footer-brand {
    grid-column: 1 / -1;
  }
}
@media (max-width: 520px) {
  .qc-footer-inner {
    grid-template-columns: 1fr;
  }
}
</style>
