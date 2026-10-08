import { z } from 'zod'
import {
	AFTER_HOURS_MODES,
	AUTO_RESOLVE_DAYS,
	DEFINITION_ID_PATTERN,
	NOTIFICATION_EVENTS,
	RECORDING_RETENTION_DAYS,
	SUPPORTED_AGENT_LANGUAGES,
	TRAINING_RULE_PRIORITIES,
	TRANSFER_HOURS_MODES,
} from './constants.ts'
import { FAQ_MAX_ENTRIES, FaqEntrySchema } from './faq.ts'
import { isUsOrCanadaNumber } from './nanp.ts'
import { PhraseOverridesSchema } from './phrases.ts'

const E164 = /^\+[1-9]\d{7,14}$/

export const E164Schema = z
	.string()
	.trim()
	.regex(E164, 'Use international format, for example +15551234567')

const LocalIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9_]{1,60}$/u)

export const PronunciationSchema = z.object({
	term: z.string().trim().min(1).max(60),
	/** Phonetic spelling the voice reads instead, e.g. "win" for Nguyen. */
	sayAs: z.string().trim().min(1).max(120),
})
export type Pronunciation = z.infer<typeof PronunciationSchema>

export const ContactSchema = z.object({
	id: LocalIdSchema,
	name: z.string().trim().min(1).max(80),
	phone: E164Schema,
	role: z.string().trim().max(80).optional().nullable(),
})
export type PhoneAgentContact = z.infer<typeof ContactSchema>

export const TransferCaseSchema = z.object({
	id: LocalIdSchema,
	contactId: LocalIdSchema,
	/** When the AI should use this case, e.g. "Billing questions". */
	when: z.string().trim().min(1).max(300),
	hours: z.enum(TRANSFER_HOURS_MODES),
	/** Extra dial attempts after the first one goes unanswered. */
	retries: z.number().int().min(0).max(2),
	isActive: z.boolean(),
})
export type TransferCase = z.infer<typeof TransferCaseSchema>

export const CallTagSchema = z.object({
	id: LocalIdSchema,
	name: z.string().trim().min(1).max(40),
	/** Tells the AI when to apply the tag automatically. */
	description: z.string().trim().max(200),
	autoApply: z.boolean(),
	/** Calls with this tag are never auto-resolved. */
	important: z.boolean(),
})
export type CallTag = z.infer<typeof CallTagSchema>

export const PhoneAgentNotificationsSchema = z.object({
	smsNumbers: z.array(E164Schema).max(4),
	emails: z.array(z.string().trim().email().max(254)).max(5),
	events: z.array(z.enum(NOTIFICATION_EVENTS)).max(NOTIFICATION_EVENTS.length),
	/** Adds an App link to the call in each notification. */
	includeCallLink: z.boolean(),
})

export const PhoneAgentTransferSettingsSchema = z.object({
	/** When general transfers are allowed; transfer cases set their own. */
	hours: z.enum(TRANSFER_HOURS_MODES),
	/** Callers can press 0 at any point to reach staff. */
	pressZeroForStaff: z.boolean(),
	/** Ask before transferring whether we may text the caller if nobody answers. */
	offerTextWhenNoAnswer: z.boolean(),
	ringTimeoutSeconds: z.number().int().min(10).max(60),
})

export const PhoneAgentSafetySchema = z.object({
	/** Pass every call straight to the business line. */
	callingDisabled: z.boolean(),
	transfersDisabled: z.boolean(),
})

export const PhoneAgentFollowUpSchema = z.object({
	/** 0 keeps calls open until someone marks them complete. */
	autoResolveAfterDays: z
		.number()
		.int()
		.refine(
			(value) => (AUTO_RESOLVE_DAYS as readonly number[]).includes(value),
			'Choose 0, 3, 7, or 14 days',
		),
	/** Keep transferred calls open for manual follow-up. */
	keepTransferredOpen: z.boolean(),
})

const TimeSchema = z
	.string()
	.trim()
	.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Use 24-hour time, for example 09:30')

const ScheduleSlotSchema = z.object({ start: TimeSchema, end: TimeSchema })

