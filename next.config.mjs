/** @type {import("next").NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // The connector reads its own files at runtime (host.js, sql/schema.sql), so it isn't bundled.
  serverExternalPackages: ["@media-dashboard/brand-connector", "pg"],
  outputFileTracingIncludes: {
    "/**": ["./connector/dist/**/*.js", "./connector/sql/**", "./connector/package.json"],
  },
};

export default nextConfig;
