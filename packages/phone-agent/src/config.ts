import { type AgentLanguage } from './constants.ts'
import { type FlowGraph } from './flow.ts'
import { type TrainingRule } from './rules.ts'
import { type PhoneAgentSettings } from './settings.ts'

export type ScheduleSlot = { start: string; end: string }

/** One weekday. `day` is the lowercase English name, e.g. `monday`. */
export type ScheduleDay = {
	day: string
	isOpen: boolean
	slots: ScheduleSlot[]
}

/** A dated exception to the weekly hours. `date` is `YYYY-MM-DD`. */
export type SpecialHours = {
	date: string
	isOpen: boolean
	slots: ScheduleSlot[]
	note?: string
}

/**
 * The business facts the agent may quote and the hours it follows for the
 * open/closed check and transfer hours.
 */
export type BusinessProfile = {
	name: string
	phone: string | null
	timezone: string
	address: string | null
	hours: ScheduleDay[]
	specialHours: SpecialHours[]
}

export type Availability = {
	isOpen: boolean
	/** Spoken hint such as "Opens today at 9:00 AM", or null. */
	nextOpen: string | null
}

export type PriceFormatter = (amount: number) => string

export const defaultPriceFormatter: PriceFormatter = (amount) =>
	`$${amount.toFixed(2)}`

/** What App returns to the voice worker for one call. Contains no caller data. */
export type PhoneAgentRuntimeConfig = {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
	}
	/**
	 * Optional id that narrows numbers, rules, and saved answers within the
	 * organization. Its meaning belongs to the vertical; null when unused.
	 */
	scopeId: string | null
	business: BusinessProfile
	/** Availability when the config was built (call start). */
	availability: Availability
	settings: PhoneAgentSettings
	flow: { versionId: string | null; graph: FlowGraph }
	rules: TrainingRule[]
	/**
	 * Where to send the caller when the agent cannot handle the call: the
	 * business phone, else the escalation phone. Never a number that reaches
	 * the agent (see `agentLines`). Null when none is known.
	 */
	fallbackPhone: string | null
	/** App page listing this org's calls, linked from staff alerts. */
	callsUrl: string | null
	/**
	 * Every E.164 number that reaches this org's agent: its agent numbers and
	 * the business lines forwarded to them. The worker never dials these and
	 * hangs up on calls whose caller ID is one of them (a transfer loop).
	 */
	agentLines: string[]
	/** The vertical that built `data`; `data` is parsed by that vertical. */
	vertical: { id: string; data: unknown }
}

/**
 * App's answer for a phone-number lookup when the agent must not take the
 * call (turned off or calling disabled). The worker plays `message` if set,
 * then transfers to `phone`, or apologizes and hangs up when it is null.
 */
export type PhoneAgentPassthrough = {
	passthrough: true
	error: string
	phone: string | null
	message: string | null
	/** The agent's primary language and voice, for speaking `message`. */
	language: AgentLanguage
	voiceId: string | null
	/** Same as `PhoneAgentRuntimeConfig.agentLines`. */
	agentLines: string[]
}

/** Dispatch metadata App attaches to browser test rooms. */
export type TestCallMetadata = {
	channel: 'web_test'
	orgId: string
	scopeId: string | null
	flow: 'draft' | 'published'
}

/** "13:30" as "1:30pm"; "09:00" as "9am". */
export function formatClockTime(value: string) {
	const [hourText, minute = '00'] = value.split(':')
	const hour = Number(hourText)
	if (!Number.isFinite(hour)) return value
	const suffix = hour >= 12 ? 'pm' : 'am'
	const display = hour % 12 === 0 ? 12 : hour % 12
	return minute === '00'
		? `${display}${suffix}`
		: `${display}:${minute}${suffix}`
}

function describeSlots(slots: readonly ScheduleSlot[]) {
	return slots
		.map(
			(slot) =>
				`${formatClockTime(slot.start)} to ${formatClockTime(slot.end)}`,
		)
		.join(', ')
}

export function describeScheduleDay(day: ScheduleDay) {
	const name = day.day.charAt(0).toUpperCase() + day.day.slice(1)
	if (!day.isOpen || day.slots.length === 0) return `${name}: closed`
	return `${name}: ${describeSlots(day.slots)}`
}

/** `YYYY-MM-DD` in the timezone, falling back to UTC for unknown zones. */
export function localDate(timezone: string, now: Date) {
	const format = (timeZone: string) =>
		new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(now)
	try {
		return format(timezone || 'UTC')
	} catch {
		return format('UTC')
	}
}

/**
 * Plain-text business facts for the prompt, so the model can answer common
 * questions without a tool round trip.
 */
export function describeBusiness(
	business: Pick<
		BusinessProfile,
		'phone' | 'timezone' | 'address' | 'hours' | 'specialHours'
	>,
	now: Date,
) {
	const lines: string[] = []
	if (business.address) lines.push(`Address: ${business.address}`)
	if (business.phone) lines.push(`Phone: ${business.phone}`)
	if (business.hours.length) {
		lines.push(`Hours:\n${business.hours.map(describeScheduleDay).join('\n')}`)
	}

	const today = localDate(business.timezone, now)
	const upcoming = business.specialHours
		.filter((special) => special.date >= today)
		.slice(0, 5)
	if (upcoming.length) {
		lines.push(
			`Special hours:\n${upcoming
				.map((special) => {
					const note = special.note ? ` (${special.note})` : ''
					return special.isOpen
						? `${special.date}: ${describeSlots(special.slots)}${note}`
						: `${special.date}: closed${note}`
				})
				.join('\n')}`,
		)
	}
	return lines.join('\n')
}

/**
 * The business profile from `settings.business`, for verticals without
 * their own source of hours and contact details.
 */
export function businessProfileFromSettings(
	name: string,
	settings: Pick<PhoneAgentSettings, 'business'>,
): BusinessProfile {
	const { business } = settings
	return {
		name,
		phone: business.phone,
		timezone: business.timezone,
		address: business.address,
		hours: business.hours,
		specialHours: business.specialHours,
	}
}
