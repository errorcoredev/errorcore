/** @type {import('next').NextConfig} */
module.exports = {
  experimental: {
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.devtool = 'source-map';
      // Externalize errorcore from the server bundle so every server-side
      // import path (instrumentation.ts + all app-route handlers) resolves
      // to the SAME Node-require'd module instance. Without this, webpack
      // creates per-entry bundled copies whose diagnostics_channel handlers
      // don't see the same subscription registry, and the ioTimeline stays
      // empty despite the SDK singleton appearing shared via Symbol.for.
      //
      // serverComponentsExternalPackages in Next.js 14.x applies only to
      // server components, not to app-route handlers, so we fall back to a
      // direct webpack externals entry.
      const prev = config.externals || [];
      config.externals = [
        {
          'errorcore': 'commonjs errorcore',
          'errorcore/nextjs': 'commonjs errorcore/nextjs',
        },
        ...(Array.isArray(prev) ? prev : [prev]),
      ];
    }
    return config;
  },
};
