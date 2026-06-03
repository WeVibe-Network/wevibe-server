/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    return config;
  },
};

export default config;
