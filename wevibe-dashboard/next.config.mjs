/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  env: {
    WEVIBE_HUB_URL: process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440',
    NEXT_PUBLIC_WEVIBE_HUB_URL: process.env.NEXT_PUBLIC_WEVIBE_HUB_URL ?? 'http://localhost:4440',
  },
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};

export default config;