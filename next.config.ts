import type { NextConfig } from "next";

const appOrigin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;

const nextConfig: NextConfig = {
  // Allow development assets only from the configured app origin.
  allowedDevOrigins: appOrigin ? [new URL(appOrigin).hostname] : [],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        // Preserve Next's scoped class exports for component stylesheets.
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
