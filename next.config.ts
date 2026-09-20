import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: a self-contained server.js plus only the node_modules
  // files the traced import graph actually needs. The runtime image copies that
  // instead of a full production install, which is the difference between a
  // ~200MB app image and a ~1GB one. See docs/DEPLOYMENT.md.
  output: "standalone",

  experimental: {
    serverActions: {
      // Resume uploads go through a Server Action, whose request body defaults
      // to a 1MB cap — smaller than the 10MB the upload itself allows, so a
      // legitimate PDF would be rejected by the framework before the action
      // could explain why. 11MB leaves room for multipart overhead on top of
      // the 10MB limit enforced in lib/resume/extract.ts.
      bodySizeLimit: "11mb",
    },
  },
};

export default nextConfig;
