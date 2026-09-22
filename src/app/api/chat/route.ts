import { prisma } from "@/lib/prisma";

import type { LegislationSection, MyUIMessage, JudgmentSummary } from "@/lib/types";
import { chatAgent } from "@/lib/chat-agent";
import { rewriteQuery, getEmbeddings, convertClicResultsToXml, convertLegislationResultsToXml, convertJudgmentResultsToXml } from "./helper";
import { sourcePrompt } from "@/lib/prompts";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	convertToModelMessages,
	toUIMessageStream,
} from "ai";
import { searchClic, searchJudgmentSummary, RERANK_TOP_CLIC, RERANK_TOP_JUDGMENT } from "./helper";
import { applyRerank, createRerankUsage } from "@/lib/rerank";
import { type ClicPage } from "@/lib/types";
import {
	observe,
	updateActiveObservation,
	updateActiveTrace,
	startActiveObservation,
} from "@langfuse/tracing";
import { langfuseSpanProcessor } from "@/instrumentation";

/* T10: single-pg backend — pg fusion (helper.ts) + app-side Cohere rerank. */

/* T09: candidates per corpus entering the single global rerank call (cost + 429 bound). */
const RERANK_CANDIDATE_CAP = 30;

/**
 * Note: Prisma middlewares ($use) are not available in the current client types.
 * We handle timeouts per-query instead of using prisma.$use middleware.
 */

