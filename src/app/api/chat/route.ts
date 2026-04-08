import { PrismaClient } from "@/prisma/client";

import { LegislationSection, MyUIMessage, JudgmentSummary } from "@/lib/types";
import { azure } from "./helper";
import { rewriteQuery, convertClicResultsToXml, convertLegislationResultsToXml, convertJudgmentResultsToXml } from "./helper";
import { searchPrompt, sourcePrompt } from "@/lib/prompts";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	streamText,
	convertToModelMessages,
} from "ai";
import {
	SearchClient,
	AzureKeyCredential,
} from "@azure/search-documents";
import { searchClic, searchJudgmentSummary } from "./helper";
import { type ClicPage } from "@/lib/types";
import {
	observe,
	updateActiveObservation,
	updateActiveTrace,
	startActiveObservation,
} from "@langfuse/tracing";
import { langfuseSpanProcessor } from "@/instrumentation";

if (!process.env.AZURE_SEARCH_ENDPOINT) {
	throw new Error("AZURE_SEARCH_ENDPOINT is not defined");
}

if (!process.env.CLIC_INDEX_NAME) {
	throw new Error("CLIC_INDEX_NAME is not defined");
}

if (!process.env.JUDGMENT_SUMMARY_INDEX_NAME) {
	throw new Error("JUDGMENT_SUMMARY_INDEX_NAME is not defined");
}

if (!process.env.AZURE_SEARCH_KEY) {
	throw new Error("AZURE_SEARCH_KEY is not defined");
}

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL,
		},
	},
});

/**
 * Note: Prisma middlewares ($use) are not available in the current client types.
 * We handle timeouts per-query instead of using prisma.$use middleware.
 */

const searchClicClient = new SearchClient(
	process.env.AZURE_SEARCH_ENDPOINT,
	process.env.CLIC_INDEX_NAME,
	new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);

const searchJudgmentSummaryClient = new SearchClient(
	process.env.AZURE_SEARCH_ENDPOINT,
	process.env.JUDGMENT_SUMMARY_INDEX_NAME,
	new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);

export type searchClicClientType = typeof searchClicClient
export type searchJudgmentSummaryClientType = typeof searchJudgmentSummaryClient

const handler = async (req: Request) => {
	let { messages, searchDepth } = await req.json();

	if (!searchDepth){
		searchDepth = 2;
	}
	// console.log("searchDepth: ", searchDepth);

	// Set session id and user id on active trace
	const modelMessages = convertToModelMessages(messages);
	const inputText = modelMessages[modelMessages.length - 1].content;

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
			const legislationResults: LegislationSection[] = [];
			const judgmentResults: JudgmentSummary[] = [];

			// Semantic Search (CLIC + Judgment Summary)
			await startActiveObservation("semantic-search", async (span) => {
				span.update({
					input: { queries: searchQueries },
				});

				await Promise.all([
					...searchQueries.map(async (searchQuery) => {
						await startActiveObservation("search-clic", async (clicSpan) => {
							clicSpan.update({ input: searchQuery });
							for await (const result of searchClic(searchQuery, searchClicClient)) {
								if (clicResults.find((r) => r.nid === result.nid && r.chunk_no === result.chunk_no)) continue;
								clicResults.push(result);
								// 3. Send message source
								writer.write({
									type: "source-url",
									sourceId: `clic-${result.nid}-${result.chunk_no}`,
									url: result.url,
									title: result.title,
									providerMetadata: {
										custom: {
											score: result.score || null,
											rerankerScore: result.rerankerScore || null,
											caption: result.caption,
											captionHighlights: result.captionHighlights,
										},
									},
								});
							}
							clicSpan.update({ output: { resultsCount: clicResults.length } });
						});
					}),
					...searchQueries.map(async (searchQuery) => {
						await startActiveObservation("search-judgment-summary", async (judgmentSpan) => {
							judgmentSpan.update({ input: searchQuery });
							for await (const result of searchJudgmentSummary(searchQuery, searchJudgmentSummaryClient)) {
								if (judgmentResults.find((r) => r.judgmentId === result.judgmentId && r.chunk_no === result.chunk_no)) continue;
								judgmentResults.push(result);
								writer.write({
									type: "source-url",
									sourceId: `judgment-${result.judgmentId}-${result.chunk_no}`,
									url: process.env.HKLII_BASEURL + result.url,
									title: result.neutralCitation,
									providerMetadata: {
										custom: {
											score: result.score || null,
											rerankerScore: result.rerankerScore || null,
											caption: result.caption,
											captionHighlights: result.captionHighlights,
											courtName: result.courtName,
											year: result.year,
											parties: result.parties,
										},
									},
								});
							}
							judgmentSpan.update({ output: { resultsCount: judgmentResults.length } });
						});
					}),
				]);

				span.update({
					output: {
						clicResultsCount: clicResults.length,
						judgmentResultsCount: judgmentResults.length,
					},
				});
			});

			let uniqueLegislationResults: LegislationSection[] = [];
			// SQL Search - with error handling
			if (searchDepth > 1) {
				const clicNidsToSearch = clicResults.map((r) => r.nid);
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
								caption: legislation.sectionHeading
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

			try {
				const result = streamText({
					model: azure(process.env.LLM_MODEL || "gpt-5.4-mini"),
					system: searchPrompt,
					messages: modelMessages,
					experimental_telemetry: { isEnabled: true },
					providerOptions: {
						openai: {
							reasoningEffort: 'medium',
							reasoningSummary: 'auto',
						},
					},
					onFinish({usage, text, reasoning}) {
						// Update trace with final output after stream completes
						updateActiveObservation({
							output: text,
						});

						updateActiveTrace({
							output: text,
						});

						console.log("Usage: ", usage);
						console.log("Reasoning Text: ", reasoning);

						writer.write({
							type: "message-metadata",
							messageMetadata: {
								searchQuery: searchQueries.join("\n"),
								searchQueries: searchQueries,
								usage: usage,
							},
						});

						// 5. Send completion notification (transient)
						writer.write({
							type: "data-data",
							data: { type: "notification", message: "Request completed", level: "info" },
							transient: true, // Won't be added to message history
						});
					},
					onError: async (error) => {
						updateActiveObservation({
							output: error,
							level: "ERROR"
						});

						updateActiveTrace({
							output: error,
						});
					},
				});

				writer.merge(result.toUIMessageStream({
					sendReasoning: true,
				}));

			} finally {
				// Critical for serverless: flush traces before function terminates
				await langfuseSpanProcessor.forceFlush();
			}
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
