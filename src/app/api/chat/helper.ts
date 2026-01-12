import { azure } from "@ai-sdk/azure";
import { queryExtendPrompt } from "@/lib/prompts";
import { generateObject, ModelMessage } from "ai"
import { z } from 'zod';
import { searchClicClientType, searchJudgmentSummaryClientType } from "./route";
import { ClicPage, LegislationSection, JudgmentSummary } from "@/lib/types";

export async function rewriteQuery(messages: ModelMessage[]) {
    const QueryExpandFormatSchema = z.object({
        queries: z
            .array(z.string())
            .default([])
            .describe('A list of search queries'),
    });

    const conversation = messages.map((message) => {
        if (typeof message.content === "string") {
            return `${message.role}: ${message.content}`;
        } else {
            return `${message.role}: ${message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ")}`;
        }
    }).join("\n");

    const result = await generateObject({
        model: azure("gpt-4.1-mini"),
        system: queryExtendPrompt,
        prompt: `The conversation history is as follows:\n${conversation}`,
        schema: QueryExpandFormatSchema,
    })
    return result.object.queries;
}


export async function* searchClic(query: string, searchClicClient: searchClicClientType) {
    const searchResults = await searchClicClient.search(
        query,
        {
            top: 10,
            queryType: "semantic",
            searchMode: "all",
            select: ["nid", "title", "content", "url", "topic", "chunk_no"],
            semanticSearchOptions: {
                configurationName: "clic-semantic-config",
                captions: {
                    captionType: "extractive"
                },
            },
            
            vectorSearchOptions: {
                queries: [
                    {
                        kind: "text",
                        text: query,
                        fields: ["embedding"],
                    }
                ],
            },
        }
    );

    // const queryResults = [];
    for await (const result of searchResults.results) {
        const document = result.document as {
            nid: number;
            title: string;
            content: string;
            url: string;
            topic: string;
            chunk_no: number;
        };
        yield {
            ...document,
            score: result.score,
            rerankerScore: result.rerankerScore,
            caption: result.captions?.[0]?.text || "",
            captionHighlights: result.captions?.[0]?.highlights || ""
        }
    }
} 


export function convertClicResultsToXml(clicResults: ClicPage[]) {
    return "<clicPages>\n" + clicResults.map((r) => {
        return `    <page>
        <url>${r.url}</url>
        <topic>${r.topic}</topic>
        <title>${r.title}</title>
        <content>${r.content}</content>
    </page>`;
    }).join("\n") + "\n</clicPages>";
}

export function convertLegislationResultsToXml(legislationResults: LegislationSection[]) {
    return "<legislationSections>\n" + legislationResults.map((r) => {
        return `    <section>
        <url>${r.url}</url>
        <capNumber>${r.capNumber}</capNumber>
        <capTitle>${r.capTitle}</capTitle>
        <sectionNumber>${r.sectionNumber}</sectionNumber>
        <sectionHeading>${r.sectionHeading}</sectionHeading>
        <content>${r.content}</content>
    </section>`;
    }).join("\n") + "\n</legislationSections>";
}


export async function* searchJudgmentSummary(query: string, searchClient: searchJudgmentSummaryClientType) {
    const searchResults = await searchClient.search(
        query,
        {
            top: 8,
            queryType: "full",
            searchMode: "all",
            select: ["judgmentId", "chunk_no", "neutralCitation", "courtName", "year", "date", "parties", "summary", "summarySource", "url"],
            // semanticSearchOptions: {
            //     configurationName: "judgment-summary-semantic-config",
            //     captions: {
            //         captionType: "extractive"
            //     },
            // },
            vectorSearchOptions: {
                queries: [
                    {
                        kind: "text",
                        text: query,
                        fields: ["embedding"],
                    }
                ],
            },
        }
    );

    for await (const result of searchResults.results) {
        const document = result.document as {
            judgmentId: number;
            chunk_no: number;
            neutralCitation: string;
            courtName: string;
            year: number;
            date: string;
            parties: string | null;
            summary: string;
            summarySource: string | null;
            url: string;
        };
        yield {
            ...document,
            score: result.score,
            rerankerScore: result.rerankerScore,
            caption: result.captions?.[0]?.text || "",
            captionHighlights: result.captions?.[0]?.highlights || ""
        }
    }
}


export function convertJudgmentResultsToXml(judgmentResults: JudgmentSummary[]) {
    return "<judgmentSummaries>\n" + judgmentResults.map((r) => {
        return `    <judgment>
        <url>${r.url}</url>
        <neutralCitation>${r.neutralCitation}</neutralCitation>
        <courtName>${r.courtName}</courtName>
        <year>${r.year}</year>
        <date>${r.date}</date>
        <parties>${r.parties || ""}</parties>
        <summary>${r.summary}</summary>
    </judgment>`;
    }).join("\n") + "\n</judgmentSummaries>";
}