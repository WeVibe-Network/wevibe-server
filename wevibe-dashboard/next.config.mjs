/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    return config;
  },
};

export default config;
