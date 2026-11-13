/**
 * Marketing consent wording versions and the vocabulary shared by Sites, the
 * customer app, the App and tenant-api. The wording itself lives in each
 * client's Lingui catalog; a subscription row stores only the version id of
 * the text the guest (or the staff member recording it) was shown, so a
 * business can prove what was agreed to. Bump a version whenever the matching
 * wording changes in a way that matters.
 */

import { z } from 'zod'

/** The opt-in boxes and switches a guest sees on Sites and in the customer app. */
export const MARKETING_CONSENT_TEXT_VERSION = 'guest-2026-11'

/** The confirmation a staff member accepts when recording a guest's consent. */
export const STAFF_CONSENT_TEXT_VERSION = 'staff-2026-11'

export const CONSENT_TEXT_VERSION_MAX_LENGTH = 64

/**
 * A wording version id as a client sends it: short, and only letters, digits,
 * dots, dashes and underscores. The messages never echo the rejected value.
 */
export const consentTextVersionSchema = z
	.string({ error: 'Invalid consent text version' })
	.trim()
	.min(1, { error: 'Invalid consent text version' })
	.max(CONSENT_TEXT_VERSION_MAX_LENGTH, {
		error: 'Invalid consent text version',
	})
	.regex(/^[A-Za-z0-9._-]+$/, { error: 'Invalid consent text version' })

/**
 * The marketing boxes a guest ticked at checkout (`marketingConsent` on an
 * order request). Honoured only for a signed-in customer; only `true` acts,
 * so an unticked box never unsubscribes anyone.
 */
export const orderMarketingConsentSchema = z.strictObject({
	email: z.boolean().optional(),
	sms: z.boolean().optional(),
	textVersion: consentTextVersionSchema,
})
export type OrderMarketingConsent = z.infer<typeof orderMarketingConsentSchema>

/** How a guest gave the consent a staff member records. */
export const STAFF_CONSENT_METHODS = [
	'in_person',
	'paper_form',
	'phone',
] as const
export type StaffConsentMethod = (typeof STAFF_CONSENT_METHODS)[number]

/** Days a guest's own unsubscribe blocks a staff-recorded opt-in. */
export const STAFF_CONSENT_COOLING_OFF_DAYS = 30

/**
 * What became of the consent a guest ticked at checkout, per channel, in the
 * order placement response. `pending` is an email opt-in waiting for the
 * confirmation link; `skipped` means nothing was recorded (no address on
 * file, no verified phone).
 */
export type OrderMarketingConsentResult = {
	email?: 'pending' | 'subscribed' | 'skipped'
	sms?: 'subscribed' | 'skipped'
}