export const ScheduleDaySchema = z.object({
	day: z.enum([
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	]),
	isOpen: z.boolean(),
	slots: z.array(ScheduleSlotSchema).max(6),
})

export const SpecialHoursSchema = z.object({
	date: z
		.string()
		.trim()
		.regex(/^\d{4}-\d{2}-\d{2}$/u),
	isOpen: z.boolean(),
	slots: z.array(ScheduleSlotSchema).max(6),
	note: z.string().trim().max(120).optional(),
})

/**
 * Business details for verticals without their own source of hours. The
 * open/closed check, transfer hours, and the prompt's business details use
 * them. Empty hours mean always open.
 */
export const BusinessProfileSettingsSchema = z.object({
	timezone: z.string().trim().min(1).max(64),
	phone: E164Schema.nullable(),
	address: z.string().trim().max(300).nullable(),
	hours: z.array(ScheduleDaySchema).max(7),
	specialHours: z.array(SpecialHoursSchema).max(60),
})
export type BusinessProfileSettings = z.infer<
	typeof BusinessProfileSettingsSchema
>

export const DEFAULT_BUSINESS_PROFILE: BusinessProfileSettings = {
	timezone: 'America/New_York',
	phone: null,
	address: null,
	hours: [],
	specialHours: [],
}

export const DEFAULT_NOTIFICATIONS: z.infer<
	typeof PhoneAgentNotificationsSchema
> = {
	smsNumbers: [],
	emails: [],
	events: ['voicemail', 'callback_request', 'transfer_no_answer', 'complaint'],
	includeCallLink: true,
}
export const DEFAULT_TRANSFER_SETTINGS: z.infer<
	typeof PhoneAgentTransferSettingsSchema
> = {
	hours: 'business_hours',
	pressZeroForStaff: true,
	offerTextWhenNoAnswer: true,
	ringTimeoutSeconds: 25,
}
export const DEFAULT_SAFETY: z.infer<typeof PhoneAgentSafetySchema> = {
	callingDisabled: false,
	transfersDisabled: false,
}
export const DEFAULT_FOLLOW_UP: z.infer<typeof PhoneAgentFollowUpSchema> = {
	autoResolveAfterDays: 7,
	keepTransferredOpen: false,
}
export const DEFAULT_CALL_TAGS: CallTag[] = [
	{
		id: 'vip',
		name: 'VIP',
		description: 'The caller is a regular or mentions being a VIP.',
		autoApply: false,
		important: false,
	},
	{
		id: 'complaint',
		name: 'Complaint',
		description: 'The caller is unhappy or reports a problem.',
		autoApply: true,
		important: true,
	},
]

export const PhoneAgentSettingsSchema = z.object({
	enabled: z.boolean(),
	agentName: z.string().trim().min(1).max(60),
	languages: z
		.array(z.enum(SUPPORTED_AGENT_LANGUAGES))
		.min(1)
		.max(SUPPORTED_AGENT_LANGUAGES.length),
	voiceId: z.string().trim().max(120).optional().nullable(),
	greeting: z.string().trim().min(1).max(400),
	closing: z.string().trim().min(1).max(300),
	recordCalls: z.boolean(),
	recordingRetentionDays: z
		.number()
		.int()
		.refine(
			(value) =>
				(RECORDING_RETENTION_DAYS as readonly number[]).includes(value),
			'Choose 30, 90, or 365 days',
		),
	autoEscalate: z.boolean(),
	escalationPhone: E164Schema.optional().nullable(),
	afterHoursMode: z.enum(AFTER_HOURS_MODES),
	maxCallMinutes: z.number().int().min(2).max(30),
	// Fields below were added later; defaults let older saved settings parse.
	faq: z.array(FaqEntrySchema).max(FAQ_MAX_ENTRIES).default([]),
	pronunciations: z.array(PronunciationSchema).max(100).default([]),
	/** Words speech recognition should listen for, like product names. */
	keyterms: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
	phrases: PhraseOverridesSchema.default([]),
	contacts: z.array(ContactSchema).max(20).default([]),
	transferCases: z.array(TransferCaseSchema).max(20).default([]),
	transfers: PhoneAgentTransferSettingsSchema.default(
		DEFAULT_TRANSFER_SETTINGS,
	),
	notifications: PhoneAgentNotificationsSchema.default(DEFAULT_NOTIFICATIONS),
	safety: PhoneAgentSafetySchema.default(DEFAULT_SAFETY),
	tags: z.array(CallTagSchema).max(30).default(DEFAULT_CALL_TAGS),
	followUp: PhoneAgentFollowUpSchema.default(DEFAULT_FOLLOW_UP),
	/** Ask callers to rate the call from 1 to 5 before it ends. */
	csatEnabled: z.boolean().default(false),
	/** Hours and contact details for verticals that don't supply their own. */
	business: BusinessProfileSettingsSchema.default(DEFAULT_BUSINESS_PROFILE),
	/** Settings owned by the vertical, parsed by its own schema. */
	vertical: z.record(z.string(), z.unknown()).default({}),
})
export type PhoneAgentSettings = z.infer<typeof PhoneAgentSettingsSchema>

