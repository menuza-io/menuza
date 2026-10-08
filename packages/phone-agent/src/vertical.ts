import { z } from 'zod'
import {
	type AgentLanguage,
	type CallChannel,
	type CallOutcome,
	type CallPurpose,
	DEFINITION_ID_PATTERN,
	type NotificationEvent,
} from './constants.ts'
import {
	type Availability,
	defaultPriceFormatter,
	describeBusiness,
	type PhoneAgentRuntimeConfig,
	type PriceFormatter,
} from './config.ts'
import { BASE_FAQ_BANK, type FaqBankQuestion } from './faq.ts'
import { createDefaultFlowGraph, type FlowGraph } from './flow.ts'
import {
	type PhraseDefaultOverrides,
	type PhraseDefinition,
	phraseDefinitionsWith,
} from './phrases.ts'
import { type PromptContext } from './prompt.ts'
import { type TrainingRule } from './rules.ts'
import { type MessageVariables } from './runtime.ts'
import {
	DEFAULT_PHONE_AGENT_SETTINGS,
	type PhoneAgentSettings,
} from './settings.ts'

/** A value a vertical can add to a list: a call purpose, request type, etc. */
export type VerticalDefinition = {
	/** Stored slug; matches DEFINITION_ID_PATTERN. */
	id: string
	/** English label. Apps translate by id. */
	label: string
	description?: string
	/** Lowercase phrase for call log summaries, e.g. "callback request". */
	summaryLabel?: string
}

export const DefinitionIdSchema = z.string().trim().regex(DEFINITION_ID_PATTERN)

/** Everything a vertical hook can read about the call's business. */
export type VerticalContext<TData = unknown, TSettings = unknown> = {
	config: PhoneAgentRuntimeConfig
	/** `config.vertical.data`, parsed by the vertical. */
	data: TData
	settings: PhoneAgentSettings
	/** `settings.vertical`, parsed by the vertical's settings schema. */
	verticalSettings: TSettings
	/** Whether the business is open now (call time, not config time). */
	isOpen: boolean
	language: AgentLanguage
	formatPrice: PriceFormatter
	now: Date
}

export const SEND_LINK_FAILURES = [
	'invalid_phone',
	'no_number',
	'text_limit',
	'not_sent',
	'transfer_in_progress',
] as const
export type SendLinkFailure = (typeof SEND_LINK_FAILURES)[number]

/** Texts the caller a link that carries data from the call. */
export type SendLinkInput = {
	/** Site path the link opens, e.g. `/booking`. Must start with `/`. */
	path: string
	/** JSON the site reads back from the link. The vertical defines it. */
	payload: unknown
	/** A number the caller asked to be texted at instead of their caller ID. */
	phone?: string | null
}

export type SendLinkResult =
	| {
			ok: true
			url: string
			/** Test calls show the link on screen instead of texting it. */
			shownOnScreen: boolean
	  }
	| {
			ok: false
			reason: SendLinkFailure
			/** What to tell the caller, in plain words. */
			explanation: string
	  }

/** Services the voice worker gives vertical tools. */
export type VerticalServices = {
	sendLink(input: SendLinkInput): Promise<SendLinkResult>
}

export type VerticalToolContext<
	TData = unknown,
	TSettings = unknown,
	TState = unknown,
> = VerticalContext<TData, TSettings> & {
	/** Per-call state from `createCallState`; tools may mutate it. */
	state: TState
	channel: CallChannel
	callerPhone: string | null
	services: VerticalServices
}

/**
 * A tool the AI assistant can call, free of any agent framework. The worker
 * adapts it (e.g. to LiveKit's `llm.tool`), records `name` in the call's
 * used tools, and sends the JSON result back to the model.
 */
export type VerticalTool<
	TData = unknown,
	TSettings = unknown,
	TState = unknown,
> = {
	name: string
	description: string
	/** Omitted for tools without arguments. */
	parameters?: z.AnyZodObject
	/** Refuse a second call while one is still running. */
	rejectDuplicates?: boolean
	/** Refuse while a transfer rings, like the worker's other call-changing tools. */
	blockedDuringTransfer?: boolean
	execute(
		args: Record<string, unknown>,
		context: VerticalToolContext<TData, TSettings, TState>,
	): unknown
}

