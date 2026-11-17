import { z } from 'zod'
import {
	type LocalizedString,
	pickLocalized,
	serializeLocalizedString,
} from './site-locales.ts'

/** Guest pickup copy at checkout (#251). Plain text, localized like menu names. */
export const PICKUP_INSTRUCTIONS_MAX_LENGTH = 300

export const pickupInstructionsSchema = z
	.record(z.string(), z.string().trim().max(PICKUP_INSTRUCTIONS_MAX_LENGTH))
	.superRefine((map, ctx) => {
		const hasValue = Object.values(map).some((v) => v.trim().length > 0)
		if (!hasValue) {
			ctx.addIssue({
				code: 'custom',
				message: 'Add instructions or leave empty',
			})
		}
	})

export function resolvePickupInstructions(
	raw: string | LocalizedString | null | undefined,
	locale: string,
	defaultLocale: string,
): string {
	const text = pickLocalized(raw ?? null, locale, defaultLocale).trim()
	return text.slice(0, PICKUP_INSTRUCTIONS_MAX_LENGTH)
}

export function serializePickupInstructions(
	map: LocalizedString,
): string | null {
	const serialized = serializeLocalizedString(map)
	return serialized === '{}' ? null : serialized
}
