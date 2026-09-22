// instrumentation.ts

import { isDefaultExportSpan, LangfuseSpanProcessor, type ShouldExportSpan } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const shouldExportSpan: ShouldExportSpan = ({ otelSpan }) =>
  isDefaultExportSpan(otelSpan) && otelSpan.instrumentationScope.name !== "next.js";

export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  exportMode: "immediate",
  shouldExportSpan,
});

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();
