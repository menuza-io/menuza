import {
	SITE_CONTENT_LOCALES,
	type SiteContentLocale,
} from '@repo/common/site-locales'

/**
 * The marketing calendar's occasions (#152): holidays and seasons a restaurant
 * sells around, per market, with the rule that gives each its date and the
 * ready-made words for an email, a text and a social post. Pure code: no I/O,
 * no guest data, no live feed. Hijri occasions use the Islamic Umm al-Qura
 * calendar through `Intl`, like `isRamadan` in `@repo/inventory`, and are
 * always shown as "expected": official dates can move by a day.
 */

export type OccasionMarket = 'us' | 'ksa'
export const OCCASION_MARKETS: readonly OccasionMarket[] = ['us', 'ksa']

export function isOccasionMarket(value: unknown): value is OccasionMarket {
	return value === 'us' || value === 'ksa'
}

/** Where a broadcast of an occasion goes out, counted back from the day. */
export const DEFAULT_SEND_LEAD_DAYS = 7
/** Auto-schedule creates the Scheduled broadcast this many days before the day. */
export const AUTO_SCHEDULE_LEAD_DAYS = 14
/** The calendar shows an occasion's ready-made campaign this far ahead. */
export const SUGGESTION_HORIZON_DAYS = 28
/** Auto-schedule is skipped when another broadcast is within this many days. */
export const OCCASION_CONFLICT_DAYS = 2
/** Local hour the recommended broadcast goes out. */
export const DEFAULT_SEND_HOUR = 10

type Rule =
	| { kind: 'fixed'; month: number; day: number }
	/** `nth` 1 to 4: the nth `weekday` (0 = Sunday) of the month. */
	| { kind: 'nth'; month: number; weekday: number; nth: number }
	/** Hijri month 1 to 12 and day, in the Umm al-Qura calendar. */
	| { kind: 'hijri'; month: number; day: number }

export const OCCASION_KEYS = [
	'us_new_year',
	'us_valentines_day',
	'us_super_bowl',
	'us_st_patricks_day',
	'us_mothers_day',
	'us_fathers_day',
	'us_independence_day',
	'us_labor_day',
	'us_halloween',
	'us_thanksgiving',
	'us_christmas',
	'ksa_ramadan_start',
	'ksa_last_ten_nights',
	'ksa_eid_al_fitr',
	'ksa_eid_al_adha',
	'ksa_founding_day',
	'ksa_national_day',
] as const
export type OccasionKey = (typeof OCCASION_KEYS)[number]

export function isOccasionKey(value: unknown): value is OccasionKey {
	return (OCCASION_KEYS as readonly unknown[]).includes(value)
}

export type Occasion = {
	key: OccasionKey
	market: OccasionMarket
	rule: Rule
	/** The date is a guess that can move (a Hijri date, or a game day). */
	expected: boolean
	/** Days before the day the recommended broadcast goes out. */
	sendLeadDays: number
}

