import { z } from 'zod'
import { type AgentLanguage, SUPPORTED_AGENT_LANGUAGES } from './constants.ts'

/**
 * Fixed lines the phone system speaks outside the AI assistant. Owners can
 * override each one per language; `{business}` and any vertical
 * placeholders are filled at call time.
 */
export const PHRASE_KEYS = [
	'disclosure',
	'recording_notice',
	'menu_retry',
	'menu_invalid',
	'hold',
	'transfer_connecting',
	'transfer_no_answer',
	'transfer_unavailable',
	'transfer_text_offer',
	'transfer_text_sent',
	'transfer_text_failed',
	'calling_disabled',
	'trouble',
	'text_link_sent',
	'text_link_blocked',
	'voicemail_prompt',
	'voicemail_saved',
	'voicemail_failed',
	'voicemail_empty',
	'call_time_limit',
	'csat_question',
	'csat_thanks',
	'csat_low',
	'goodbye',
] as const
export type PhraseKey = (typeof PHRASE_KEYS)[number]

/**
 * The AI disclosure and recording consent notice are legal requirements (bot
 * disclosure and all-party-consent states), so owners can't reword them.
 */
export const REQUIRED_NOTICE_PHRASE_KEYS = [
	'disclosure',
	'recording_notice',
] as const satisfies readonly PhraseKey[]

export function isEditablePhraseKey(key: PhraseKey) {
	return !REQUIRED_NOTICE_PHRASE_KEYS.some((locked) => locked === key)
}

export const EDITABLE_PHRASE_KEYS = PHRASE_KEYS.filter(isEditablePhraseKey)

export type PhraseDefinition = {
	key: PhraseKey
	label: string
	description: string
	defaults: Record<AgentLanguage, string>
}

