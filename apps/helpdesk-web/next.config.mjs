/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export", // static export for Bunny origin
  trailingSlash: true,
  images: { unoptimized: true },
};
export default nextConfig;
