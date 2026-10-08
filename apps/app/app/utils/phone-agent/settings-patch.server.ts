import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import {
	findTransferLoop,
	type PhoneAgentSettings,
	PhoneAgentSettingsSchema,
	unsupportedPhoneFields,
} from '@repo/phone-agent'
import { z } from 'zod'
import {
	getPhoneAgent,
	listPhoneNumbers,
	updatePhoneAgentSettings,
} from './phone-agent.server.ts'
import { settingsError, type SettingsVersions } from './settings-errors.ts'
import { recordSettingsChange } from './settings-history.server.ts'
import { phoneAgentVertical } from './vertical.ts'

export type SettingsPatchResult =
	| { ok: true; settings: PhoneAgentSettings; versions: SettingsVersions }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

const SETTINGS_KEYS = Object.keys(PhoneAgentSettingsSchema.shape)
const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS)

const VersionsSchema = z.record(z.string().max(32))

// The E164 schema's regex message; it is the only phone format check.
const PHONE_FORMAT_MESSAGE = 'Use international format'

/** A settings error code for one Zod issue (see settings-errors.ts). */
function issueCode(issue: z.ZodIssue): string {
	switch (issue.code) {
		case z.ZodIssueCode.too_small: {
			const minimum = Number(issue.minimum)
			if (issue.type === 'string') {
				return minimum <= 1
					? settingsError('required')
					: settingsError('too_short', minimum)
			}
			if (issue.type === 'array') return settingsError('too_few', minimum)
			return settingsError('too_small', minimum)
		}
		case z.ZodIssueCode.too_big: {
			const maximum = Number(issue.maximum)
			if (issue.type === 'string') return settingsError('too_long', maximum)
			if (issue.type === 'array') return settingsError('too_many', maximum)
			return settingsError('too_big', maximum)
		}
		case z.ZodIssueCode.invalid_string:
			if (issue.validation === 'email') return settingsError('email')
			return issue.message.startsWith(PHONE_FORMAT_MESSAGE)
				? settingsError('phone')
				: settingsError('format')
		case z.ZodIssueCode.invalid_type:
			return issue.received === 'undefined' || issue.received === 'null'
				? settingsError('required')
				: settingsError('invalid')
		default:
			return settingsError('invalid')
	}
}

/** First error code per field path, e.g. `{ 'contacts.0.phone': 'phone' }`. */
export function toFieldErrors(error: z.ZodError) {
	const fieldErrors: Record<string, string> = {}
	for (const issue of error.issues) {
		const key = issue.path.join('.')
		if (key && !fieldErrors[key]) fieldErrors[key] = issueCode(issue)
	}
	return fieldErrors
}

/** Drops keys that are not settings so a page can only change what it owns. */
export function pickSettingsPatch(raw: unknown) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
	return Object.fromEntries(
		Object.entries(raw as Record<string, unknown>).filter(([key]) =>
			SETTINGS_KEY_SET.has(key),
		),
	)
}

// 53-bit string hash (cyrb53). Fingerprints only need to change when a value
// changes; they are not a security boundary.
function fingerprint(value: string) {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let index = 0; index < value.length; index++) {
		const char = value.charCodeAt(index)
		h1 = Math.imul(h1 ^ char, 2654435761)
		h2 = Math.imul(h2 ^ char, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * One fingerprint per top-level settings key. Pages send back the ones for
 * the keys they save, so two pages saving different keys never conflict,
 * while a form based on stale values of the same keys is refused.
 */
export function settingsVersions(
	settings: PhoneAgentSettings,
): SettingsVersions {
	return Object.fromEntries(
		SETTINGS_KEYS.map((key) => [
			key,
			fingerprint(
				JSON.stringify(settings[key as keyof PhoneAgentSettings] ?? null),
			),
		]),
	)
}

/**
 * Checks that need more than one field, or data outside the settings.
 *
 * `changedKeys` limits the US/Canada number check to the keys being saved:
 * numbers stored before that rule fail on the page that edits them, rather
 * than blocking unrelated pages that can't show the error.
 */
export function validateSettingsRelations(
	settings: PhoneAgentSettings,
	numbers: Array<{ e164: string; forwardedFrom?: string | null }>,
	changedKeys?: readonly string[],
): Record<string, string> {
	const errors: Record<string, string> = {}
	for (const field of unsupportedPhoneFields(settings)) {
		const key = field.split('.')[0]!
		if (!changedKeys || changedKeys.includes(key)) {
			errors[field] = settingsError('phone_region')
		}
	}
	const contactIds = new Set<string>()
	settings.contacts.forEach((contact, index) => {
		if (contactIds.has(contact.id)) {
			errors[`contacts.${index}.id`] = settingsError('duplicate_id')
		}
		contactIds.add(contact.id)
		if (findTransferLoop(contact.phone, numbers)) {
			errors[`contacts.${index}.phone`] = settingsError('transfer_loop')
		}
	})
	const caseIds = new Set<string>()
	settings.transferCases.forEach((transferCase, index) => {
		if (caseIds.has(transferCase.id)) {
			errors[`transferCases.${index}.id`] = settingsError('duplicate_id')
		}
		caseIds.add(transferCase.id)
		if (!contactIds.has(transferCase.contactId)) {
			errors[`transferCases.${index}.contactId`] =
				settingsError('contact_required')
		}
	})
	const tagIds = new Set<string>()
	settings.tags.forEach((tag, index) => {
		if (tagIds.has(tag.id)) {
			errors[`tags.${index}.id`] = settingsError('duplicate_id')
		}
		tagIds.add(tag.id)
	})
	const faqIds = new Set<string>()
	settings.faq.forEach((entry, index) => {
		if (faqIds.has(entry.id)) {
			errors[`faq.${index}.id`] = settingsError('duplicate_id')
		}
		faqIds.add(entry.id)
	})
	// Availability has no overnight slots, so an inverted one is never open.
	if (!changedKeys || changedKeys.includes('business')) {
		const inverted = (slots: ReadonlyArray<{ start: string; end: string }>) =>
			slots.some((slot) => slot.end <= slot.start)
		if (
			settings.business.hours.some((day) => day.isOpen && inverted(day.slots))
		) {
			errors['business.hours'] = settingsError('closes_before_opens')
		}
		if (
			settings.business.specialHours.some(
				(entry) => entry.isOpen && inverted(entry.slots),
			)
		) {
			errors['business.specialHours'] = settingsError('closes_before_opens')
		}
	}
	return errors
}

/**
 * `settings.vertical` checked by the vertical's own schema; field errors are
 * prefixed `vertical.`. Verticals without settings store nothing there.
 */
export function parseVerticalSettings(
	value: unknown,
):
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; fieldErrors: Record<string, string> } {
	const schema = phoneAgentVertical.settings?.schema
	if (!schema) return { ok: true, value: {} }
	const parsed = schema.safeParse(value ?? {})
	if (!parsed.success) {
		return {
			ok: false,
			fieldErrors: Object.fromEntries(
				Object.entries(toFieldErrors(parsed.error)).map(([key, code]) => [
					`vertical.${key}`,
					code,
				]),
			),
		}
	}
	return { ok: true, value: parsed.data as Record<string, unknown> }
}

export function canChangeStaffAlerts(userId: string, organizationId: string) {
	return userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
	)
}

