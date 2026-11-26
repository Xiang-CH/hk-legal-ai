import { DefaultChatTransport } from "ai";
import { routes } from "@/lib/routes";
import type { MyUIMessage } from "@/lib/types";

export function createChatTransport(isDebugEnabled: () => boolean) {
	return new DefaultChatTransport<MyUIMessage>({
		api: routes.apiChat,
		// Automatic SDK follow-ups can replay the previous request body.
		prepareSendMessagesRequest: ({ body, id, messages, trigger, messageId }) => ({
			body: { ...body, id, messages, trigger, messageId, debugJudgmentSearch: isDebugEnabled() },
		}),
	});
}