export const DEFAULT_PHONE_AGENT_SETTINGS: PhoneAgentSettings = {
	enabled: false,
	agentName: 'Assistant',
	languages: ['en'],
	voiceId: null,
	greeting: 'Thanks for calling. How can I help you today?',
	closing: 'Thanks for calling. Have a great day!',
	recordCalls: false,
	recordingRetentionDays: 90,
	autoEscalate: true,
	escalationPhone: null,
	afterHoursMode: 'answer_and_link',
	maxCallMinutes: 10,
	faq: [],
	pronunciations: [],
	keyterms: [],
	phrases: [],
	contacts: [],
	transferCases: [],
	transfers: DEFAULT_TRANSFER_SETTINGS,
	notifications: DEFAULT_NOTIFICATIONS,
	safety: DEFAULT_SAFETY,
	tags: DEFAULT_CALL_TAGS,
	followUp: DEFAULT_FOLLOW_UP,
	csatEnabled: false,
	business: DEFAULT_BUSINESS_PROFILE,
	vertical: {},
}

export const TrainingRuleInputSchema = z.object({
	/** Checked against the vertical's categories with `trainingRuleCategorySchema`. */
	category: z.string().trim().regex(DEFINITION_ID_PATTERN),
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().min(1).max(1000),
	priority: z.enum(TRAINING_RULE_PRIORITIES),
	isActive: z.boolean(),
	scopeId: z.string().trim().min(1).max(64).optional().nullable(),
})
export type TrainingRuleInput = z.infer<typeof TrainingRuleInputSchema>

/**
 * Field paths (e.g. `contacts.0.phone`) of numbers the agent may dial or text
 * that are outside the US and Canada, which would bill international rates.
 * This is a save-time check, not part of the schema, so settings stored before
 * it still load; the voice agent separately refuses to dial such numbers.
 */
export function unsupportedPhoneFields(
	settings: Pick<
		PhoneAgentSettings,
		'escalationPhone' | 'contacts' | 'notifications'
	>,
) {
	const fields: string[] = []
	if (
		settings.escalationPhone &&
		!isUsOrCanadaNumber(settings.escalationPhone)
	) {
		fields.push('escalationPhone')
	}
	settings.contacts.forEach((contact, index) => {
		if (!isUsOrCanadaNumber(contact.phone))
			fields.push(`contacts.${index}.phone`)
	})
	settings.notifications.smsNumbers.forEach((phone, index) => {
		if (!isUsOrCanadaNumber(phone)) {
			fields.push(`notifications.smsNumbers.${index}`)
		}
	})
	return fields
}

/**
 * Escalating to the same line that forwards to the agent would loop the call
 * straight back into the agent.
 */
export function findTransferLoop(
	escalationPhone: string | null | undefined,
	numbers: Array<{ e164: string; forwardedFrom?: string | null }>,
) {
	if (!escalationPhone) return null
	return (
		numbers.find(
			(number) =>
				number.e164 === escalationPhone ||
				number.forwardedFrom === escalationPhone,
		) ?? null
	)
}