export const PHRASE_DEFINITIONS: readonly PhraseDefinition[] = [
	{
		key: 'disclosure',
		label: 'Automated assistant notice',
		description: 'Played at the start of every call.',
		defaults: {
			en: "You've reached {business}'s automated phone assistant.",
			es: 'Se ha comunicado con el asistente telefónico automático de {business}.',
			ar: 'لقد وصلت إلى المساعد الهاتفي الآلي لـ {business}.',
		},
	},
	{
		key: 'recording_notice',
		label: 'Recording notice',
		description:
			'Played right after the assistant notice when recording is on.',
		defaults: {
			en: 'This call may be recorded.',
			es: 'Esta llamada puede ser grabada.',
			ar: 'قد يتم تسجيل هذه المكالمة.',
		},
	},
	{
		key: 'menu_retry',
		label: "Didn't catch that",
		description:
			'Played before a keypad menu repeats because the choice was unclear.',
		defaults: {
			en: "Sorry, I didn't catch that.",
			es: 'Disculpe, no le entendí.',
			ar: 'عذرًا، لم أفهم ذلك.',
		},
	},
	{
		key: 'menu_invalid',
		label: 'Wrong key',
		description:
			'Played before a keypad menu repeats because the key pressed is not one of its options.',
		defaults: {
			en: "Sorry, that's not one of the options.",
			es: 'Lo siento, esa no es una de las opciones.',
			ar: 'عذرًا، هذا ليس أحد الخيارات.',
		},
	},
	{
		key: 'hold',
		label: 'Hold message',
		description: 'Played while a transfer is ringing.',
		defaults: {
			en: 'Please hold while I connect you.',
			es: 'Por favor espere mientras lo comunico.',
			ar: 'يرجى الانتظار بينما أقوم بتحويلك.',
		},
	},
	{
		key: 'transfer_connecting',
		label: 'Transfer answered',
		description:
			'Played when staff pick up, just before the assistant leaves the call.',
		defaults: {
			en: 'Connecting you now.',
			es: 'Lo comunico ahora.',
			ar: 'جارٍ تحويلك الآن.',
		},
	},
	{
		key: 'transfer_no_answer',
		label: 'Nobody answered',
		description: 'Played when a transfer is not picked up.',
		defaults: {
			en: 'Sorry, nobody is available to take your call right now.',
			es: 'Lo siento, no hay nadie disponible para atender su llamada en este momento.',
			ar: 'عذرًا، لا يوجد أحد متاح للرد على مكالمتك الآن.',
		},
	},
	{
		key: 'transfer_unavailable',
		label: 'Transfers unavailable',
		description: 'Played when transfers are off or outside transfer hours.',
		defaults: {
			en: "I'm not able to transfer calls right now, but I can take a message for the team.",
			es: 'No puedo transferir llamadas en este momento, pero puedo tomar un mensaje para el equipo.',
			ar: 'لا يمكنني تحويل المكالمات الآن، لكن يمكنني ترك رسالة للفريق.',
		},
	},
	{
		key: 'transfer_text_offer',
		label: 'Offer a text if nobody answers',
		description: 'Asked before a transfer when texting the caller back is on.',
		defaults: {
			en: 'If nobody picks up, may we text you so the team can follow up? Press 1 or say yes.',
			es: 'Si nadie contesta, ¿podemos enviarle un mensaje de texto para que el equipo le dé seguimiento? Presione 1 o diga sí.',
			ar: 'إذا لم يرد أحد، هل يمكننا مراسلتك نصيًا ليتابع الفريق معك؟ اضغط 1 أو قل نعم.',
		},
	},
	{
		key: 'transfer_text_sent',
		label: 'Follow-up text sent',
		description: 'Played after texting the caller because nobody answered.',
		defaults: {
			en: "We've sent you a text, and the team will follow up soon.",
			es: 'Le enviamos un mensaje de texto y el equipo le dará seguimiento pronto.',
			ar: 'لقد أرسلنا لك رسالة نصية، وسيتابع الفريق معك قريبًا.',
		},
	},
	{
		key: 'transfer_text_failed',
		label: 'Follow-up text not sent',
		description:
			'Played when nobody answered, the team was asked to call back, but the text could not be sent.',
		defaults: {
			en: "We couldn't send you a text, but we've asked the team to call you back.",
			es: 'No pudimos enviarle un mensaje de texto, pero le pedimos al equipo que le devuelva la llamada.',
			ar: 'لم نتمكن من إرسال رسالة نصية إليك، لكننا طلبنا من الفريق معاودة الاتصال بك.',
		},
	},
	{
		key: 'calling_disabled',
		label: 'Assistant turned off',
		description:
			'Played before passing the call to the business when the assistant is paused.',
		defaults: {
			en: 'Please hold while we connect you to {business}.',
			es: 'Por favor espere mientras lo comunicamos con {business}.',
			ar: 'يرجى الانتظار بينما نوصلك بـ {business}.',
		},
	},
	{
		key: 'trouble',
		label: 'Something went wrong',
		description: 'Played when the phone system cannot answer the call.',
		defaults: {
			en: "Sorry, we're having trouble answering right now. Please call back shortly.",
			es: 'Lo sentimos, tenemos problemas para atender en este momento. Por favor llame de nuevo en unos minutos.',
			ar: 'عذرًا، نواجه مشكلة في الرد الآن. يرجى معاودة الاتصال بعد قليل.',
		},
	},
	{
		key: 'text_link_sent',
		label: 'Website link sent',
		description: 'Played after the website link is texted.',
		defaults: {
			en: 'We just sent you a text with a link to our website.',
			es: 'Le acabamos de enviar un mensaje de texto con un enlace a nuestro sitio web.',
			ar: 'أرسلنا لك للتو رسالة نصية تحتوي على رابط موقعنا الإلكتروني.',
		},
	},
	{
		key: 'text_link_blocked',
		label: "Can't text that number",
		description:
			'Played when the website link cannot be texted to the caller, for example when their number is hidden or the text limit is reached.',
		defaults: {
			en: "Sorry, I can't text you the link right now. You can visit our website instead.",
			es: 'Lo siento, no puedo enviarle el enlace por mensaje de texto en este momento. Puede visitar nuestro sitio web.',
			ar: 'عذرًا، لا يمكنني إرسال الرابط إليك برسالة نصية الآن. يمكنك زيارة موقعنا الإلكتروني بدلًا من ذلك.',
		},
	},
	{
		key: 'voicemail_prompt',
		label: 'Voicemail instructions',
		description:
			'Played before a voicemail step starts listening, when the step has no message of its own.',
		defaults: {
			en: 'Please leave your name, number, and message after this, then press pound or hang up.',
			es: 'Por favor deje su nombre, número y mensaje después de esto, y luego presione la tecla de numeral o cuelgue.',
			ar: 'يرجى ترك اسمك ورقمك ورسالتك بعد ذلك، ثم اضغط على مفتاح المربع أو أنهِ المكالمة.',
		},
	},
	{
		key: 'voicemail_saved',
		label: 'Voicemail saved',
		description: "Played after the caller's message is saved.",
		defaults: {
			en: 'Thanks, we got your message.',
			es: 'Gracias, recibimos su mensaje.',
			ar: 'شكرًا، لقد استلمنا رسالتك.',
		},
	},
	{
		key: 'voicemail_failed',
		label: 'Voicemail not saved',
		description: "Played when the caller's message could not be saved.",
		defaults: {
			en: "Sorry, we couldn't save your message.",
			es: 'Lo sentimos, no pudimos guardar su mensaje.',
			ar: 'عذرًا، لم نتمكن من حفظ رسالتك.',
		},
	},
	{
		key: 'voicemail_empty',
		label: 'No message heard',
		description: 'Played when a voicemail step hears nothing from the caller.',
		defaults: {
			en: "We didn't hear a message.",
			es: 'No escuchamos ningún mensaje.',
			ar: 'لم نسمع أي رسالة.',
		},
	},
	{
		key: 'call_time_limit',
		label: 'Call time limit',
		description:
			'Played before the goodbye when a call reaches its maximum length.',
		defaults: {
			en: "We've reached the time limit for this call.",
			es: 'Hemos llegado al límite de tiempo de esta llamada.',
			ar: 'لقد وصلنا إلى الحد الأقصى لمدة هذه المكالمة.',
		},
	},
	{
		key: 'csat_question',
		label: 'Rating question',
		description: 'Asked at the end of the call when call ratings are on.',
		defaults: {
			en: 'Before you go, how would you rate this call from 1 to 5? Press or say a number.',
			es: 'Antes de colgar, ¿cómo calificaría esta llamada del 1 al 5? Presione o diga un número.',
			ar: 'قبل أن تغادر، كيف تقيّم هذه المكالمة من 1 إلى 5؟ اضغط أو قل رقمًا.',
		},
	},
	{
		key: 'csat_thanks',
		label: 'Rating thanks',
		description: 'Played after a rating of 3 to 5.',
		defaults: {
			en: 'Thank you for your feedback!',
			es: '¡Gracias por sus comentarios!',
			ar: 'شكرًا لملاحظاتك!',
		},
	},
	{
		key: 'csat_low',
		label: 'Low rating',
		description: 'Played after a rating of 1 or 2.',
		defaults: {
			en: "Sorry we fell short. We'll share your feedback with the team.",
			es: 'Lamentamos no haber cumplido. Compartiremos sus comentarios con el equipo.',
			ar: 'نأسف لأننا لم نكن عند حسن ظنك. سنشارك ملاحظاتك مع الفريق.',
		},
	},
	{
		key: 'goodbye',
		label: 'Goodbye',
		description:
			'Played when the call ends without a hang-up message of its own.',
		defaults: {
			en: 'Thanks for calling {business}. Goodbye!',
			es: 'Gracias por llamar a {business}. ¡Adiós!',
			ar: 'شكرًا لاتصالك بـ {business}. مع السلامة!',
		},
	},
]