export const OCCASIONS: readonly Occasion[] = [
	{
		key: 'us_new_year',
		market: 'us',
		rule: { kind: 'fixed', month: 1, day: 1 },
		expected: false,
		sendLeadDays: 7,
	},
	{
		key: 'us_valentines_day',
		market: 'us',
		rule: { kind: 'fixed', month: 2, day: 14 },
		expected: false,
		sendLeadDays: 7,
	},
	// The second Sunday of February has been the game day for years; it is a guess.
	{
		key: 'us_super_bowl',
		market: 'us',
		rule: { kind: 'nth', month: 2, weekday: 0, nth: 2 },
		expected: true,
		sendLeadDays: 5,
	},
	{
		key: 'us_st_patricks_day',
		market: 'us',
		rule: { kind: 'fixed', month: 3, day: 17 },
		expected: false,
		sendLeadDays: 5,
	},
	{
		key: 'us_mothers_day',
		market: 'us',
		rule: { kind: 'nth', month: 5, weekday: 0, nth: 2 },
		expected: false,
		sendLeadDays: 10,
	},
	{
		key: 'us_fathers_day',
		market: 'us',
		rule: { kind: 'nth', month: 6, weekday: 0, nth: 3 },
		expected: false,
		sendLeadDays: 10,
	},
	{
		key: 'us_independence_day',
		market: 'us',
		rule: { kind: 'fixed', month: 7, day: 4 },
		expected: false,
		sendLeadDays: 7,
	},
	{
		key: 'us_labor_day',
		market: 'us',
		rule: { kind: 'nth', month: 9, weekday: 1, nth: 1 },
		expected: false,
		sendLeadDays: 7,
	},
	{
		key: 'us_halloween',
		market: 'us',
		rule: { kind: 'fixed', month: 10, day: 31 },
		expected: false,
		sendLeadDays: 7,
	},
	{
		key: 'us_thanksgiving',
		market: 'us',
		rule: { kind: 'nth', month: 11, weekday: 4, nth: 4 },
		expected: false,
		sendLeadDays: 14,
	},
	{
		key: 'us_christmas',
		market: 'us',
		rule: { kind: 'fixed', month: 12, day: 25 },
		expected: false,
		sendLeadDays: 14,
	},
	{
		key: 'ksa_ramadan_start',
		market: 'ksa',
		rule: { kind: 'hijri', month: 9, day: 1 },
		expected: true,
		sendLeadDays: 7,
	},
	{
		key: 'ksa_last_ten_nights',
		market: 'ksa',
		rule: { kind: 'hijri', month: 9, day: 21 },
		expected: true,
		sendLeadDays: 3,
	},
	{
		key: 'ksa_eid_al_fitr',
		market: 'ksa',
		rule: { kind: 'hijri', month: 10, day: 1 },
		expected: true,
		sendLeadDays: 5,
	},
	{
		key: 'ksa_eid_al_adha',
		market: 'ksa',
		rule: { kind: 'hijri', month: 12, day: 10 },
		expected: true,
		sendLeadDays: 5,
	},
	{
		key: 'ksa_founding_day',
		market: 'ksa',
		rule: { kind: 'fixed', month: 2, day: 22 },
		expected: false,
		sendLeadDays: 5,
	},
	{
		key: 'ksa_national_day',
		market: 'ksa',
		rule: { kind: 'fixed', month: 9, day: 23 },
		expected: false,
		sendLeadDays: 5,
	},
]

const BY_KEY = new Map<OccasionKey, Occasion>(
	OCCASIONS.map((occasion) => [occasion.key, occasion]),
)

export function getOccasion(key: string): Occasion | null {
	return isOccasionKey(key) ? (BY_KEY.get(key) ?? null) : null
}

export function occasionsForMarket(market: OccasionMarket): Occasion[] {
	return OCCASIONS.filter((occasion) => occasion.market === market)
}

// ---------------------------------------------------------------------------
// Dates (all `YYYY-MM-DD`, calendar math in UTC)
// ---------------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, '0')
const toDate = (year: number, month: number, day: number) =>
	`${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`

export function addDays(date: string, days: number): string {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const next = new Date(Date.UTC(year, month - 1, day + days))
	return toDate(
		next.getUTCFullYear(),
		next.getUTCMonth() + 1,
		next.getUTCDate(),
	)
}

export function daysBetween(from: string, to: string): number {
	const parse = (value: string) => {
		const [year, month, day] = value.split('-').map(Number) as [
			number,
			number,
			number,
		]
		return Date.UTC(year, month - 1, day)
	}
	return Math.round((parse(to) - parse(from)) / 86_400_000)
}

/** The nth weekday (0 = Sunday) of a month, as a date. */
export function nthWeekdayOfMonth(
	year: number,
	month: number,
	weekday: number,
	nth: number,
): string {
	const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
	const day = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7
	return toDate(year, month, day)
}

const hijriIndexCache = new Map<number, Map<string, string[]>>()

/**
 * For a Gregorian year, which dates carry each Hijri `month-day` (Umm al-Qura,
 * through `Intl`). A Hijri date falls once, twice (the Hijri year is shorter) or
 * not at all in a Gregorian year. Empty when the platform has no such calendar.
 */
