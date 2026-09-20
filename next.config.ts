import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
