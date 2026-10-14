// Trace payload conventions (SDK parity): the LangSmith UI reads LLM runs
// from full message inputs, generations-shaped outputs, and usage_metadata +
// ls_provider/ls_model_name in metadata. These tests pin the helper shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

// Keep the module inert (no real submits) before it reads the env.
process.env.LANGSMITH_TRACING = "0";

const { usageMetadata, llmRunMetadata, llmRunOutputs } = await import("../tracing.js");

test("usageMetadata maps provider usage to the LangSmith convention", () => {
  assert.deepEqual(usageMetadata({ prompt_tokens: 1200, completion_tokens: 340 }), {
    input_tokens: 1200,
    output_tokens: 340,
    total_tokens: 1540,
  });
  assert.equal(usageMetadata(undefined), undefined);
  assert.equal(usageMetadata({}), undefined);
  assert.equal(usageMetadata({ prompt_tokens: 0, completion_tokens: 0 }), undefined);
  // Partial usage still maps (missing side counts as zero).
  assert.deepEqual(usageMetadata({ completion_tokens: 5 }), {
    input_tokens: 0,
    output_tokens: 5,
    total_tokens: 5,
  });
});

test("llmRunMetadata carries ls_provider/ls_model_name and usage_metadata", () => {
  const meta = llmRunMetadata("z-ai/glm-5.3-flash", { prompt_tokens: 10, completion_tokens: 2 });
  assert.equal(meta.ls_provider, "openrouter");
  assert.equal(meta.ls_model_name, "z-ai/glm-5.3-flash");
  assert.deepEqual(meta.usage_metadata, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  // Without usage: model identity only.
  const bare = llmRunMetadata("m");
  assert.equal(bare.usage_metadata, undefined);
  assert.equal(bare.ls_model_name, "m");
});

test("llmRunOutputs builds a generations entry with the assistant message + usage_metadata", () => {
  const out = llmRunOutputs("hello", {
    usage: { prompt_tokens: 5, completion_tokens: 1 },
    message: { role: "assistant", content: "hello" },
  });
  const generations = out.generations as Array<Record<string, unknown>>;
  assert.equal(generations.length, 1);
  assert.equal(generations[0].text, "hello");
  assert.deepEqual(generations[0].message, { role: "assistant", content: "hello" });
  assert.deepEqual(out.usage_metadata, { input_tokens: 5, output_tokens: 1, total_tokens: 6 });

  // No usage: generations only, no usage_metadata key.
  const bare = llmRunOutputs("x");
  assert.equal(bare.usage_metadata, undefined);
  assert.equal((bare.generations as unknown[]).length, 1);
});