function hijriIndex(year: number): Map<string, string[]> {
	const cached = hijriIndexCache.get(year)
	if (cached) return cached
	const index = new Map<string, string[]>()
	try {
		const formatter = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
			day: 'numeric',
			month: 'numeric',
			timeZone: 'UTC',
		})
		for (
			let date = toDate(year, 1, 1);
			date.startsWith(String(year));
			date = addDays(date, 1)
		) {
			const [y, m, d] = date.split('-').map(Number) as [number, number, number]
			const parts = formatter.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)))
			const month = parts.find((part) => part.type === 'month')?.value
			const day = parts.find((part) => part.type === 'day')?.value
			if (!month || !day) continue
			const key = `${Number(month)}-${Number(day)}`
			index.set(key, [...(index.get(key) ?? []), date])
		}
	} catch {
		// No Hijri calendar here: hijri occasions are simply not listed.
	}
	hijriIndexCache.set(year, index)
	return index
}

export type OccasionDate = {
	date: string
	expected: boolean
}

/** The dates an occasion falls on in a Gregorian year. */
export function occasionDates(
	occasion: Occasion,
	year: number,
): OccasionDate[] {
	const { rule } = occasion
	if (rule.kind === 'fixed') {
		return [
			{ date: toDate(year, rule.month, rule.day), expected: occasion.expected },
		]
	}
	if (rule.kind === 'nth') {
		return [
			{
				date: nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.nth),
				expected: occasion.expected,
			},
		]
	}
	return (hijriIndex(year).get(`${rule.month}-${rule.day}`) ?? []).map(
		(date) => ({
			date,
			// An official date can move by a day: always "expected".
			expected: true,
		}),
	)
}

export type OccasionOccurrence = {
	key: OccasionKey
	market: OccasionMarket
	date: string
	year: number
	expected: boolean
	/** When the recommended broadcast goes out (a date; the hour is local). */
	sendDate: string
}

/** Every occurrence of a market's occasions between two dates, in order. */
export function occasionsBetween(
	market: OccasionMarket,
	from: string,
	to: string,
): OccasionOccurrence[] {
	const fromYear = Number(from.slice(0, 4))
	const toYear = Number(to.slice(0, 4))
	const found: OccasionOccurrence[] = []
	for (const occasion of occasionsForMarket(market)) {
		for (let year = fromYear; year <= toYear; year++) {
			for (const { date, expected } of occasionDates(occasion, year)) {
				if (date < from || date > to) continue
				found.push({
					key: occasion.key,
					market,
					date,
					year: Number(date.slice(0, 4)),
					expected,
					sendDate: addDays(date, -occasion.sendLeadDays),
				})
			}
		}
	}
	return found.sort(
		(a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key),
	)
}

/** The occasions to suggest on a day: today through four weeks ahead. */
export function suggestedOccasions(
	market: OccasionMarket,
	today: string,
	horizonDays = SUGGESTION_HORIZON_DAYS,
): OccasionOccurrence[] {
	return occasionsBetween(market, today, addDays(today, horizonDays))
}

/**
 * Which market the calendar suggests for: the organization's choice, else the
 * market of its data region.
 */
