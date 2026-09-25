import type { NextConfig } from "next";
import { routes } from "./src/lib/routes";

const nextConfig: NextConfig = {
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

export default nextConfig;
