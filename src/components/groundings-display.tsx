import { SourceUrlUIPart } from "ai";
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

/* T11 pg contract: the route emits one `source-url` part per POST-RERANK final
 * only (never fusion candidates), with providerMetadata.custom carrying the pg
 * fields { rrf_score, rerank_score, snippet }. Legacy Azure aliases are read as
 * fallback only: score ~= rrf_score, caption ~= snippet, rerankerScore ~=
 * rerank_score. captionHighlights is dead (never written by T08+ route) and
 * ignored. When RERANK_ENABLED=false the route writes rerank_score: null, so
 * the UI shows fusion (RRF) order with no rerank badge — never breaks. */
type PgSourceMeta = {
  rrf_score?: number | null;
  rerank_score?: number | null;
  snippet?: string;
  // Compat aliases (older writers / other surfaces). Read-only fallback.
  score?: number | null;
  caption?: string;
  rerankerScore?: number | null;
};

function SourceGroup({ sources }: { sources: SourceUrlUIPart[] }) {
  return (
    <div>
      <div className="space-y-3">
        {sources.map((source, index) => {
          const metaData = (source.providerMetadata?.custom ?? {}) as PgSourceMeta;
          const snippet =
            (typeof metaData.snippet === "string" && metaData.snippet) ||
            (typeof metaData.caption === "string" && metaData.caption) ||
            "";
          const rrfScore = metaData.rrf_score ?? metaData.score ?? null;
          const rerankScore = metaData.rerank_score ?? metaData.rerankerScore ?? null;
          return (
            <div key={index} className="p-3 bg-muted/50 rounded-lg">
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
                {snippet}
              </p>
              {(rerankScore != null || rrfScore != null) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {rerankScore != null
                    ? `Rerank: ${rerankScore.toFixed(2)} · RRF: ${rrfScore?.toFixed(2) ?? "n/a"}`
                    : `RRF: ${rrfScore?.toFixed(2) ?? "n/a"}`}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
