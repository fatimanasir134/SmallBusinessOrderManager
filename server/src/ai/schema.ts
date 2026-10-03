/** Convert zod schemas into the JSON Schema Gemini accepts (structured output and tool parameters). */
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonSchema = Record<string, unknown>;

export function toGeminiJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { $schema: _ignored, ...json } = zodToJsonSchema(schema, {
    $refStrategy: 'none', // inline everything; Gemini handles flat schemas best
    target: 'jsonSchema7',
  }) as JsonSchema;
  return json;
}
