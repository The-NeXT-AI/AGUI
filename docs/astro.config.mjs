import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: {
        en: "AGUI Docs",
        "zh-CN": "AGUI 文档",
      },
      description: "Bilingual documentation for AGUI Desktop, an ASP-native coding agent client.",
      lastUpdated: true,
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        "zh-cn": {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      customCss: ["./src/styles/mintlify.css"],
      components: {
        Header: "./src/components/Header.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        {
          tag: "script",
          attrs: {
            src: "/mintlify-docs.js?v=1",
            defer: true,
          },
        },
      ],
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      sidebar: [
        {
          label: "Get started",
          translations: { "zh-CN": "开始" },
          items: [
            {
              slug: "index",
              label: "Overview",
              translations: { "zh-CN": "总览" },
            },
            "getting-started/installation",
            "getting-started/architecture",
          ],
        },
        {
          label: "Guides",
          translations: { "zh-CN": "指南" },
          items: [
            "guides/providers",
            "guides/extensions",
            "guides/extensions-advanced",
            "guides/customization",
            "guides/multi-agent",
            {
              slug: "guides/browser-automation",
              label: "Browser automation",
              translations: { "zh-CN": "浏览器自动化" },
            },
          ],
        },
        {
          label: "ASP Protocol",
          translations: { "zh-CN": "ASP 协议" },
          items: [
            {
              slug: "asp",
              label: "Overview",
              translations: { "zh-CN": "概览" },
            },
            {
              slug: "asp/core-protocol",
              label: "Core protocol",
              translations: { "zh-CN": "核心协议" },
            },
            {
              slug: "asp/extensions",
              label: "Extensions",
              translations: { "zh-CN": "扩展协议" },
            },
          ],
        },
        {
          label: "Reference",
          translations: { "zh-CN": "参考" },
          items: ["reference/configuration"],
        },
      ],
    }),
  ],
});