const handler = async (req: Request) => {
	let { messages, searchDepth } = (await req.json()) as {
		messages: MyUIMessage[];
		searchDepth?: number;
	};

	if (!searchDepth){
		searchDepth = 2;
	}
	// console.log("searchDepth: ", searchDepth);

	// Set session id and user id on active trace
	const modelMessages = await convertToModelMessages(messages);
	const inputText = modelMessages[modelMessages.length - 1].content;
	// T09: the single global rerank per corpus scores against the ORIGINAL user
	// question, not the rewritten queries (which served retrieval breadth).
	const rerankQuery = typeof inputText === "string"
		? inputText
		: inputText.filter((part) => part.type === "text").map((part) => part.text).join(" ");

	// Add input and trace metadata
	updateActiveObservation({
		input: inputText,
	});

	updateActiveTrace({
		name: "chat-message",
		input: inputText,
	});

	const searchQueries = await startActiveObservation("rewrite-query", async (span) => {
		span.update({ input: inputText });
		const queries = (await rewriteQuery(modelMessages)).splice(0, 3); // Limit to top 3 queries
		span.update({ output: queries });
		return queries;
	});
	// console.log("searchQueries: ", searchQueries);

	const stream = createUIMessageStream<MyUIMessage>({
		execute: async ({ writer }) => {
			// 1. Send initial status (transient - won't be added to message history)
			writer.write({
				type: "data-data",
				data: { type: "notification", message: "Processing your request...", level: "info" },
				transient: true, // This part won't be added to message history
			});

			// 2. Send message metadata
			writer.write({
				type: "message-metadata",
				messageMetadata: {
					searchQuery: searchQueries.join("\n"),
					searchQueries: searchQueries,
				},
			});

			const clicResults: ClicPage[] = [];
			// T09: merged fusion candidates (pre-rerank) — feeds legislation nid lookup
			// so graph recall isn't narrowed to the reranked top-10.
			const clicCandidates: ClicPage[] = [];
			// T09: request-scoped rerank accounting -> cost summary (onFinish).
			const rerankUsage = createRerankUsage();
			const legislationResults: LegislationSection[] = [];
			const judgmentResults: JudgmentSummary[] = [];

			// Semantic Search (CLIC + Judgment Summary)
			// Order: per-query fusion (lex+vec RRF top-30) -> cross-query merge/dedupe
			// (best rrf wins) -> SINGLE rerank per corpus vs the original question ->
			// global top-10 / top-8. Rerank must sit AFTER the merge: per-query rerank
			// scores aren't comparable across queries and the merge was arrival-ordered,
			// plus it fired up to 6 rerank calls/turn (the 429s). Now: 2 calls.
			await startActiveObservation("semantic-search", async (span) => {
				span.update({
					input: { queries: searchQueries },
				});

				// T08: embed once per rewritten query, share across clic/judgment (/legislation in T10).
				const queryEmbeddings = await Promise.all(searchQueries.map((q) => getEmbeddings(q)));

				const judgmentCandidates: JudgmentSummary[] = [];
				await Promise.all([
					...searchQueries.map(async (searchQuery, qi) => {
						await startActiveObservation("search-clic", async (clicSpan) => {
							clicSpan.update({ input: searchQuery });
							let count = 0;
							for await (const result of searchClic(searchQuery, { embedding: queryEmbeddings[qi] })) {
								const existing = clicCandidates.find((r) => r.nid === result.nid && r.chunk_no === result.chunk_no);
								if (!existing) clicCandidates.push(result);
								else if ((result.rrf_score ?? 0) > (existing.rrf_score ?? 0)) Object.assign(existing, result);
								count++;
							}
							clicSpan.update({ output: { fusionCount: count } });
						});
					}),
					...searchQueries.map(async (searchQuery, qi) => {
						await startActiveObservation("search-judgment-summary", async (judgmentSpan) => {
							judgmentSpan.update({ input: searchQuery });
							let count = 0;
							for await (const result of searchJudgmentSummary(searchQuery, { embedding: queryEmbeddings[qi] })) {
								const existing = judgmentCandidates.find((r) => r.judgmentId === result.judgmentId && r.chunk_no === result.chunk_no);
								if (!existing) judgmentCandidates.push(result);
								else if ((result.rrf_score ?? 0) > (existing.rrf_score ?? 0)) Object.assign(existing, result);
								count++;
							}
							judgmentSpan.update({ output: { fusionCount: count } });
						});
					}),
				]);

				// Global RRF order, cap rerank input, then ONE rerank per corpus.
				const topByRrf = <T extends { rrf_score?: number | null }>(rows: T[]) =>
					[...rows].sort((a, b) => (b.rrf_score ?? 0) - (a.rrf_score ?? 0)).slice(0, RERANK_CANDIDATE_CAP);

				const [rerankedClic, rerankedJudgment] = await Promise.all([
					startActiveObservation("rerank-clic", async (rspan) => {
						const out = await applyRerank(rerankQuery, topByRrf(clicCandidates), {
							getText: (h) => h.content,
							topN: RERANK_TOP_CLIC,
							usage: rerankUsage,
						});
						rspan.update({ input: rerankQuery, output: { candidates: Math.min(clicCandidates.length, RERANK_CANDIDATE_CAP), final: out.length } });
						return out;
					}),
					startActiveObservation("rerank-judgment", async (rspan) => {
						const out = await applyRerank(rerankQuery, topByRrf(judgmentCandidates), {
							getText: (h) => h.summary,
							topN: RERANK_TOP_JUDGMENT,
							usage: rerankUsage,
						});
						rspan.update({ input: rerankQuery, output: { candidates: Math.min(judgmentCandidates.length, RERANK_CANDIDATE_CAP), final: out.length } });
						return out;
					}),
				]);

				// 3. Send message sources (deterministic order: clic, then judgment)
				for (const { item: result, rerank_score } of rerankedClic) {
					clicResults.push({ ...result, rerankerScore: rerank_score ?? undefined, rerank_score });
					writer.write({
						type: "source-url",
						sourceId: `clic-${result.nid}-${result.chunk_no}`,
						url: result.url,
						title: result.title,
						providerMetadata: {
							custom: {
								score: result.score || null,
								caption: result.caption ?? "",
								// T11 pg contract (additive mirrors; score~=rrf, caption~=snippet)
								rrf_score: result.rrf_score ?? result.score ?? null,
								rerank_score: rerank_score ?? null,
								snippet: result.snippet ?? result.caption ?? "",
							},
						},
					});
				}
				for (const { item: result, rerank_score } of rerankedJudgment) {
					judgmentResults.push({ ...result, rerankerScore: rerank_score ?? undefined, rerank_score });
					writer.write({
						type: "source-url",
						sourceId: `judgment-${result.judgmentId}-${result.chunk_no}`,
						url: process.env.HKLII_BASEURL + result.url,
						title: result.neutralCitation,
						providerMetadata: {
							custom: {
								score: result.score || null,
								caption: result.caption ?? "",
								// T11 pg contract (additive mirrors; score~=rrf, caption~=snippet)
								rrf_score: result.rrf_score ?? result.score ?? null,
								rerank_score: rerank_score ?? null,
								snippet: result.snippet ?? result.caption ?? "",
								courtName: result.courtName,
								year: result.year,
								parties: result.parties,
							},
						},
					});
				}

				span.update({
					output: {
						clicCandidates: clicCandidates.length,
						clicResultsCount: clicResults.length,
						judgmentCandidates: judgmentCandidates.length,
						judgmentResultsCount: judgmentResults.length,
					},
				});
			});
			let uniqueLegislationResults: LegislationSection[] = [];
			// SQL Search - with error handling
			if (searchDepth > 1) {
				const clicNidsToSearch = [...new Set(clicCandidates.map((r) => r.nid))];
				// console.log("Clic NIDs to search: ", clicNidsToSearch);
				
				if (clicNidsToSearch.length > 0) {
					await startActiveObservation("search-legislation-sql", async (sqlSpan) => {
						sqlSpan.update({
							input: { clicNids: clicNidsToSearch, searchDepth },
						});

						try {
							const startTime = Date.now();
						// Per-query timeout (10s) instead of global middleware
						const queryPromise = prisma.clicPage.findMany({
							where: {
								nid: {
									in: clicNidsToSearch,
								},
							},
							include: {
								referencingLegislationSections: {
									select: {
										capNumber: true,
										sectionNumber: true,
										subsectionNumber: true,
										sectionHeading: true,
										content: true,
										url: true,
										parentLegislationCap: {
											select: {
												title: true,
											},
										},
										referencingLegislationSections: searchDepth > 2? {
											select: {
												capNumber: true,
												sectionNumber: true,
												subsectionNumber: true,
												sectionHeading: true,
												content: true,
												url: true,
												parentLegislationCap: {
													select: {
														title: true,
													},
												},
												referencingLegislationSections: searchDepth > 3? {
													select: {
														capNumber: true,
														sectionNumber: true,
														subsectionNumber: true,
														sectionHeading: true,
														content: true,
														url: true,
														parentLegislationCap: {
															select: {
																title: true,
															},
														},
													},
												}: false
											},
										} : false,
									},
								}
							}
						});

						const sqlSearchResults = await Promise.race([
							queryPromise,
							new Promise<never>((_, reject) =>
								setTimeout(() => reject(new Error('Database query timeout')), 10000)
							),
						]);

						// console.log("SQL Search Results: ", sqlSearchResults);
					

						const queryTime = Date.now() - startTime;
						// console.log(`SQL Result`, sqlSearchResults);
						writer.write({
							type: "data-data",
							data: { type: "notification", message: `SQL search completed in ${queryTime}ms.`, level: "info" },
							transient: true,
						});

						legislationResults.push(...sqlSearchResults.flatMap((result) => {
							return result.referencingLegislationSections.map((section) => ({
								capNumber: section.capNumber,
								sectionNumber: section.sectionNumber,
								subsectionNumber: section.subsectionNumber || undefined,
								capTitle: section.parentLegislationCap?.title || "",
								sectionHeading: section.sectionHeading || "",
								content: section.content,
								url: section.url,
							}));
						}));

						// console.log("Legislation Results length: ", legislationResults.length);

						sqlSpan.update({
							output: {
								resultsCount: legislationResults.length,
								queryTimeMs: queryTime,
							},
						});

						} catch (error) {
							console.error("Error fetching SQL search results:", error);
							sqlSpan.update({
								output: error,
								level: "ERROR",
							});
							// Send error notification but continue with stream
							writer.write({
								type: "data-data",
								data: { type: "notification", message: "Warning: Could not fetch related legislation", level: "warning" },
								transient: true,
							});
						}
					});
				}


				// Filter out duplicate legislation results
				uniqueLegislationResults = legislationResults.filter((legislation, index, self) => {
					const key = legislation.url;
					return index === self.findIndex((l) =>
						l.url === key
					);
				});
				// console.log("Unique Legislation Results: ", uniqueLegislationResults);
			

				// 4. Send Legislation results
				for (const legislation of uniqueLegislationResults) {
					writer.write({
						type: "source-url",
						sourceId: `cap-${legislation.capNumber}-${legislation.sectionNumber}-${legislation.subsectionNumber || "none"}`,
						url: legislation.url,
						title: `Cap ${legislation.capNumber}, ${legislation.sectionNumber}: ${legislation.capTitle}`,
						providerMetadata: {
							custom: {
								capTitle: legislation.capTitle,
								sectionHeading: legislation.sectionHeading,
								score: legislation.score || null,
								rerankerScore: legislation.rerankerScore || null,
								caption: legislation.sectionHeading,
								// T11 pg contract (additive): SQL graph path has no
								// fusion scores, so snippet mirrors the heading until T12.
								snippet: legislation.snippet ?? legislation.sectionHeading,
								rerank_score: legislation.rerank_score ?? legislation.rerankerScore ?? null,
							},
						},
					});
				}
			}

			// const systemPrompt = searchPrompt.replace("{{clicPages}}", convertClicResultsToXml(clicResults)).replace("{{legislationSections}}", convertLegislationResultsToXml(uniqueLegislationResults));
			// console.log("systemPrompt: ", systemPrompt);
			// console.log("Judgment Results: ", judgmentResults);

			// Final prompt to model
			modelMessages.push({
				role: "system",
				content: sourcePrompt
					.replace("{{clicPages}}", convertClicResultsToXml(clicResults))
					.replace("{{legislationSections}}", convertLegislationResultsToXml(uniqueLegislationResults))
					.replace("{{judgmentSummaries}}", convertJudgmentResultsToXml(judgmentResults)),
			});
			// console.log("modelMessages: ", modelMessages);

			const result = await chatAgent.stream({
				prompt: modelMessages,
				onEnd({ usage, text, reasoningText }) {
						// Update trace with final output after stream completes
						updateActiveObservation({
							output: text,
						});

						updateActiveTrace({
							output: text,
						});

						// T09: rerank cost is per API call (Cohere bills searches, not docs).
						// Set RERANK_COST_PER_CALL from the Foundry portal pricing; default 0.
						const rerankCost = rerankUsage.calls * Number(process.env.RERANK_COST_PER_CALL || 0);
						const fullUsage = {
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
							totalTokens: usage.totalTokens,
							reasoningTokens: usage.outputTokenDetails.reasoningTokens,
							cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
							rerankCalls: rerankUsage.calls,
							rerankDocuments: rerankUsage.documents,
							rerankCost,
						};
						console.log("Usage: ", fullUsage);
						console.log("Rerank usage: ", rerankUsage);
						console.log("Reasoning Text: ", reasoningText);

						writer.write({
							type: "message-metadata",
							messageMetadata: {
								searchQuery: searchQueries.join("\n"),
								searchQueries: searchQueries,
								usage: fullUsage,
							},
						});

						// 5. Send completion notification (transient)
						writer.write({
							type: "data-data",
							data: { type: "notification", message: "Request completed", level: "info" },
							transient: true, // Won't be added to message history
						});
					},
				});

			writer.merge(toUIMessageStream({
				stream: result.stream,
				sendReasoning: true,
				onError: (error) => {
						updateActiveObservation({
							output: error,
							level: "ERROR"
						});

						updateActiveTrace({
							output: error,
						});

						return "An error occurred.";
					},
				}));
		},
		onEnd: async () => {
			// Critical for serverless: flush traces after the response stream closes.
			await langfuseSpanProcessor.forceFlush();
		},
	});

	return createUIMessageStreamResponse({ stream });
};

// Wrap handler with observe() to create a Langfuse trace
export const POST = observe(handler, {
	name: "handle-chat-message",
	captureInput: true,
    captureOutput: true,
	endOnExit: false, // Don't end observation until stream finishes
});
