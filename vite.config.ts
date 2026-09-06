import preact from "@preact/preset-vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: {
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        embedded: resolve(import.meta.dirname, "embedded.html"),
        pwa: resolve(import.meta.dirname, "index.html"),
      },
    },
    sourcemap: false,
  },
  plugins: [
    preact(),
    VitePWA({
      injectRegister: null,
      includeAssets: ["icon.svg"],
      manifest: {
        background_color: "#063f2d",
        description: "完全本地、无账号、无广告的单机斗地主",
        display: "standalone",
        icons: [
          {
            purpose: "any maskable",
            sizes: "any",
            src: "icon.svg",
            type: "image/svg+xml",
          },
        ],
        id: "./",
        lang: "zh-CN",
        name: "单机斗地主",
        orientation: "landscape",
        scope: "./",
        short_name: "单机斗地主",
        start_url: "./",
        theme_color: "#063f2d",
      },
      registerType: "prompt",
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        globIgnores: ["embedded.html"],
        globPatterns: ["**/*.{css,html,js,svg,webmanifest}"],
        runtimeCaching: [],
        skipWaiting: false,
      },
    }),
  ],
});
