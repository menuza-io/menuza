import {
	MESSAGE_LOCALES,
	type MessageLocale,
	type MessageSettings,
	type MessageSettingsPatch,
	WAITLIST_MESSAGE_SETTING_KINDS,
} from '#app/utils/reservations/messages-api.ts'
import {
	minutesToTimeString,
	timeStringToMinutes,
} from '#app/utils/reservations/setup-api.ts'

export const HOURS_MIN = 1
export const HOURS_MAX = 168

export const DEFAULT_QUIET_START_MIN = 21 * 60
export const DEFAULT_QUIET_END_MIN = 8 * 60

/**
 * Editable copy of the saved settings. Hours stay strings while typing so an
 * empty field is a valid intermediate state.
 */
export type MessageDraft = {
	/** Every kind, including `reconfirm_request` (sent as `reconfirmEnabled`). */
	kinds: Record<string, boolean>
	reminderHours: string
	reconfirmHours: string
	/** Tenant-api has no quiet-hours switch: an empty window (start = end) is "off". */
	quietEnabled: boolean
	quietStart: string
	quietEnd: string
	smsEnabled: boolean
	notes: Record<string, Record<MessageLocale, string>>
}

export function draftFromSettings(settings: MessageSettings): MessageDraft {
	const kinds: Record<string, boolean> = {}
	const notes: MessageDraft['notes'] = {}
	for (const entry of settings.kinds) {
		kinds[entry.kind] = entry.enabled
		notes[entry.kind] = { en: entry.notes.en, ar: entry.notes.ar }
	}
	const { startMin, endMin } = settings.messaging.quietHours
	const quietEnabled = startMin !== endMin
	return {
		kinds,
		reminderHours: String(settings.messaging.reminderHours),
		reconfirmHours: String(settings.messaging.reconfirmHours),
		quietEnabled,
		quietStart: minutesToTimeString(
			quietEnabled ? startMin : DEFAULT_QUIET_START_MIN,
		),
		quietEnd: minutesToTimeString(
			quietEnabled ? endMin : DEFAULT_QUIET_END_MIN,
		),
		smsEnabled: settings.messaging.smsEnabled,
		notes,
	}
}

export function parseHours(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null
	const hours = Number(value)
	return hours >= HOURS_MIN && hours <= HOURS_MAX ? hours : null
}

function quietMinutes(draft: MessageDraft): {
	startMin: number
	endMin: number
} {
	if (!draft.quietEnabled) return { startMin: 0, endMin: 0 }
	return {
		startMin: timeStringToMinutes(draft.quietStart),
		endMin: timeStringToMinutes(draft.quietEnd),
	}
}

export type DraftIssues = {
	reminderHours: boolean
	reconfirmHours: boolean
	quietHours: boolean
	/** `<kind>:<locale>` slots over the length limit. */
	longNotes: string[]
}

export function noteSlot(kind: string, locale: MessageLocale): string {
	return `${kind}:${locale}`
}

export function validateDraft(
	draft: MessageDraft,
	noteMaxLength: number,
): DraftIssues {
	const longNotes: string[] = []
	for (const [kind, byLocale] of Object.entries(draft.notes)) {
		for (const locale of MESSAGE_LOCALES) {
			if (byLocale[locale].length > noteMaxLength) {
				longNotes.push(noteSlot(kind, locale))
			}
		}
	}
	const quiet = quietMinutes(draft)
	return {
		reminderHours: parseHours(draft.reminderHours) === null,
		reconfirmHours: parseHours(draft.reconfirmHours) === null,
		// Equal bounds would silently switch quiet hours off.
		quietHours: draft.quietEnabled && quiet.startMin === quiet.endMin,
		longNotes,
	}
}

export function hasIssues(issues: DraftIssues): boolean {
	return (
		issues.reminderHours ||
		issues.reconfirmHours ||
		issues.quietHours ||
		issues.longNotes.length > 0
	)
}

function sameQuiet(a: MessageDraft, b: MessageDraft): boolean {
	const qa = quietMinutes(a)
	const qb = quietMinutes(b)
	return qa.startMin === qb.startMin && qa.endMin === qb.endMin
}

export function isDraftDirty(draft: MessageDraft, base: MessageDraft): boolean {
	return buildPatch(draft, base, 1) !== null
}

/**
 * Only what changed since `base` is sent, so a save never rewrites settings the
 * operator did not touch. Returns null when nothing changed. The draft is
 * assumed valid (see `validateDraft`).
 */
