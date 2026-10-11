import { z } from 'zod'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from './pin.ts'

const id = z.string().trim().min(1).max(64)

export const pinInputSchema = z
	.string()
	.regex(new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`), {
		message: 'invalid_pin',
	})

/** Omit `pin` to have tenant-api generate one. */
export const pinSetSchema = z
	.object({ pin: pinInputSchema.optional() })
	.strict()

export const pairingCodeCreateSchema = z.object({
	locationId: id,
	/** Control-plane location name, shown on the kiosk; not personal data. */
	locationName: z.string().trim().max(120).default(''),
	name: z.string().trim().min(1).max(60),
})

export const kioskPairSchema = z.object({
	orgId: id,
	code: z
		.string()
		.trim()
		.min(8)
		.max(16)
		.regex(/^[0-9A-Za-z]+$/),
})

export const kioskIdentifySchema = z.object({ pin: pinInputSchema })

export const kioskPunchSchema = z.object({
	punchToken: z.string().min(10).max(200),
	action: z.enum(['in', 'out']),
	positionId: id.nullable().default(null),
	clientRequestId: z.string().uuid(),
})

export const PAIRING_CODE_TTL_MINUTES = 15
