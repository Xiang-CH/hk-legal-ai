import { Chat } from "@/components/chat";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Chat
      defaultAgenticSearchEnabled={process.env.AGENTIC_SEARCH_ENABLED === "true"}
    />
  );
}
