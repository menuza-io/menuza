import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type PublicFormField } from '@repo/common/public-form'
import { serializeLocalizedString } from '@repo/common/site-locales'

export const FORM_TEMPLATE_IDS = [
	'blank',
	'contact',
	'lead',
	'feedback',
	'catering',
	'event',
] as const

export type FormTemplateId = (typeof FORM_TEMPLATE_IDS)[number]

export type FormTemplate = {
	id: FormTemplateId
	name: MessageDescriptor
	description: MessageDescriptor
	fields: PublicFormField[]
}

const BASE_TEMPLATES: FormTemplate[] = [
	{
		id: 'blank',
		name: msg`Start from scratch`,
		description: msg`A clean canvas with one field you can shape into anything.`,
		fields: [{ id: 'name', label: 'Name', type: 'name', required: false }],
	},
	{
		id: 'contact',
		name: msg`Contact form`,
		description: msg`Collect a name, email address, and a detailed message.`,
		fields: [
			{ id: 'name', label: 'Name', type: 'name', required: true },
			{ id: 'email', label: 'Email', type: 'email', required: true },
			{ id: 'message', label: 'Message', type: 'textarea', required: true },
		],
	},
	{
		id: 'lead',
		name: msg`Lead capture`,
		description: msg`A short, low-friction form for prospective customers.`,
		fields: [
			{ id: 'name', label: 'Name', type: 'name', required: true },
			{ id: 'email', label: 'Work email', type: 'email', required: true },
			{ id: 'phone', label: 'Phone', type: 'tel', required: false },
		],
	},
	{
		id: 'feedback',
		name: msg`Feedback`,
		description: msg`Give visitors room to share thoughtful feedback.`,
		fields: [
			{ id: 'email', label: 'Email', type: 'email', required: false },
			{
				id: 'feedback',
				label: 'Your feedback',
				type: 'textarea',
				required: true,
			},
		],
	},
]

// ---------------------------------------------------------------------------
// Catering and event requests (#239). Their words ship in every site language,
// so a new form on a multilingual site starts out translated. Everything stays
// editable in the builder.
// ---------------------------------------------------------------------------

type Copy = { en: string } & Partial<Record<string, string>>

const COPY = {
	name: {
		en: 'Name',
		ar: 'الاسم',
		es: 'Nombre',
		fr: 'Nom',
		de: 'Name',
		zh: '姓名',
	},
	phone: {
		en: 'Phone',
		ar: 'رقم الجوال',
		es: 'Teléfono',
		fr: 'Téléphone',
		de: 'Telefon',
		zh: '电话',
	},
	email: {
		en: 'Email',
		ar: 'البريد الإلكتروني',
		es: 'Correo electrónico',
		fr: 'E-mail',
		de: 'E-Mail',
		zh: '电子邮件',
	},
	location: {
		en: 'Location',
		ar: 'الفرع',
		es: 'Sucursal',
		fr: 'Adresse du restaurant',
		de: 'Standort',
		zh: '门店',
	},
	dateTime: {
		en: 'Date and time',
		ar: 'التاريخ والوقت',
		es: 'Fecha y hora',
		fr: 'Date et heure',
		de: 'Datum und Uhrzeit',
		zh: '日期和时间',
	},
	headcount: {
		en: 'Number of guests',
		ar: 'عدد الضيوف',
		es: 'Número de invitados',
		fr: "Nombre d'invités",
		de: 'Anzahl der Gäste',
		zh: '宾客人数',
	},
	fulfilment: {
		en: 'Delivery or pickup',
		ar: 'توصيل أو استلام',
		es: 'Entrega o recogida',
		fr: 'Livraison ou retrait',
		de: 'Lieferung oder Abholung',
		zh: '配送或自取',
	},
	delivery: {
		en: 'Delivery',
		ar: 'توصيل',
		es: 'Entrega',
		fr: 'Livraison',
		de: 'Lieferung',
		zh: '配送',
	},
	pickup: {
		en: 'Pickup',
		ar: 'استلام',
		es: 'Recogida',
		fr: 'Retrait',
		de: 'Abholung',
		zh: '自取',
	},
	address: {
		en: 'Delivery address',
		ar: 'عنوان التوصيل',
		es: 'Dirección de entrega',
		fr: 'Adresse de livraison',
		de: 'Lieferadresse',
		zh: '配送地址',
	},
	allergies: {
		en: 'Allergies or dietary needs',
		ar: 'الحساسية أو الاحتياجات الغذائية',
		es: 'Alergias o necesidades dietéticas',
		fr: 'Allergies ou besoins alimentaires',
		de: 'Allergien oder Ernährungswünsche',
		zh: '过敏或饮食需求',
	},
	notes: {
		en: 'Anything else we should know?',
		ar: 'هل هناك أي شيء آخر نحتاج إلى معرفته؟',
		es: '¿Algo más que debamos saber?',
		fr: 'Autre chose que nous devrions savoir ?',
		de: 'Gibt es noch etwas, das wir wissen sollten?',
		zh: '还有什么需要我们了解的吗？',
	},
	eventType: {
		en: 'Type of event',
		ar: 'نوع المناسبة',
		es: 'Tipo de evento',
		fr: "Type d'événement",
		de: 'Art der Veranstaltung',
		zh: '活动类型',
	},
	birthday: {
		en: 'Birthday',
		ar: 'عيد ميلاد',
		es: 'Cumpleaños',
		fr: 'Anniversaire',
		de: 'Geburtstag',
		zh: '生日',
	},
	wedding: {
		en: 'Wedding',
		ar: 'حفل زفاف',
		es: 'Boda',
		fr: 'Mariage',
		de: 'Hochzeit',
		zh: '婚礼',
	},
	corporate: {
		en: 'Corporate',
		ar: 'شركات',
		es: 'Corporativo',
		fr: 'Entreprise',
		de: 'Firmenveranstaltung',
		zh: '企业活动',
	},
	fundraiser: {
		en: 'Fundraiser',
		ar: 'حملة تبرعات',
		es: 'Recaudación de fondos',
		fr: 'Collecte de fonds',
		de: 'Spendenaktion',
		zh: '募捐活动',
	},
	other: {
		en: 'Other',
		ar: 'أخرى',
		es: 'Otro',
		fr: 'Autre',
		de: 'Andere',
		zh: '其他',
	},
	needCatering: {
		en: 'Do you need catering?',
		ar: 'هل تحتاج إلى خدمة تقديم الطعام؟',
		es: '¿Necesita servicio de catering?',
		fr: 'Avez-vous besoin de traiteur ?',
		de: 'Benötigen Sie Catering?',
		zh: '是否需要餐饮服务？',
	},
	yes: { en: 'Yes', ar: 'نعم', es: 'Sí', fr: 'Oui', de: 'Ja', zh: '是' },
	no: { en: 'No', ar: 'لا', es: 'No', fr: 'Non', de: 'Nein', zh: '否' },
} satisfies Record<string, Copy>