const CONFLICT: SettingsPatchResult = {
	ok: false,
	error: settingsError('conflict'),
}

/**
 * Saves part of the settings on top of what is stored, so each settings page
 * only sends its own fields and never resets fields added by other pages.
 *
 * `versions` are the fingerprints (from `settingsVersions`) the page loaded
 * for the keys it saves. If any of those keys changed since, nothing is
 * written. The write itself only succeeds if the row is unchanged since it
 * was read; when another key changed in between, the patch is merged onto the
 * fresh row once more.
 *
 * Staff alerts carry every caller's number and a call summary, so changing
 * them also needs permission to read calls (`canChangeAlerts`).
 */
export async function patchPhoneAgentSettings(input: {
	organizationId: string
	userId: string
	request?: Request
	patch: unknown
	versions: unknown
	/** Defaults to checking the user's call-read permission. */
	canChangeAlerts?: () => Promise<boolean>
}): Promise<SettingsPatchResult> {
	const patch = pickSettingsPatch(input.patch)
	const keys = Object.keys(patch)
	const expected = VersionsSchema.safeParse(input.versions)
	if (!expected.success) {
		return { ok: false, error: settingsError('invalid_request') }
	}
	const canChangeAlerts =
		input.canChangeAlerts ??
		(() => canChangeStaffAlerts(input.userId, input.organizationId))

	for (let attempt = 0; attempt < 2; attempt++) {
		const agent = await getPhoneAgent(input.organizationId)
		const current = settingsVersions(agent.settings)
		if (keys.some((key) => expected.data[key] !== current[key])) {
			return CONFLICT
		}
		const parsed = PhoneAgentSettingsSchema.safeParse({
			...agent.settings,
			...patch,
		})
		if (!parsed.success) {
			return {
				ok: false,
				error: settingsError('invalid_fields'),
				fieldErrors: toFieldErrors(parsed.error),
			}
		}
		if ('vertical' in patch) {
			const verticalSettings = parseVerticalSettings(parsed.data.vertical)
			if (!verticalSettings.ok) {
				return {
					ok: false,
					error: settingsError('invalid_fields'),
					fieldErrors: verticalSettings.fieldErrors,
				}
			}
			parsed.data.vertical = verticalSettings.value
		}
		if (
			JSON.stringify(parsed.data.notifications) !==
				JSON.stringify(agent.settings.notifications) &&
			!(await canChangeAlerts())
		) {
			return {
				ok: false,
				error: settingsError('alerts_forbidden'),
				fieldErrors: { notifications: settingsError('alerts_forbidden') },
			}
		}
		const numbers = await listPhoneNumbers(input.organizationId)
		const relationErrors = validateSettingsRelations(parsed.data, numbers, keys)
		if (Object.keys(relationErrors).length) {
			return {
				ok: false,
				error: settingsError('invalid_fields'),
				fieldErrors: relationErrors,
			}
		}
		const result = await updatePhoneAgentSettings(
			input.organizationId,
			parsed.data,
			{ expectedRawSettings: agent.rawSettings },
		)
		if (!result.ok) {
			if (result.conflict) continue
			return { ok: false, error: result.error }
		}
		await recordSettingsChange({
			organizationId: input.organizationId,
			userId: input.userId,
			request: input.request,
			before: agent.settings,
			after: result.settings,
		})
		return {
			ok: true,
			settings: result.settings,
			versions: settingsVersions(result.settings),
		}
	}
	return CONFLICT
}
