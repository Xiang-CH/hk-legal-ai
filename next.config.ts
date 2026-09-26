import type { NextConfig } from "next";
import { APP_BASE_PATH, routes } from "./src/lib/routes";

const nextConfig: NextConfig = {
    // The app is proxied under a sub-path of a shared domain, so Next must
    // emit every URL (pages, next/link, _next assets, public/) under the mount
    // point. basePath is the supported mechanism for that; assetPrefix is not.
    basePath: APP_BASE_PATH,
    // Azure SWA hybrid Next.js caps the app at 250 MB: standalone keeps it small.
    output: "standalone",
    /* config options here */
    async redirects() {
        return [
            // Legacy `/chat` from when the app was mounted at the domain root.
            // basePath is applied to source and destination automatically.
            {
                source: "/chat",
                destination: routes.chat,
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

export default nextConfig;