export function resolveOccasionMarket(input: {
	override?: string | null
	dataRegion?: string | null
}): OccasionMarket {
	if (isOccasionMarket(input.override)) return input.override
	return input.dataRegion === 'ksa' ? 'ksa' : 'us'
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

type Words = Record<SiteContentLocale, string>

/** What each occasion is called, in the site's languages. */
export const OCCASION_NAMES: Record<OccasionKey, Words> = {
	us_new_year: {
		en: 'New Year',
		ar: 'رأس السنة',
		es: 'Año Nuevo',
		fr: 'Nouvel An',
		de: 'Neujahr',
		zh: '新年',
	},
	us_valentines_day: {
		en: "Valentine's Day",
		ar: 'عيد الحب',
		es: 'el Día de San Valentín',
		fr: 'la Saint-Valentin',
		de: 'Valentinstag',
		zh: '情人节',
	},
	us_super_bowl: {
		en: 'Super Bowl Sunday',
		ar: 'يوم السوبر بول',
		es: 'el domingo del Super Bowl',
		fr: 'le dimanche du Super Bowl',
		de: 'Super-Bowl-Sonntag',
		zh: '超级碗周日',
	},
	us_st_patricks_day: {
		en: "St. Patrick's Day",
		ar: 'عيد القديس باتريك',
		es: 'el Día de San Patricio',
		fr: 'la Saint-Patrick',
		de: "St. Patrick's Day",
		zh: '圣帕特里克节',
	},
	us_mothers_day: {
		en: "Mother's Day",
		ar: 'عيد الأم',
		es: 'el Día de la Madre',
		fr: 'la fête des mères',
		de: 'Muttertag',
		zh: '母亲节',
	},
	us_fathers_day: {
		en: "Father's Day",
		ar: 'عيد الأب',
		es: 'el Día del Padre',
		fr: 'la fête des pères',
		de: 'Vatertag',
		zh: '父亲节',
	},
	us_independence_day: {
		en: 'the Fourth of July',
		ar: 'الرابع من يوليو',
		es: 'el Cuatro de Julio',
		fr: 'le 4 juillet',
		de: 'der 4. Juli',
		zh: '七月四日独立日',
	},
	us_labor_day: {
		en: 'Labor Day',
		ar: 'عيد العمال',
		es: 'el Día del Trabajo',
		fr: 'le Labor Day',
		de: 'Labor Day',
		zh: '劳动节',
	},
	us_halloween: {
		en: 'Halloween',
		ar: 'الهالوين',
		es: 'Halloween',
		fr: 'Halloween',
		de: 'Halloween',
		zh: '万圣节',
	},
	us_thanksgiving: {
		en: 'Thanksgiving',
		ar: 'عيد الشكر',
		es: 'el Día de Acción de Gracias',
		fr: 'Thanksgiving',
		de: 'Thanksgiving',
		zh: '感恩节',
	},
	us_christmas: {
		en: 'Christmas',
		ar: 'عيد الميلاد',
		es: 'la Navidad',
		fr: 'Noël',
		de: 'Weihnachten',
		zh: '圣诞节',
	},
	ksa_ramadan_start: {
		en: 'the start of Ramadan',
		ar: 'بداية شهر رمضان',
		es: 'el inicio del Ramadán',
		fr: 'le début du Ramadan',
		de: 'der Beginn des Ramadan',
		zh: '斋月开始',
	},
	ksa_last_ten_nights: {
		en: 'the last 10 nights of Ramadan',
		ar: 'العشر الأواخر من رمضان',
		es: 'las últimas 10 noches del Ramadán',
		fr: 'les 10 dernières nuits du Ramadan',
		de: 'die letzten 10 Nächte des Ramadan',
		zh: '斋月最后十夜',
	},
	ksa_eid_al_fitr: {
		en: 'Eid al-Fitr',
		ar: 'عيد الفطر',
		es: 'Eid al-Fitr',
		fr: "l'Aïd al-Fitr",
		de: 'Eid al-Fitr',
		zh: '开斋节',
	},
	ksa_eid_al_adha: {
		en: 'Eid al-Adha',
		ar: 'عيد الأضحى',
		es: 'Eid al-Adha',
		fr: "l'Aïd al-Adha",
		de: 'Eid al-Adha',
		zh: '宰牲节',
	},
	ksa_founding_day: {
		en: 'Founding Day',
		ar: 'يوم التأسيس',
		es: 'el Día de la Fundación',
		fr: 'la Fête de la Fondation',
		de: 'der Gründungstag',
		zh: '建国日',
	},
	ksa_national_day: {
		en: 'Saudi National Day',
		ar: 'اليوم الوطني السعودي',
		es: 'el Día Nacional de Arabia Saudita',
		fr: 'la Fête nationale saoudienne',
		de: 'der Saudische Nationalfeiertag',
		zh: '沙特国庆日',
	},
}

/** A title that reads on its own in a list: the name without its article. */
export const OCCASION_TITLES: Record<OccasionKey, Words> = {
	us_new_year: OCCASION_NAMES.us_new_year,
	us_valentines_day: {
		en: "Valentine's Day",
		ar: 'عيد الحب',
		es: 'Día de San Valentín',
		fr: 'Saint-Valentin',
		de: 'Valentinstag',
		zh: '情人节',
	},
	us_super_bowl: {
		en: 'Super Bowl Sunday',
		ar: 'يوم السوبر بول',
		es: 'Domingo del Super Bowl',
		fr: 'Dimanche du Super Bowl',
		de: 'Super-Bowl-Sonntag',
		zh: '超级碗周日',
	},
	us_st_patricks_day: {
		en: "St. Patrick's Day",
		ar: 'عيد القديس باتريك',
		es: 'Día de San Patricio',
		fr: 'Saint-Patrick',
		de: "St. Patrick's Day",
		zh: '圣帕特里克节',
	},
	us_mothers_day: {
		en: "Mother's Day",
		ar: 'عيد الأم',
		es: 'Día de la Madre',
		fr: 'Fête des mères',
		de: 'Muttertag',
		zh: '母亲节',
	},
	us_fathers_day: {
		en: "Father's Day",
		ar: 'عيد الأب',
		es: 'Día del Padre',
		fr: 'Fête des pères',
		de: 'Vatertag',
		zh: '父亲节',
	},
	us_independence_day: {
		en: 'Fourth of July',
		ar: 'الرابع من يوليو',
		es: 'Cuatro de Julio',
		fr: '4 juillet',
		de: '4. Juli',
		zh: '七月四日独立日',
	},
	us_labor_day: {
		en: 'Labor Day',
		ar: 'عيد العمال',
		es: 'Día del Trabajo',
		fr: 'Labor Day',
		de: 'Labor Day',
		zh: '劳动节',
	},
	us_halloween: OCCASION_NAMES.us_halloween,
	us_thanksgiving: {
		en: 'Thanksgiving',
		ar: 'عيد الشكر',
		es: 'Día de Acción de Gracias',
		fr: 'Thanksgiving',
		de: 'Thanksgiving',
		zh: '感恩节',
	},
	us_christmas: {
		en: 'Christmas',
		ar: 'عيد الميلاد',
		es: 'Navidad',
		fr: 'Noël',
		de: 'Weihnachten',
		zh: '圣诞节',
	},
	ksa_ramadan_start: {
		en: 'Start of Ramadan',
		ar: 'بداية شهر رمضان',
		es: 'Inicio del Ramadán',
		fr: 'Début du Ramadan',
		de: 'Beginn des Ramadan',
		zh: '斋月开始',
	},
	ksa_last_ten_nights: {
		en: 'Last 10 nights of Ramadan',
		ar: 'العشر الأواخر من رمضان',
		es: 'Últimas 10 noches del Ramadán',
		fr: '10 dernières nuits du Ramadan',
		de: 'Letzte 10 Nächte des Ramadan',
		zh: '斋月最后十夜',
	},
	ksa_eid_al_fitr: {
		en: 'Eid al-Fitr',
		ar: 'عيد الفطر',
		es: 'Eid al-Fitr',
		fr: 'Aïd al-Fitr',
		de: 'Eid al-Fitr',
		zh: '开斋节',
	},
	ksa_eid_al_adha: {
		en: 'Eid al-Adha',
		ar: 'عيد الأضحى',
		es: 'Eid al-Adha',
		fr: 'Aïd al-Adha',
		de: 'Eid al-Adha',
		zh: '宰牲节',
	},
	ksa_founding_day: {
		en: 'Founding Day',
		ar: 'يوم التأسيس',
		es: 'Día de la Fundación',
		fr: 'Fête de la Fondation',
		de: 'Gründungstag',
		zh: '建国日',
	},
	ksa_national_day: {
		en: 'Saudi National Day',
		ar: 'اليوم الوطني السعودي',
		es: 'Día Nacional de Arabia Saudita',
		fr: 'Fête nationale saoudienne',
		de: 'Saudischer Nationalfeiertag',
		zh: '沙特国庆日',
	},
}

const COPY: Record<
	SiteContentLocale,
	{
		subject: string
		headline: string
		body: string
		button: string
		sms: string
		social: string
	}
> = {
	en: {
		subject: '{title} at {restaurant}',
		headline: 'Celebrate {title} with us',
		body: 'Join us for {name}. Book a table or order ahead and we will take care of the rest.',
		button: 'Order now',
		sms: '{restaurant}: join us for {name}. Order ahead or book a table: {link}',
		social:
			'Join us for {name}! Order ahead or book your table with {restaurant}. {link}',
	},
	ar: {
		subject: '{title} في {restaurant}',
		headline: 'احتفلوا معنا بـ{title}',
		body: 'انضموا إلينا في {name}. احجزوا طاولة أو اطلبوا مسبقًا وسنتولى الباقي.',
		button: 'اطلب الآن',
		sms: '{restaurant}: انضموا إلينا في {name}. اطلبوا مسبقًا أو احجزوا طاولة: {link}',
		social:
			'انضموا إلينا في {name}! اطلبوا مسبقًا أو احجزوا طاولتكم لدى {restaurant}. {link}',
	},
	es: {
		subject: '{title} en {restaurant}',
		headline: 'Celebra {name} con nosotros',
		body: 'Únete a nosotros en {name}. Reserva una mesa o pide con antelación y nosotros nos encargamos del resto.',
		button: 'Pedir ahora',
		sms: '{restaurant}: celebra {name} con nosotros. Pide con antelación o reserva mesa: {link}',
		social:
			'¡Celebra {name} con nosotros! Pide con antelación o reserva tu mesa en {restaurant}. {link}',
	},
	fr: {
		subject: '{title} chez {restaurant}',
		headline: 'Fêtez {name} avec nous',
		body: "Rejoignez-nous pour {name}. Réservez une table ou commandez à l'avance, nous nous occupons du reste.",
		button: 'Commander',
		sms: "{restaurant} : fêtez {name} avec nous. Commandez à l'avance ou réservez : {link}",
		social:
			"Fêtez {name} avec nous ! Commandez à l'avance ou réservez votre table chez {restaurant}. {link}",
	},
	de: {
		subject: '{title} bei {restaurant}',
		headline: 'Feiern Sie {name} mit uns',
		body: 'Feiern Sie {name} mit uns. Reservieren Sie einen Tisch oder bestellen Sie vorab, um den Rest kümmern wir uns.',
		button: 'Jetzt bestellen',
		sms: '{restaurant}: feiern Sie {name} mit uns. Vorbestellen oder Tisch reservieren: {link}',
		social:
			'Feiern Sie {name} mit uns! Vorbestellen oder Tisch reservieren bei {restaurant}. {link}',
	},
	zh: {
		subject: '{restaurant}：{title}',
		headline: '与我们一起庆祝{title}',
		body: '欢迎在{title}来{restaurant}。预订座位或提前点餐，其余的交给我们。',
		button: '立即点餐',
		sms: '{restaurant}：欢迎在{title}光临。提前点餐或预订座位：{link}',
		social: '{title}将至！提前点餐或预订{restaurant}的座位。{link}',
	},
}

export type OccasionCopy = {
	subject: string
	headline: string
	body: string
	buttonLabel: string
	sms: string
	social: string
}

function fill(template: string, values: Record<string, string>) {
	return template.replace(
		/\{(\w+)\}/g,
		(whole, key: string) => values[key] ?? whole,
	)
}

/**
 * Ready-made words for an occasion in one site language, naming the
 * restaurant. Generic on purpose (a greeting, a call to order or book): no
 * claim, price or offer the restaurant did not make. Falls back to English.
 */
export function occasionCopy(
	key: OccasionKey,
	locale: string,
	input: { restaurant: string; link: string },
): OccasionCopy {
	const code: SiteContentLocale = (
		SITE_CONTENT_LOCALES as readonly string[]
	).includes(locale)
		? (locale as SiteContentLocale)
		: 'en'
	const words = COPY[code]
	const values = {
		name: OCCASION_NAMES[key][code],
		title: OCCASION_TITLES[key][code],
		restaurant:
			input.restaurant.trim() || (code === 'ar' ? 'مطعمنا' : 'our restaurant'),
		link: input.link,
	}
	return {
		subject: fill(words.subject, values),
		headline: fill(words.headline, values),
		body: fill(words.body, values),
		buttonLabel: words.button,
		sms: fill(words.sms, values),
		social: fill(words.social, values),
	}
}

export function occasionTitle(key: OccasionKey, locale: string): string {
	const code = (SITE_CONTENT_LOCALES as readonly string[]).includes(locale)
		? (locale as SiteContentLocale)
		: 'en'
	return OCCASION_TITLES[key][code]
}
