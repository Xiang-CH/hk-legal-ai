import { randomUUID } from "node:crypto";
import { ToolTimeoutError } from "@/lib/tools/shared";
import type { JudgmentSearchDebugEvent, JudgmentSearchDebugSink } from "@/lib/types";

export function searchErrorDetails(error: unknown) {
	const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
	const outer = fields(error);
	const cause = fields(error instanceof Error ? error.cause : outer.cause);
	const code: unknown = fields(outer.meta).code ?? outer.code ?? cause.code;
	const status: unknown = outer.statusCode ?? outer.status ?? cause.statusCode ?? cause.status;
	const name = error instanceof Error ? error.name : undefined;
	// Some tools convert exceptions to an error payload. Extract the fixed
	// timeout signature without streaming the message, which may include SQL.
	const timeout = typeof error === "string" ? /\[tool\] [a-z_ ]+ timed out after (\d+)ms/.exec(error) : null;
	return {
		reason: error instanceof ToolTimeoutError || timeout ? "timeout" : name === "AI_InvalidToolInputError" ? "invalid_input" : "error",
		errorType: name && /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(name) ? name : undefined,
		timeoutMs: error instanceof ToolTimeoutError ? error.timeoutMs : timeout ? Number(timeout[1]) : undefined,
		code: typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined,
		status: typeof status === "number" ? status : undefined,
	};
}

export function createJudgmentSearchDebug(path: string, onDebug?: JudgmentSearchDebugSink, toolCallId?: string) {
	const searchId = onDebug ? randomUUID() : undefined;
	const started = performance.now();
	const forQuery = (queryIndex?: number) => {
		const log = (event: string, details: JudgmentSearchDebugEvent["details"] = {}) => {
			if (!searchId) return;
			const entry = { searchId, event, elapsedMs: Math.round(performance.now() - started), details: { ...details, path, toolCallId: details.toolCallId ?? toolCallId, queryIndex } };
			console.log("[judgment-search]", entry);
			onDebug?.(entry);
		};
		const stage = async <T>(name: string, run: () => Promise<T>, summarize?: (value: T) => JudgmentSearchDebugEvent["details"]): Promise<T> => {
			if (!searchId) return run();
			const stageStarted = performance.now();
			log("stage_start", { stage: name });
			try {
				const value = await run();
				log("stage_end", { stage: name, durationMs: Math.round(performance.now() - stageStarted), ...summarize?.(value) });
				return value;
			} catch (error) {
				log("stage_error", { stage: name, durationMs: Math.round(performance.now() - stageStarted), ...searchErrorDetails(error) });
				throw error;
			}
		};
		return { log, stage };
	};
	return { ...forQuery(), forQuery };
}
