/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Printer adapters pull in native-ish deps that must stay outside the bundle.
    serverComponentsExternalPackages: ['mqtt', 'basic-ftp', 'ws'],
    serverActions: { bodySizeLimit: '4mb' },
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
