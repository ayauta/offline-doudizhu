import preact from "@preact/preset-vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: {
    target: "chrome74",
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        embedded: resolve(import.meta.dirname, "embedded.html"),
        pwa: resolve(import.meta.dirname, "index.html"),
      },
    },
    sourcemap: false,
  },
  server: {
    // Bind and print the address explicitly. `localhost` resolves to both ::1
    // and 127.0.0.1, and this server only listens on IPv4, so a browser that
    // tries ::1 first waits out the failed attempt before falling back —
    // measured at ~210 ms per new connection from a Windows browser against
    // WSL. The default banner prints `localhost`, which sends developers at
    // the slow address.
    host: "127.0.0.1",
    // Development serves native ESM, so the first page load transforms ~48
    // modules one request at a time. Transforming them as the server starts
    // moves that cost off the critical path; measured cold first load from a
    // Windows browser dropped from ~3.4 s to the warm figure.
    //
    // The entries must be modules, not HTML: warming a `.html` file only runs
    // `transformIndexHtml` and never reaches its script graph.
    warmup: {
      clientFiles: ["./src/delivery/pwa.ts", "./src/delivery/embedded.ts"],
    },
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
