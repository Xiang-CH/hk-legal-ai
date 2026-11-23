import { randomUUID } from "node:crypto";
import { ToolTimeoutError } from "@/lib/tools/shared";
import type { JudgmentSearchDebugEvent, JudgmentSearchDebugSink } from "@/lib/types";

export function searchErrorDetails(error: unknown) {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
	return {
		reason: error instanceof ToolTimeoutError ? "timeout" : "error",
		timeoutMs: error instanceof ToolTimeoutError ? error.timeoutMs : undefined,
		code: typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined,
		status: typeof status === "number" ? status : undefined,
	};
}

export function createJudgmentSearchDebug(path: string, onDebug?: JudgmentSearchDebugSink) {
	const searchId = onDebug ? randomUUID() : undefined;
	const started = performance.now();
	const log = (event: string, details: JudgmentSearchDebugEvent["details"] = {}) => {
		if (!searchId) return;
		const entry = { searchId, event, elapsedMs: Math.round(performance.now() - started), details: { ...details, path } };
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
}