/** Types `execute`'s arguments from `parameters`. */
export function defineVerticalTool<
	TParams extends z.AnyZodObject,
	TData = unknown,
	TSettings = unknown,
	TState = unknown,
>(
	tool: Omit<
		VerticalTool<TData, TSettings, TState>,
		'execute' | 'parameters'
	> & {
		parameters?: TParams
		execute(
			args: z.infer<TParams>,
			context: VerticalToolContext<TData, TSettings, TState>,
		): unknown
	},
): VerticalTool<TData, TSettings, TState> {
	return tool as VerticalTool<TData, TSettings, TState>
}

/** What the worker knows when it labels a finished call. */
export type PurposeSignals<TState = unknown> = {
	declaredPurpose: CallPurpose | null
	/** Request types recorded on the call. */
	requests: readonly string[]
	toolsUsed: ReadonlySet<string>
	linkSent: boolean
	/** Labels of the keypad menu options the caller picked, in sequence. */
	menuChoices: readonly string[]
	state: TState
}

/** What the vertical adds to the AI assistant's system prompt. */
export type VerticalPromptContributions = {
	/**
	 * Appended to the "never ask for payment details" rule, e.g. where
	 * payment does happen.
	 */
	paymentNote?: string
	/** Extra voice and safety rules. */
	style?: string[]
	/** Replaces the line with the local time and open/closed state. */
	status?: (input: {
		localTime: string
		isOpen: boolean
		nextOpen: string | null
	}) => string
	/** Heading for the business details section. */
	detailsHeading?: string
	/** Task guidance placed before the core tasks. */
	tasks?: string[]
	/**
	 * Replaces the core guidance for questions about the business; `null`
	 * when `tasks` already covers it.
	 */
	businessQuestions?: string | null
	/** Extra sections after the saved answers. */
	sections?: string[]
	/** Replaces the core line for the after-hours mode; empty drops it. */
	afterHours?: string
	/** Heading for the training rules section. */
	rulesTitle?: string
	/** Leaves out rules for features the vertical turned off. */
	includeRule?: (rule: TrainingRule) => boolean
}

export type VerticalLinks = {
	/** Site path the `text_link` step texts. Defaults to `/`. */
	websitePath?(scopeId: string | null): string
	/** SMS text for the website link; `{business}` and `{url}` are filled. */
	websiteMessage?: string
	/** SMS text for links from `sendLink`; `{business}` and `{url}` are filled. */
	handoffMessage?: string
	/** Checks `SendLinkInput.payload` before it is stored. */
	handoffPayload?: z.ZodTypeAny
}

/**
 * Plug-in that adapts the generic phone agent to one kind of business. All
 * members are optional except `id` and `label`; without them the agent
 * behaves like `generalVertical`. Hooks are pure and framework-neutral.
 */
export type PhoneAgentVertical<
	TData = unknown,
	TSettings = unknown,
	TState = unknown,
> = {
	id: string
	label: string
	/**
	 * Present when the vertical narrows numbers, rules, and saved answers to
	 * a scope (`scopeId`), with the names the UI shows for it.
	 */
	scope?: { label: string; pluralLabel: string }

	callPurposes?: readonly VerticalDefinition[]
	callRequestTypes?: readonly VerticalDefinition[]
	trainingRuleCategories?: readonly VerticalDefinition[]
	faqCategories?: readonly VerticalDefinition[]
	faqQuestions?: readonly FaqBankQuestion[]
	phraseDefaults?: PhraseDefaultOverrides
	notificationHeadlines?: Partial<Record<NotificationEvent, string>>
	outcomeSummaries?: Partial<Record<CallOutcome, string>>

	/** Settings stored under `settings.vertical`. */
	settings?: {
		schema: z.ZodType<TSettings, z.ZodTypeDef, unknown>
		defaults: TSettings
	}
	/** Core settings a new organization of this vertical starts with. */
	defaultSettings?: Partial<Omit<PhoneAgentSettings, 'vertical'>>
	/** Parses `config.vertical.data`. */
	data?: { parse(value: unknown): TData }

	defaultFlow?(): FlowGraph
	links?: VerticalLinks

	scopeName?(context: VerticalContext<TData, TSettings>): string | null
	/** Business facts for the prompt. Defaults to `describeBusiness`. */
	businessDetails?(context: VerticalContext<TData, TSettings>): string
	messageVariables?(
		context: VerticalContext<TData, TSettings>,
	): Record<string, string>
	keyterms?(context: VerticalContext<TData, TSettings>): string[]
	prompt?(
		context: VerticalContext<TData, TSettings>,
	): VerticalPromptContributions
	tools?(
		context: VerticalContext<TData, TSettings>,
	): VerticalTool<TData, TSettings, TState>[]
	createCallState?(): TState
	/**
	 * Availability (and refreshed data) at `now`, for configs built earlier.
	 * Null falls back to the business hours in `config.business`.
	 */
	currentAvailability?(
		config: PhoneAgentRuntimeConfig,
		now: Date,
	): { availability: Availability; data: unknown } | null

	/** Purpose from what happened on the call, before core's own guesses. */
	classifyPurpose?(signals: PurposeSignals<TState>): CallPurpose | null
	/** Purpose suggested by a keypad option label or other caller text. */
	inferPurpose?(text: string): CallPurpose | null
	/** Extra sentences for the call log summary. */
	summarizeCall?(input: {
		state: TState
		formatPrice: PriceFormatter
	}): string[]
}

