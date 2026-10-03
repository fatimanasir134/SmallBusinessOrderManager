/**
 * Exposes the Order Understanding Agent's extraction as a tool (Gemini reads the message, the
 * backend validates it). Nothing is written to the database.
 */
import { z } from 'zod';
import { extract } from '../agents/understanding.js';
import { gemini } from '../ai/gemini.js';
import { defineTool } from './types.js';

const input = z.object({
  message: z.string().trim().min(1, 'message is empty').max(4000, 'message is too long'),
});

export const extractOrderInformation = defineTool({
  name: 'extractOrderInformation',
  description:
    'Read an unstructured customer message and extract the order: products (matched to the ' +
    'catalogue), quantities, customization, deadline, discount request, and contact details. ' +
    'Returns missingInfo questions when something is unclear. Does not create an order.',
  access: 'read',
  input,
  handler: async ({ message }, ctx) => extract(gemini(), message, ctx.today),
});
