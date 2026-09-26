import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { APP_BASE_PATH, routes } from "./src/lib/routes";

export default (phase: string): NextConfig => {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;

    const nextConfig: NextConfig = {
        // Azure SWA hybrid rejects Next's `basePath` at deploy time, so the app
        // stays physically mounted at /clic-chat-hkulaw. assetPrefix only
        // rewrites the `_next/static` URLs Next emits (JS/CSS/fonts) to the
        // mount point; the edge proxy is expected to strip that prefix for
        // `/_next` before forwarding to SWA. Undefined in dev so `next dev`
        // serves assets from the root as usual.
        assetPrefix: isDev ? undefined : APP_BASE_PATH,
        // Azure SWA hybrid Next.js caps the app at 250 MB: standalone keeps it small.
        output: "standalone",
        /* config options here */
        async redirects() {
            return [
                {
                    source: "/chat",
                    destination: routes.chat,
                    permanent: true,
                },
                {
                    source: "/api/:path*",
                    destination: `${routes.home}/api/:path*`,
                    permanent: true,
                },
            ];
        },
        async rewrites() {
            return [
                {
                    source: "/_internal/studio",
                    destination: "/_internal/pages/http/databrowser.html",
                },
                {
                    source: "/_internal/studio/(.*)",
                    destination: "/_internal/$1",
                },
            ];
        },
    };

    return nextConfig;
};