export function buildPatch(
	draft: MessageDraft,
	base: MessageDraft,
	expectedVersion: number,
): MessageSettingsPatch | null {
	const messaging: NonNullable<MessageSettingsPatch['messaging']> = {}

	const kinds: Record<string, boolean> = {}
	for (const [kind, enabled] of Object.entries(draft.kinds)) {
		if (kind === 'reconfirm_request') continue
		if (enabled !== base.kinds[kind]) kinds[kind] = enabled
	}
	if (Object.keys(kinds).length > 0) messaging.kinds = kinds

	if (draft.kinds.reconfirm_request !== base.kinds.reconfirm_request) {
		messaging.reconfirmEnabled = Boolean(draft.kinds.reconfirm_request)
	}
	if (draft.reminderHours.trim() !== base.reminderHours.trim()) {
		const hours = parseHours(draft.reminderHours)
		if (hours !== null) messaging.reminderHours = hours
	}
	if (draft.reconfirmHours.trim() !== base.reconfirmHours.trim()) {
		const hours = parseHours(draft.reconfirmHours)
		if (hours !== null) messaging.reconfirmHours = hours
	}
	if (!sameQuiet(draft, base)) messaging.quietHours = quietMinutes(draft)
	if (draft.smsEnabled !== base.smsEnabled) {
		messaging.smsEnabled = draft.smsEnabled
	}

	const texts: NonNullable<MessageSettingsPatch['texts']> = []
	for (const [kind, byLocale] of Object.entries(draft.notes)) {
		for (const locale of MESSAGE_LOCALES) {
			const next = byLocale[locale].trim()
			const before = (base.notes[kind]?.[locale] ?? '').trim()
			if (next !== before) texts.push({ kind, locale, customNote: next })
		}
	}

	const hasMessaging = Object.keys(messaging).length > 0
	if (!hasMessaging && texts.length === 0) return null
	return {
		expectedVersion,
		...(hasMessaging ? { messaging } : {}),
		...(texts.length > 0 ? { texts } : {}),
	}
}

/**
 * Carries unsaved edits onto a newer saved copy: a field the operator changed
 * keeps the draft value, every other field takes the newer saved value. Without
 * this, a conflict reload would make someone else's changes look like edits of
 * ours and a save would revert them.
 */
export function rebaseDraft(
	draft: MessageDraft,
	oldBase: MessageDraft,
	newBase: MessageDraft,
): MessageDraft {
	const kinds: Record<string, boolean> = { ...newBase.kinds }
	for (const [kind, enabled] of Object.entries(draft.kinds)) {
		if (enabled !== oldBase.kinds[kind]) kinds[kind] = enabled
	}
	const notes: MessageDraft['notes'] = {}
	for (const [kind, byLocale] of Object.entries(newBase.notes)) {
		notes[kind] = { ...byLocale }
	}
	for (const [kind, byLocale] of Object.entries(draft.notes)) {
		for (const locale of MESSAGE_LOCALES) {
			if (byLocale[locale] !== (oldBase.notes[kind]?.[locale] ?? '')) {
				notes[kind] = {
					en: notes[kind]?.en ?? '',
					ar: notes[kind]?.ar ?? '',
					[locale]: byLocale[locale],
				}
			}
		}
	}
	const quietChanged =
		draft.quietEnabled !== oldBase.quietEnabled ||
		draft.quietStart !== oldBase.quietStart ||
		draft.quietEnd !== oldBase.quietEnd
	return {
		kinds,
		notes,
		reminderHours:
			draft.reminderHours !== oldBase.reminderHours
				? draft.reminderHours
				: newBase.reminderHours,
		reconfirmHours:
			draft.reconfirmHours !== oldBase.reconfirmHours
				? draft.reconfirmHours
				: newBase.reconfirmHours,
		smsEnabled:
			draft.smsEnabled !== oldBase.smsEnabled
				? draft.smsEnabled
				: newBase.smsEnabled,
		quietEnabled: quietChanged ? draft.quietEnabled : newBase.quietEnabled,
		quietStart: quietChanged ? draft.quietStart : newBase.quietStart,
		quietEnd: quietChanged ? draft.quietEnd : newBase.quietEnd,
	}
}

/** Kinds shown on screen: waitlist kinds only when the waitlist module is on. */
export function visibleKinds(
	settings: MessageSettings,
	waitlistEnabled: boolean,
): MessageSettings['kinds'] {
	return settings.kinds.filter(
		(entry) =>
			waitlistEnabled ||
			!(entry.waitlist || WAITLIST_MESSAGE_SETTING_KINDS.has(entry.kind)),
	)
}
