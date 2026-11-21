import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // workerd-only module; outside workerd it is the Hera stub.
      "cloudflare:workers": fileURLToPath(
        new URL("./src/testing/workers-stub/cloudflare-workers.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false
  }
});
