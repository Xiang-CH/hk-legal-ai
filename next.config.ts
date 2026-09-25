import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    // Azure SWA hybrid Next.js caps the app at 250 MB: standalone keeps it small.
    output: "standalone",
    /* config options here */
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