export const BASE_CALL_PURPOSE_DEFINITIONS: readonly VerticalDefinition[] = [
	{
		id: 'business_information',
		label: 'Business info',
		description: 'Hours, address, and other facts about the business.',
	},
	{ id: 'other', label: 'Other' },
]

export const BASE_CALL_REQUEST_TYPE_DEFINITIONS: readonly VerticalDefinition[] =
	[
		{ id: 'callback', label: 'Callback', summaryLabel: 'callback request' },
		{ id: 'complaint', label: 'Complaint', summaryLabel: 'complaint' },
	]

export const BASE_TRAINING_RULE_CATEGORY_DEFINITIONS: readonly VerticalDefinition[] =
	[
		{
			id: 'escalation',
			label: 'Escalation',
			description: 'When to transfer a call or take a message for staff.',
		},
		{
			id: 'error_handling',
			label: 'Error handling',
			description: "What to do when the agent mishears or can't help.",
		},
	]

export const BASE_FAQ_CATEGORY_DEFINITIONS: readonly VerticalDefinition[] = [
	{ id: 'general', label: 'General' },
	{ id: 'policies', label: 'Policies' },
	{ id: 'custom', label: 'Your questions' },
]

/**
 * The vertical's entries first, in its sequence, then base entries it didn't
 * list. Reusing a base id moves (and may relabel) that entry.
 */
export function mergeDefinitions<T extends { id: string }>(
	base: readonly T[],
	extras: readonly T[] = [],
): T[] {
	const extraIds = new Set(extras.map((entry) => entry.id))
	return [...extras, ...base.filter((entry) => !extraIds.has(entry.id))]
}

type VerticalLike = Pick<
	PhoneAgentVertical,
	| 'callPurposes'
	| 'callRequestTypes'
	| 'trainingRuleCategories'
	| 'faqCategories'
	| 'faqQuestions'
>

export function callPurposesFor(vertical?: VerticalLike | null) {
	return mergeDefinitions(BASE_CALL_PURPOSE_DEFINITIONS, vertical?.callPurposes)
}
export function callRequestTypesFor(vertical?: VerticalLike | null) {
	return mergeDefinitions(
		BASE_CALL_REQUEST_TYPE_DEFINITIONS,
		vertical?.callRequestTypes,
	)
}
export function trainingRuleCategoriesFor(vertical?: VerticalLike | null) {
	return mergeDefinitions(
		BASE_TRAINING_RULE_CATEGORY_DEFINITIONS,
		vertical?.trainingRuleCategories,
	)
}
export function faqCategoriesFor(vertical?: VerticalLike | null) {
	return mergeDefinitions(
		BASE_FAQ_CATEGORY_DEFINITIONS,
		vertical?.faqCategories,
	)
}
export function faqBankFor(vertical?: VerticalLike | null) {
	return mergeDefinitions(BASE_FAQ_BANK, vertical?.faqQuestions)
}

function ids(definitions: readonly { id: string }[]) {
	return definitions.map((definition) => definition.id)
}
export const callPurposeIds = (vertical?: VerticalLike | null) =>
	ids(callPurposesFor(vertical))
export const callRequestTypeIds = (vertical?: VerticalLike | null) =>
	ids(callRequestTypesFor(vertical))
