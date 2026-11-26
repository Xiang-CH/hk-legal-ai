import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createChatTransport } from "../../src/lib/chat-transport";
import { createSearchRequestTerminal } from "../../src/lib/judgment-search-debug";
import { retrieveSearchQueries } from "../../src/lib/search-fanout";
import { withSearchFallback } from "../../src/lib/tools/shared";

test("the fallback helper respects each tool's primary budget", async () => {
  const search = (primaryBudgetMs: number) => withSearchFallback(
    () => delay(15, "hybrid hits"),
    async () => "lexical hits",
    "judgment fixture",
    { primaryBudgetMs },
  );
  assert.equal(await search(0), "lexical hits");
  assert.equal(await search(250), "hybrid hits");
});

test("parallel retrieval keeps available hits and waits for later numbered failures", async () => {
  const failures: number[] = [];
  const result = await retrieveSearchQueries(["first", "second"], {
    forQuery: (index) => ({
      log: () => {},
      async stage(_name, run) {
        try {
          return await run();
        } catch (error) {
          if (index !== undefined) failures.push(index);
          throw error;
        }
      },
    }),
  }, {
    embed: async () => [1],
    clic: async (query) => query === "second" ? ["article"] : [],
    judgments: async (query) => {
      if (query === "second") await delay(10);
      throw new Error("fixture failed");
    },
  });
  assert.deepEqual(failures, [0, 1]);
  assert.deepEqual(result.clicLists.flat(), ["article"]);
  assert.equal(result.completed, 2);
  assert.equal(result.partial, true);
});

test("an aborted request reports cancellation once even if an error or finish follows", () => {
  const abort = new AbortController();
  const events: string[] = [];
  const terminal = createSearchRequestTerminal({ log: (event) => events.push(event) }, abort.signal);
  abort.abort();
  terminal("request_error");
  terminal("request_end");
  assert.deepEqual(events, ["request_aborted"]);
});

test("transport replaces replayed debug opt-in with the current switch on every send", async () => {
  let enabled = true;
  const transport = createChatTransport(() => enabled);
  const submitted: unknown[] = [];
  const fetchBeforeTest = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, "string");
    submitted.push(JSON.parse(String(init?.body)));
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const request = {
      trigger: "submit-message" as const,
      chatId: "fixture",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: { debugJudgmentSearch: true, maxSteps: 5 },
    };
    for (const value of [true, false]) {
      enabled = value;
      const stream = await transport.sendMessages(request);
      await stream.getReader().read();
    }
    assert.deepEqual(submitted, [true, false].map((debugJudgmentSearch) => ({
      debugJudgmentSearch, maxSteps: 5, id: "fixture", messages: [], trigger: "submit-message",
    })));
  } finally {
    globalThis.fetch = fetchBeforeTest;
  }
});
