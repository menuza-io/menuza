/**
 * Ids for definitions a vertical can extend (call purposes, request types,
 * training rule categories, FAQ categories). They are stored as plain text, so
 * this pattern is the only check the database layer gets.
 */
export const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u

/** Purposes every vertical has. A vertical adds its own with `callPurposes`. */
export const BASE_CALL_PURPOSES = ['business_information', 'other'] as const
/** One of `callPurposeIds(vertical)`. */
export type CallPurpose = string

export const CALL_OUTCOMES = [
	'resolved',
	'link_sent',
	'escalated',
	'message_taken',
	'abandoned',
	'failed',
] as const
export type CallOutcome = (typeof CALL_OUTCOMES)[number]

export const CALL_CHANNELS = ['phone', 'web_test'] as const
export type CallChannel = (typeof CALL_CHANNELS)[number]

/** Request types every vertical has. A vertical adds its own with `callRequestTypes`. */
export const BASE_CALL_REQUEST_TYPES = ['callback', 'complaint'] as const
/** One of `callRequestTypeIds(vertical)`. */
export type CallRequestType = string

export const CALL_REQUEST_STATUSES = ['open', 'done'] as const
export type CallRequestStatus = (typeof CALL_REQUEST_STATUSES)[number]

/** Categories every vertical has. A vertical adds its own with `trainingRuleCategories`. */
export const BASE_TRAINING_RULE_CATEGORIES = [
	'escalation',
	'error_handling',
] as const
/** One of `trainingRuleCategoryIds(vertical)`. */
export type TrainingRuleCategory = string

export const TRAINING_RULE_PRIORITIES = ['high', 'medium', 'low'] as const
export type TrainingRulePriority = (typeof TRAINING_RULE_PRIORITIES)[number]

export const PHONE_NUMBER_MODES = ['forwarding', 'dedicated'] as const
export type PhoneNumberMode = (typeof PHONE_NUMBER_MODES)[number]

/**
 * `answer_and_link`: answer questions and keep texting links after hours.
 * `answer_only`: answer questions only. `take_message`: take a message.
 */
export const AFTER_HOURS_MODES = [
	'answer_and_link',
	'answer_only',
	'take_message',
] as const
export type AfterHoursMode = (typeof AFTER_HOURS_MODES)[number]

export const RECORDING_RETENTION_DAYS = [30, 90, 365] as const

export const TRANSFER_HOURS_MODES = ['always', 'business_hours'] as const
export type TransferHoursMode = (typeof TRANSFER_HOURS_MODES)[number]

/** Call events that can notify staff by text or email. */
export const NOTIFICATION_EVENTS = [
	'every_call',
	'voicemail',
	'callback_request',
	'link_sent',
	'transfer_no_answer',
	'complaint',
	'low_rating',
	'important_tag',
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export const AUTO_RESOLVE_DAYS = [0, 3, 7, 14] as const

/** Whether a call still needs someone on the team to act on it. */
export const CALL_FOLLOW_UP_STATUSES = ['open', 'resolved'] as const
export type CallFollowUpStatus = (typeof CALL_FOLLOW_UP_STATUSES)[number]

export const CALL_SENTIMENTS = ['positive', 'neutral', 'negative'] as const
export type CallSentiment = (typeof CALL_SENTIMENTS)[number]

export const SUPPORTED_AGENT_LANGUAGES = ['en', 'es', 'ar'] as const
export type AgentLanguage = (typeof SUPPORTED_AGENT_LANGUAGES)[number]

/** LiveKit agent name used for explicit dispatch from SIP rules and test rooms. */
export const PHONE_AGENT_DISPATCH_NAME = 'phone-agent'

/** Links texted with data from the call expire after this long. */
export const LINK_HANDOFF_TTL_HOURS = 24
