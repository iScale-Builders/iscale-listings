import { z } from 'zod';
import {
  ALLOWED_CLASSES,
  DEFAULT_JURISDICTIONS,
  JURISDICTIONS,
  MAX_TEXT_LENGTH,
  MIN_TEXT_LENGTH,
  MAX_BATCH_SIZE,
  MAX_RESULTS,
  MAX_REQUEST_RESULTS,
} from '@/lib/trademark/constants';

const JurisdictionsSchema = z
  .array(z.enum(JURISDICTIONS))
  .min(1, 'At least one jurisdiction is required')
  .max(JURISDICTIONS.length, `Maximum ${JURISDICTIONS.length} jurisdictions per request`)
  .optional()
  .default([...DEFAULT_JURISDICTIONS]);

const ResultLimitSchema = z.number().int().min(1).max(MAX_REQUEST_RESULTS).optional().default(MAX_RESULTS);

export const CheckRequestSchema = z.object({
  text: z
    .string()
    .min(MIN_TEXT_LENGTH, 'Text must be at least 2 characters')
    .max(MAX_TEXT_LENGTH, `Text must not exceed ${MAX_TEXT_LENGTH} characters`),
  classes: z
    .array(z.string())
    .min(1, 'At least one class is required')
    .max(10, 'Maximum 10 classes per request')
    .refine(
      (classes) => classes.every((c) => (ALLOWED_CLASSES as readonly string[]).includes(c)),
      { message: 'Unknown class code. Allowed: ' + ALLOWED_CLASSES.join(', ') }
    ),
  include_dead: z.boolean().optional().default(true),
  max_results: ResultLimitSchema,
  jurisdictions: JurisdictionsSchema,
});

export const BatchRequestSchema = z.object({
  items: z
    .array(
      z.object({
        text: z
          .string()
          .min(MIN_TEXT_LENGTH)
          .max(MAX_TEXT_LENGTH),
        classes: z
          .array(z.string())
          .min(1)
          .max(10)
          .refine(
            (classes) =>
              classes.every((c) => (ALLOWED_CLASSES as readonly string[]).includes(c)),
            { message: 'Unknown class code' }
          ),
        include_dead: z.boolean().optional().default(true),
        max_results: ResultLimitSchema,
        jurisdictions: JurisdictionsSchema,
      })
    )
    .min(1, 'At least one item is required')
    .max(MAX_BATCH_SIZE, `Maximum ${MAX_BATCH_SIZE} items per batch`),
});

export type CheckRequestInput = z.infer<typeof CheckRequestSchema>;
export type BatchRequestInput = z.infer<typeof BatchRequestSchema>;
