import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Cargo writes into src-tauri/target while Vite is running; watching it
    // trips EBUSY on Windows and floods the watcher everywhere else.
    watch: { ignored: ["**/src-tauri/**"] },
    // Dev only: lets a harness page load recordings from the QACut folder.
    fs: { allow: [".", `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/QACut`] },
  },
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        capture: resolve(__dirname, "capture.html"),
        note: resolve(__dirname, "note.html"),
        peek: resolve(__dirname, "peek.html"),
        rec: resolve(__dirname, "rec.html"),
        edit: resolve(__dirname, "edit.html"),
        studio: resolve(__dirname, "studio.html"),
        prompts: resolve(__dirname, "prompts.html"),
        brands: resolve(__dirname, "brands.html"),
      },
    },
  },
});