/** Guest-count ranges for catering; the labels are numbers, so every language shares them. */
const HEADCOUNT_RANGES = ['10-25', '26-50', '51-100', '101-200', '200+']

type LocalizeContext = { locales: readonly string[] }

/**
 * A label in the site's languages. A single-language site keeps a plain string
 * (what the older templates store); several languages become localized JSON,
 * falling back to English for a language a template has no words for.
 */
function localize(copy: Copy, { locales }: LocalizeContext): string {
	if (locales.length <= 1) return copy[locales[0] ?? 'en'] ?? copy.en
	return serializeLocalizedString(
		Object.fromEntries(
			locales.map((locale) => [locale, copy[locale] ?? copy.en]),
		),
	)
}

function field(
	id: string,
	copy: Copy,
	type: PublicFormField['type'],
	required: boolean,
	context: LocalizeContext,
	extra: Partial<PublicFormField> = {},
): PublicFormField {
	return { id, label: localize(copy, context), type, required, ...extra }
}

function choices(options: Copy[], context: LocalizeContext) {
	return options.map((option) => localize(option, context))
}

function cateringFields(context: LocalizeContext): PublicFormField[] {
	const fulfilment = choices([COPY.delivery, COPY.pickup], context)
	return [
		field('name', COPY.name, 'name', true, context),
		field('phone', COPY.phone, 'tel', true, context),
		field('email', COPY.email, 'email', true, context),
		field('location', COPY.location, 'location', true, context),
		field('date', COPY.dateTime, 'datetime', true, context),
		field('headcount', COPY.headcount, 'single_choice', true, context, {
			options: HEADCOUNT_RANGES,
		}),
		field('fulfilment', COPY.fulfilment, 'single_choice', true, context, {
			options: fulfilment,
		}),
		// Asked only when the guest chose delivery (#357).
		field('address', COPY.address, 'address', true, context, {
			showWhen: { fieldId: 'fulfilment', values: [fulfilment[0]!] },
		}),
		field('allergies', COPY.allergies, 'textarea', false, context),
		field('notes', COPY.notes, 'textarea', false, context),
	]
}

function eventFields(context: LocalizeContext): PublicFormField[] {
	return [
		field('name', COPY.name, 'name', true, context),
		field('phone', COPY.phone, 'tel', true, context),
		field('email', COPY.email, 'email', true, context),
		field('event-type', COPY.eventType, 'single_choice', true, context, {
			options: choices(
				[
					COPY.birthday,
					COPY.wedding,
					COPY.corporate,
					COPY.fundraiser,
					COPY.other,
				],
				context,
			),
		}),
		field('location', COPY.location, 'location', true, context),
		field('date', COPY.dateTime, 'datetime', true, context),
		field('headcount', COPY.headcount, 'text', true, context, {
			numeric: true,
			min: 1,
			max: 2000,
		}),
		field('catering', COPY.needCatering, 'single_choice', true, context, {
			options: choices([COPY.yes, COPY.no], context),
		}),
		field('notes', COPY.notes, 'textarea', false, context),
	]
}

/**
 * The fields of a template in the site's languages. `locales` are the site's
 * content locales (default first); omit it for a single English site.
 */
export function buildFormTemplateFields(
	id: string,
	locales: readonly string[] = ['en'],
): PublicFormField[] | undefined {
	const context: LocalizeContext = {
		locales: locales.length ? locales : ['en'],
	}
	if (id === 'catering') return cateringFields(context)
	if (id === 'event') return eventFields(context)
	return getFormTemplateFields(id)
}

export const FORM_TEMPLATES: FormTemplate[] = [
	...BASE_TEMPLATES,
	{
		id: 'catering',
		name: msg`Catering request`,
		description: msg`Date, headcount, delivery or pickup, address and dietary needs.`,
		fields: cateringFields({ locales: ['en'] }),
	},
	{
		id: 'event',
		name: msg`Event request`,
		description: msg`Host a birthday, wedding, corporate or fundraising event with us.`,
		fields: eventFields({ locales: ['en'] }),
	},
]

export function getFormTemplate(id: string) {
	return FORM_TEMPLATES.find((template) => template.id === id)
}

export function getFormTemplateFields(id: string) {
	return getFormTemplate(id)?.fields.map((field) => ({ ...field }))
}