export const trainingRuleCategoryIds = (vertical?: VerticalLike | null) =>
	ids(trainingRuleCategoriesFor(vertical))
export const faqCategoryIds = (vertical?: VerticalLike | null) =>
	ids(faqCategoriesFor(vertical))

/** A zod string limited to the given ids, e.g. `callPurposeIds(vertical)`. */
export function definitionIdSchema(allowed: readonly string[]) {
	const set = new Set(allowed)
	return DefinitionIdSchema.refine((id) => set.has(id), {
		message: 'Choose one of the listed options',
	})
}
export const callPurposeSchema = (vertical?: VerticalLike | null) =>
	definitionIdSchema(callPurposeIds(vertical))
export const callRequestTypeSchema = (vertical?: VerticalLike | null) =>
	definitionIdSchema(callRequestTypeIds(vertical))
export const trainingRuleCategorySchema = (vertical?: VerticalLike | null) =>
	definitionIdSchema(trainingRuleCategoryIds(vertical))
export const faqCategorySchema = (vertical?: VerticalLike | null) =>
	definitionIdSchema(faqCategoryIds(vertical))

export function phraseDefinitionsFor(
	vertical?: Pick<PhoneAgentVertical, 'phraseDefaults'> | null,
): PhraseDefinition[] {
	return phraseDefinitionsWith(vertical?.phraseDefaults)
}

export function defaultFlowFor(
	vertical?: Pick<PhoneAgentVertical, 'defaultFlow'> | null,
): FlowGraph {
	return vertical?.defaultFlow?.() ?? createDefaultFlowGraph()
}

/** Core defaults with the vertical's overrides and its own default settings. */
export function defaultSettingsFor(
	vertical?: Pick<PhoneAgentVertical, 'defaultSettings' | 'settings'> | null,
): PhoneAgentSettings {
	return {
		...DEFAULT_PHONE_AGENT_SETTINGS,
		...vertical?.defaultSettings,
		vertical: vertical?.settings
			? (structuredClone(vertical.settings.defaults) as Record<string, unknown>)
			: {},
	}
}

/**
 * `settings.vertical` parsed by the vertical. Values saved for another
 * vertical (or before a field existed) fall back to its defaults.
 */
export function verticalSettingsOf<TSettings>(
	vertical: Pick<PhoneAgentVertical<unknown, TSettings>, 'settings'>,
	settings: Pick<PhoneAgentSettings, 'vertical'>,
): TSettings {
	if (!vertical.settings) return undefined as TSettings
	const parsed = vertical.settings.schema.safeParse(settings.vertical ?? {})
	return parsed.success ? parsed.data : vertical.settings.defaults
}

export function createVerticalContext<TData, TSettings>(
	vertical: PhoneAgentVertical<TData, TSettings, unknown>,
	config: PhoneAgentRuntimeConfig,
	options: {
		language?: AgentLanguage
		formatPrice?: PriceFormatter
		now?: Date
		isOpen?: boolean
	} = {},
): VerticalContext<TData, TSettings> {
	if (config.vertical.id !== vertical.id) {
		throw new Error(
			`Config was built for the "${config.vertical.id}" vertical, not "${vertical.id}"`,
		)
	}
	return {
		config,
		data: vertical.data
			? vertical.data.parse(config.vertical.data)
			: (config.vertical.data as TData),
		settings: config.settings,
		verticalSettings: verticalSettingsOf(vertical, config.settings),
		isOpen: options.isOpen ?? config.availability.isOpen,
		language: options.language ?? config.settings.languages[0] ?? 'en',
		formatPrice: options.formatPrice ?? defaultPriceFormatter,
		now: options.now ?? new Date(),
	}
}

/** `{business}` plus the vertical's placeholders. */
export function messageVariablesFor<TData, TSettings>(
	vertical: PhoneAgentVertical<TData, TSettings, unknown>,
	context: VerticalContext<TData, TSettings>,
): MessageVariables {
	return {
		...vertical.messageVariables?.(context),
		business: context.config.business.name,
	}
}

