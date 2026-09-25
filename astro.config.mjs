// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  site: 'https://gpojani.me',
  trailingSlash: 'always',
  integrations: [mdx(), sitemap()],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  markdown: {
    // `$$…$$` for math (inline or block). Single `$` stays a dollar sign,
    // so prices in prose never turn into equations.
    processor: unified({
      remarkPlugins: [[remarkMath, { singleDollarTextMath: false }]],
      rehypePlugins: [rehypeKatex],
    }),
    shikiConfig: { theme: 'vesper', wrap: false },
  },
});
