import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@youtube-clone/config',
    '@youtube-clone/types',
    '@youtube-clone/ui',
    '@youtube-clone/validation',
  ],
};

export default nextConfig;
