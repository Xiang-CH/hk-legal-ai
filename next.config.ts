import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
