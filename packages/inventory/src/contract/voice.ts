import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryIdSchema } from './common.ts'

/**
 * Counting stock by voice (#488), behind `inventory.voice_counts` and a speech
 * model in the organization's own region. Both calls only PROPOSE lines: they
 * never write a count entry. The person confirms, edits or drops each line, and
 * the confirmed lines go through the ordinary count entry route (with the words
 * as `transcript`), so a voice line is a normal entry for the review and, on
 * Station, for the offline queue.
 *
 * - `POST /voice/propose?locationId=&language=` (operator) and
 *   `POST /pos/inventory/voice/propose?language=` (Station, its own location):
 *   the request body is the recording itself (`audio/webm`, `audio/mp4`, ...,
 *   at most `VOICE_AUDIO_MAX_BYTES`). The recording is held in memory for the
 *   call and never stored. 503 `reader_not_configured` when the node has no
 *   speech model in its own region (the client hides the microphone); 502
 *   `reader_failed` when the model did not answer.
 * - `POST /voice/parse` and `POST /pos/inventory/voice/parse`: the same
 *   matching for words a person typed or corrected ("Which one?").
 * - `GET /voice` (operator): `{ available }`, so the App knows whether to show
 *   the microphone. Station reads `settings.voiceCountsEnabled` of the catalog.
 */

export const VOICE_AUDIO_MAX_BYTES = 2_000_000
export const VOICE_TRANSCRIPT_MAX = 1000

export const voiceLanguageSchema = z.enum(['en', 'ar'])

export const voiceCapabilitySchema = z.object({ available: z.boolean() })

export const voiceProposeQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		language: voiceLanguageSchema.optional(),
	})
	.strict()

export const stationVoiceProposeQuerySchema = z
	.object({ language: voiceLanguageSchema.optional() })
	.strict()

export const voiceParseSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		transcript: z.string().trim().min(1).max(VOICE_TRANSCRIPT_MAX),
	})
	.strict()

export const stationVoiceParseSchema = z
	.object({ transcript: z.string().trim().min(1).max(VOICE_TRANSCRIPT_MAX) })
	.strict()

export const voiceLineSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	amount: z.number(),
	/** A standard unit key or `unit:<id>`: one the item has. */
	unit: z.string(),
	unitLabel: z.string(),
	unitAssumed: z.boolean(),
	heard: z.string(),
	match: z.enum(['exact', 'close']),
})

export const voiceQuestionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('which_item'),
		heard: z.string(),
		amount: z.number().nullable(),
		unitWords: z.string().nullable(),
		reason: z.enum(['no_match', 'ambiguous']),
		candidates: z.array(z.object({ itemId: z.string(), name: z.string() })),
	}),
	z.object({
		kind: z.literal('which_unit'),
		heard: z.string(),
		itemId: z.string(),
		itemName: z.string(),
		amount: z.number(),
		unitWords: z.string(),
		options: z.array(z.object({ ref: z.string(), label: z.string() })),
	}),
])

export const voiceProposalSchema = z.object({
	/** What was heard (or typed), for the person to read and correct. */
	transcript: z.string(),
	lines: z.array(voiceLineSchema),
	questions: z.array(voiceQuestionSchema),
})
export type VoiceProposal = z.infer<typeof voiceProposalSchema>

/** The words kept on a confirmed entry, for the review. */
export const entryTranscriptSchema = z
	.string()
	.trim()
	.min(1)
	.max(VOICE_TRANSCRIPT_MAX)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

export const voiceCountParamsSchema = z.object({ countId: inventoryIdSchema })
