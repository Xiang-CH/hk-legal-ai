import { InferUITools, ToolSet, UIMessage } from 'ai';
import z from 'zod';

const clicSchema = z.object({
  nid: z.number(),
  title: z.string(),
  content: z.string(),
  url: z.string(),
  topic: z.string(),
  chunk_no: z.number(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
  caption: z.string().optional(),
  captionHighlights: z.string().optional(),
});
export type ClicPage = z.infer<typeof clicSchema>;

const legislationSchema = z.object({
  capNumber: z.string(),
  sectionNumber: z.string(),
  subsectionNumber: z.string().optional(),
  capTitle: z.string(),
  sectionHeading: z.string(),
  content: z.string(),
  url: z.string(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
});
export type LegislationSection = z.infer<typeof legislationSchema>;

const judgementSchema = z.object({
  case_name: z.string(),
  court: z.string(),
  date: z.string(),
  case_summary: z.string(),
  case_causes: z.string(),
  court_decision: z.string(),
  url: z.string(),
  rerankerScore: z.number().optional(),
  score: z.number().optional(),
});

export const groundingsSchema = z.object({
  legislation: z.array(legislationSchema),
  judgement: z.array(judgementSchema),
  clicPages: z.array(clicSchema),
});

export type Groundings = z.infer<typeof groundingsSchema>;

const metadataSchema = z.object({
  searchQuery: z.string().optional(),
  groundings: groundingsSchema.optional(),
  searchQueries: z.array(z.string()).optional(),
});

type MyMetadata = z.infer<typeof metadataSchema>;

// const dataPartSchema = z.object({
//   someDataPart: z.object({}),
//   anotherDataPart: z.object({}),
// });

type MyDataPart = {
  type: 'data';
  data: unknown;
};

const tools: ToolSet = {};

type MyTools = InferUITools<typeof tools>;

export type MyUIMessage = UIMessage<MyMetadata, MyDataPart, MyTools>;