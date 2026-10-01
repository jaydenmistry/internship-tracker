import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: a self-contained server.js plus only the node_modules
  // files the traced import graph actually needs. The runtime image copies that
  // instead of a full production install, which is the difference between a
  // ~200MB app image and a ~1GB one. See docs/DEPLOYMENT.md.
  output: "standalone",

  // The Claude Agent SDK spawns a native Claude Code binary that ships in a
  // per-platform optional dependency. Bundling the SDK would break its
  // runtime lookup of that binary, and file tracing can't see a binary it
  // only finds at runtime — so keep the SDK external and trace the binary
  // package in explicitly for the routes that draft. UNVERIFIED in a real
  // image (none has been built): see the first-deploy checklist.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  outputFileTracingIncludes: {
    "/network/**": [
      "./node_modules/@anthropic-ai/claude-agent-sdk/**/*",
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*",
    ],
  },

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
