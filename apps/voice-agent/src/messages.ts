import {
	type AgentLanguage,
	fillMessage,
	type PhraseDefaultOverrides,
	type PhraseKey,
	type PhraseOverride,
	resolvePhrase,
	SUPPORTED_AGENT_LANGUAGES,
} from '@repo/phone-agent'

export function agentLanguage(language: string | undefined): AgentLanguage {
	return (SUPPORTED_AGENT_LANGUAGES as readonly string[]).includes(
		language ?? '',
	)
		? (language as AgentLanguage)
		: 'en'
}

/** Said for `{business}` when the business name is not known. */
const UNKNOWN_BUSINESS: Record<AgentLanguage, string> = {
	en: 'the business',
	es: 'el negocio',
	ar: 'النشاط التجاري',
}

export type PhraseOptions = {
	language: string | undefined
	/** Fills `{business}`; unknown when the config could not be loaded. */
	business?: string | null
	/** Other placeholders, such as the vertical's (see `messageVariablesFor`). */
	variables?: Record<string, string>
	/** The owner's overrides; omitted on paths that run without settings. */
	overrides?: readonly PhraseOverride[]
	/** The vertical's reworded defaults (`PhoneAgentVertical.phraseDefaults`). */
	verticalDefaults?: PhraseDefaultOverrides
}

/** A fixed line in the caller's language, with the owner's wording if set. */
export function callPhrase(key: PhraseKey, options: PhraseOptions) {
	const language = agentLanguage(options.language)
	return fillMessage(
		resolvePhrase(key, language, options.overrides, options.verticalDefaults),
		{
			...options.variables,
			business: options.business?.trim() || UNKNOWN_BUSINESS[language],
		},
	)
}

// No phrase key covers this line, so owners can't reword it yet.
const CONNECTING_TO_BUSINESS: Record<AgentLanguage, string> = {
	en: "We're having trouble with our phone assistant, so let me connect you with our team.",
	es: 'Tenemos problemas con nuestro asistente telefónico, así que le comunico con nuestro equipo.',
	ar: 'نواجه مشكلة في المساعد الهاتفي، لذا سأحولك إلى فريقنا.',
}

export function connectingToBusiness(language: string | undefined) {
	return CONNECTING_TO_BUSINESS[agentLanguage(language)]
}

// Heard by staff calling from the business phone, so owners can't reword it either.
const BUSINESS_LINE: Record<AgentLanguage, string> = {
	en: "This line forwards to our assistant, so it can't take calls from our own number. Goodbye.",
	es: 'Esta línea se desvía a nuestro asistente, así que no puede recibir llamadas desde nuestro propio número. Adiós.',
	ar: 'هذا الخط محوَّل إلى مساعدنا، لذا لا يمكنه استقبال المكالمات من رقمنا نفسه. مع السلامة.',
}

/** Played before hanging up on a call from a business line that forwards to the agent. */
export function businessLineNotice(language: string | undefined) {
	return BUSINESS_LINE[agentLanguage(language)]
}

/**
 * Fixed lines owners can't reword: the AI assistant's self-introduction
 * (its "AI assistant" wording is the bot disclosure when the notice didn't
 * play) and lines only the business's team hears on browser test calls.
 */
const CALL_LINES = {
	ai_intro: {
		en: "Hi, you've reached {business}. I'm {agent}, an AI assistant.",
		es: 'Hola, se ha comunicado con {business}. Soy {agent}, un asistente de inteligencia artificial.',
		ar: 'مرحبًا، لقد وصلت إلى {business}. أنا {agent}، مساعد ذكاء اصطناعي.',
	},
	ai_name: {
		en: "I'm {agent}.",
		es: 'Soy {agent}.',
		ar: 'أنا {agent}.',
	},
	ai_help: {
		en: 'How can I help you today?',
		es: '¿En qué le puedo ayudar hoy?',
		ar: 'كيف يمكنني مساعدتك اليوم؟',
	},
	test_link_on_screen: {
		en: 'This is a test call, so the link is on your screen instead.',
		es: 'Esta es una llamada de prueba, así que el enlace aparece en su pantalla.',
		ar: 'هذه مكالمة تجريبية، لذا يظهر الرابط على شاشتك بدلًا من ذلك.',
	},
	test_transfer: {
		en: "This is a test call, so instead of connecting you to {phone}, I'll continue as if nobody answered.",
		es: 'Esta es una llamada de prueba, así que en lugar de comunicarle con {phone}, continuaré como si nadie hubiera contestado.',
		ar: 'هذه مكالمة تجريبية، لذا بدلًا من تحويلك إلى {phone}، سأتابع كأن أحدًا لم يرد.',
	},
} satisfies Record<string, Record<AgentLanguage, string>>

export type CallLineKey = keyof typeof CALL_LINES

/** A fixed line in the call's language; `{name}` placeholders come from `values`. */
export function callLine(
	key: CallLineKey,
	language: string | undefined,
	values: Record<string, string> = {},
) {
	return CALL_LINES[key][agentLanguage(language)].replace(
		/\{(\w+)\}/g,
		(placeholder, name: string) => values[name] ?? placeholder,
	)
}

/**
 * The first thing every caller hears: that they are talking to an automated
 * assistant and, when it applies, that the call may be recorded.
 */
export function complianceNotice({
	recording,
	...options
}: PhraseOptions & { recording: boolean }) {
	return [
		callPhrase('disclosure', options),
		recording ? callPhrase('recording_notice', options) : '',
	]
		.filter(Boolean)
		.join(' ')
}