/** Prompt input for the AI assistant step, with the vertical's additions. */
export function promptContextFor<TData, TSettings>(
	vertical: PhoneAgentVertical<TData, TSettings, unknown>,
	context: VerticalContext<TData, TSettings>,
	call: Pick<
		PromptContext,
		| 'transfersAvailable'
		| 'availableTransferCaseIds'
		| 'menuChoice'
		| 'knowledgeCharBudget'
	> = {},
): PromptContext {
	const { config } = context
	return {
		businessName: config.business.name,
		scopeName: vertical.scopeName?.(context) ?? null,
		scopeId: config.scopeId,
		settings: context.settings,
		rules: config.rules,
		isOpen: context.isOpen,
		nextOpen: config.availability.nextOpen,
		businessDetails:
			vertical.businessDetails?.(context) ??
			describeBusiness(config.business, context.now),
		now: context.now,
		timezone: config.business.timezone,
		ruleCategories: trainingRuleCategoriesFor(vertical),
		vertical: vertical.prompt?.(context),
		...call,
	}
}

/** Speech recognition terms the vertical adds (e.g. product names). */
export function verticalKeyterms<TData, TSettings>(
	vertical: PhoneAgentVertical<TData, TSettings, unknown>,
	context: VerticalContext<TData, TSettings>,
) {
	return vertical.keyterms?.(context) ?? []
}

const BASE_CHOICE_PURPOSES: Array<[RegExp, CallPurpose]> = [
	[/hour|address|direction|open/i, 'business_information'],
]

/**
 * The model's own label wins; then the vertical's reading of the call; then
 * business questions; then the keypad options picked, which come last because
 * callers often change their mind with the AI.
 */
export function classifyCallPurpose<TState>(
	vertical: Pick<
		PhoneAgentVertical<unknown, unknown, TState>,
		'classifyPurpose' | 'inferPurpose'
	> | null,
	signals: PurposeSignals<TState>,
): CallPurpose {
	if (signals.declaredPurpose) return signals.declaredPurpose
	const fromVertical = vertical?.classifyPurpose?.(signals)
	if (fromVertical) return fromVertical
	if (signals.toolsUsed.has('get_business_info')) return 'business_information'
	for (const choice of signals.menuChoices) {
		const inferred =
			vertical?.inferPurpose?.(choice) ??
			BASE_CHOICE_PURPOSES.find(([pattern]) => pattern.test(choice))?.[1]
		if (inferred) return inferred
	}
	return 'other'
}

export const DEFAULT_WEBSITE_LINK_MESSAGE =
	'{business}: visit us online here: {url}'
export const DEFAULT_HANDOFF_LINK_MESSAGE =
	"{business}: here's the link from our call: {url}"

export function websitePathFor(
	vertical: Pick<PhoneAgentVertical, 'links'> | null | undefined,
	scopeId: string | null,
) {
	return vertical?.links?.websitePath?.(scopeId) ?? '/'
}

/** The SMS body for a texted link. */
export function linkMessageFor(
	vertical: Pick<PhoneAgentVertical, 'links'> | null | undefined,
	kind: 'website' | 'handoff',
	values: { business: string; url: string },
) {
	const template =
		kind === 'website'
			? (vertical?.links?.websiteMessage ?? DEFAULT_WEBSITE_LINK_MESSAGE)
			: (vertical?.links?.handoffMessage ?? DEFAULT_HANDOFF_LINK_MESSAGE)
	return template
		.replace(/\{business\}/g, values.business)
		.replace(/\{url\}/g, values.url)
}

/** Largest JSON payload a link may carry. */
export const LINK_PAYLOAD_MAX_BYTES = 32_000

export const SitePathSchema = z
	.string()
	.max(500)
	.regex(/^\/(?!\/)[^\s#]*$/u, 'Use a site path that starts with /')

/** What gets stored for a texted link, before the vertical checks `payload`. */
export const LinkHandoffSchema = z.object({
	path: SitePathSchema,
	payload: z
		.unknown()
		.refine(
			(value) =>
				value !== undefined &&
				new TextEncoder().encode(JSON.stringify(value)).length <=
					LINK_PAYLOAD_MAX_BYTES,
			'The link data is missing or too large',
		),
})
export type LinkHandoff = z.infer<typeof LinkHandoffSchema>

/**
 * The neutral vertical: no scopes, base lists only, the core default call
 * flow, and hours from `settings.business`.
 */
export const generalVertical: PhoneAgentVertical = {
	id: 'general',
	label: 'General business',
	trainingRuleCategories: [
		{
			id: 'general',
			label: 'General',
			description: 'How to talk about your business and what to offer.',
		},
	],
}
