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
  const judgement = groundings.filter((part) =>
    part.sourceId.startsWith("case")
  );

  return (
    <Tabs defaultValue="clic">
      <TabsList>
        <TabsTrigger value="clic">Clic Pages</TabsTrigger>
        <TabsTrigger value="cap">Legislation</TabsTrigger>
        <TabsTrigger value="case">Cases</TabsTrigger>
      </TabsList>
      <TabsContent value="clic">
        <SourceGroup sources={clicPages} />
      </TabsContent>
      <TabsContent value="cap">
        <SourceGroup sources={caps} />
      </TabsContent>
      <TabsContent value="case">
        <SourceGroup sources={judgement} />
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

function SourceGroup({ sources }: { sources: SourceUrlUIPart[] }) {
  return (
    <div>
      <div className="space-y-3">
        {sources.map((source, index) => {
          const metaData = source.providerMetadata?.custom as {
            score: number | null;
            rerankerScore: number | null;
            caption: string;
            captionHighlights: string;
          };
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
                {source.providerMetadata?.custom.caption &&
                  typeof source.providerMetadata.custom
                    .caption === "string"
                  ? source.providerMetadata.custom.caption
                  : ""}
              </p>
              {(metaData.rerankerScore || metaData.score) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Score:{" "}
                  {metaData.rerankerScore
                    ? metaData.rerankerScore.toFixed(2)
                    : metaData.score?.toFixed(2)}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