export const PHRASE_TEXT_MAX = 400

export const PhraseOverrideSchema = z.object({
	key: z.enum(PHRASE_KEYS),
	language: z.enum(SUPPORTED_AGENT_LANGUAGES),
	text: z.string().trim().min(1).max(PHRASE_TEXT_MAX),
})
export type PhraseOverride = z.infer<typeof PhraseOverrideSchema>

/**
 * Stored overrides, minus any for the required notices. Settings saved before
 * the notices were locked still parse; their notice overrides are dropped.
 */
export const PhraseOverridesSchema = z
	.array(PhraseOverrideSchema)
	.max(200)
	.transform((overrides) =>
		overrides.filter((override) => isEditablePhraseKey(override.key)),
	)

/**
 * Replacement label, description, or default wording a vertical gives a
 * phrase, e.g. naming the website link after what callers do there.
 */
export type PhraseDefaultOverride = {
	label?: string
	description?: string
	defaults?: Partial<Record<AgentLanguage, string>>
}
export type PhraseDefaultOverrides = Partial<
	Record<PhraseKey, PhraseDefaultOverride>
>

/** Every phrase with the vertical's label, description, and defaults applied. */
export function phraseDefinitionsWith(
	verticalDefaults: PhraseDefaultOverrides = {},
): PhraseDefinition[] {
	return PHRASE_DEFINITIONS.map((definition) => {
		const override = verticalDefaults[definition.key]
		if (!override) return definition
		return {
			key: definition.key,
			label: override.label ?? definition.label,
			description: override.description ?? definition.description,
			defaults: { ...definition.defaults, ...override.defaults },
		}
	})
}

const DEFINITIONS_BY_KEY = new Map(
	PHRASE_DEFINITIONS.map((definition) => [definition.key, definition]),
)

/**
 * The owner's override for the language, else the vertical's default, else
 * the built-in default. The required notices always use the built-in default.
 */
export function resolvePhrase(
	key: PhraseKey,
	language: AgentLanguage,
	overrides: readonly PhraseOverride[] = [],
	verticalDefaults: PhraseDefaultOverrides = {},
) {
	if (!isEditablePhraseKey(key)) {
		const definition = DEFINITIONS_BY_KEY.get(key)!
		return definition.defaults[language] ?? definition.defaults.en
	}
	const override = overrides.find(
		(candidate) => candidate.key === key && candidate.language === language,
	)
	if (override) return override.text
	const definition = DEFINITIONS_BY_KEY.get(key)!
	const vertical = verticalDefaults[key]?.defaults
	return (
		vertical?.[language] ??
		definition.defaults[language] ??
		vertical?.en ??
		definition.defaults.en
	)
}
