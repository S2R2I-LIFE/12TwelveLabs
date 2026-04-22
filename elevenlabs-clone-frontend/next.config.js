/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  // Allow cross-origin requests from external hosts (e.g. Cloudflare tunnel) to /_next/* assets.
  // Set ALLOWED_DEV_ORIGINS=clone.s2r2i.com in .env (hostname only, no protocol)
  // Must be undefined (not []) when unset — [] triggers block mode in Next.js
  ...(process.env.ALLOWED_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(",").map((h) => h.trim()) }
    : {}),
  async redirects() {
    return [
      {
        source: "/",
        destination: "/app/sign-in",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/jupyter/:path*",
        destination: `${process.env.JUPYTERLAB_URL}/jupyter/:path*`,
      },
    ];
  },
};

export default config;
