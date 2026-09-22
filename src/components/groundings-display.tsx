import { SourceUrlUIPart } from "ai";
import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const GroundingsDisplay = ({
  groundings,
}: {
  groundings: SourceUrlUIPart[] | null;
}) => {
  if (!groundings) return null;
  const clicPages = groundings.filter((part) =>
    part.sourceId.startsWith("clic")
  );
  const caps = groundings.filter((part) => part.sourceId.startsWith("cap"));
  const judgment = groundings.filter((part) =>
    part.sourceId.startsWith("judgment")
  );

  return (
    <Tabs defaultValue="clic">
      <TabsList>
        <TabsTrigger value="clic">Clic Pages</TabsTrigger>
        <TabsTrigger value="cap">Legislation</TabsTrigger>
        <TabsTrigger value="judgment">Judgment</TabsTrigger>
      </TabsList>
      <TabsContent value="clic">
        <SourceGroup sources={clicPages} />
      </TabsContent>
      <TabsContent value="cap">
        <SourceGroup sources={caps} />
      </TabsContent>
      <TabsContent value="judgment">
        <SourceGroup sources={judgment} />
      </TabsContent>
    </Tabs>

    // <div className="flex flex-col gap-4 w-full">
    //   {ordinances.length > 0 && (
    //     <div>
    //       <h3 className="text-sm font-semibold mb-2">Ordinances & Regulations</h3>
    //       <div className="space-y-3">
    //         {ordinances.map((ord, index) => (
    //           <div key={index} className="p-3 bg-muted/50 rounded-lg">
    //             <h4 className="font-medium">
    //               Cap {ord.cap_no} ({ord.cap_title}), {ord.cap_no.endsWith('A') ? 'Regulation' : 'Section'} {ord.section_no}
    //               {ord.section_heading && ` - ${ord.section_heading}`}
    //             </h4>
    //             <p className="mt-1 text-sm max-h-72 text-ellipsis overflow-auto">{ord.text}</p>
    //             <p className="mt-1 text-xs text-muted-foreground">Score: {ord._relevance_score? ord._relevance_score.toFixed(2) : ord._distance?.toFixed(2)}</p>
    //             <Citation title={`Cap ${ord.cap_no}, Section ${ord.section_no}`} url={ord.url} />
    //           </div>
    //         ))}
    //       </div>
    //     </div>
    //   )}

    //   {judgement.length > 0 && (
    //     <div>
    //       <h3 className="text-sm font-semibold mb-2">Judgement & Cases</h3>
    //       <div className="space-y-3">
    //         {judgement.map((judge, index) => (
    //           <div key={index} className="p-3 bg-muted/50 rounded-lg">
    //             <h4 className="font-medium">
    //               {judge.date}: {judge.case_name} ({judge.court})
    //             </h4>
    //             <p className="mt-1 text-sm">{judge.case_summary}</p>
    //             <div className="mt-2 text-sm flex flex-col gap-1">
    //               <p><span className="font-bold">Case Causes:</span> {judge.case_causes}</p>
    //               <p><span className="font-bold">Court Decision:</span> {judge.court_decision}</p>
    //             </div>
    //             <p className="mt-1 text-xs text-muted-foreground">Score: {judge._relevance_score? judge._relevance_score.toFixed(2) : judge._distance?.toFixed(2)}</p>
    //             <Citation title={judge.case_name} url={judge.url} />
    //           </div>
    //         ))}
    //       </div>
    //     </div>
    //   )}
    // </div>
  );
};

const sourceMetadataSchema = z.strictObject({
  rrf_score: z.number().nullable(),
  rerank_score: z.number().nullable(),
  snippet: z.string(),
});

const legacySourceMetadataSchema = z.strictObject({
  rrf_score: z.number().nullable().optional(),
  rerank_score: z.number().nullable().optional(),
  snippet: z.string().optional(),
  score: z.number().nullable().optional(),
  caption: z.string().optional(),
  rerankerScore: z.number().nullable().optional(),
});

type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

function parseSourceMetadata(value: unknown): SourceMetadata {
  const current = sourceMetadataSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacySourceMetadataSchema.safeParse(value);
  if (legacy.success) {
    return {
      rrf_score: legacy.data.rrf_score ?? legacy.data.score ?? null,
      rerank_score: legacy.data.rerank_score ?? legacy.data.rerankerScore ?? null,
      snippet: legacy.data.snippet ?? legacy.data.caption ?? "",
    };
  }

  return { rrf_score: null, rerank_score: null, snippet: "" };
}

function SourceGroup({ sources }: { sources: SourceUrlUIPart[] }) {
  return (
    <div>
      <div className="space-y-3">
        {sources.map((source) => {
          const metadata = parseSourceMetadata(source.providerMetadata?.custom);
          return (
            <div key={source.sourceId} className="p-3 bg-muted/50 rounded-lg">
              <h4 className="font-medium">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.title}
                </a>
              </h4>
              <p className="mt-1 text-sm max-h-72 text-ellipsis overflow-auto">
                {metadata.snippet}
              </p>
              {(metadata.rerank_score != null || metadata.rrf_score != null) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {metadata.rerank_score != null
                    ? `Rerank: ${metadata.rerank_score.toFixed(2)} · RRF: ${metadata.rrf_score?.toFixed(2) ?? "n/a"}`
                    : `RRF: ${metadata.rrf_score?.toFixed(2) ?? "n/a"}`}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
