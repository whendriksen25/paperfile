/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Local /public assets always work; only remote needs allowlisting.
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.dropboxusercontent.com" },
      { protocol: "https", hostname: "dl.dropboxusercontent.com" },
    ],
    unoptimized: true, // skip the image optimizer so transparent PNG passes through unchanged
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
