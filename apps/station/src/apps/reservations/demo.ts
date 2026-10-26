import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import { HostApiError, type HostApi, type StatusTarget } from './api.ts'
import {
	availabilitySchema,
	DEFAULT_TURN_MIN,
	dayFeedSchema,
	isOnFloor,
	reservationSchema,
	UNDO_WINDOW_MS,
	type DayFeed,
	type DayReservation,
} from './feed.ts'
import { foldDigits } from './phone.ts'
import { clockLabel, zonedDate, zonedEpoch, zonedMinutes } from './zoned.ts'

/**
 * Demo mode's host stand: a sample day (two rooms, eighteen tables, lunch and
 * dinner, a waitlist) that lives in this tab's memory and keeps the regional
 * server's rules for a till, so every flow on the stand works without a
 * backend: seat only onto a table nobody is on (or booked soon, unless the
 * host insists), undo within half an hour, a no-show only fifteen minutes
 * after the time, nothing seated or marked on another day, new bookings only
 * into times that are open. Nothing is ever sent.
 *
 * The sample is built around the clock when the stand opens, so something is
 * always happening: parties seated, one waiting at the stand, one late, one
 * running late, the next hours booked.
 */

const MIN = 60_000
const DEMO_LOCATION = 'demo-location'
const SLOT_MIN = 15
/** A till may call a no-show only this long after the booking's time. */
const NO_SHOW_GRACE_MIN = 15
/** Covers each slot can take, for the bottom row of the timeline. */
const SLOT_CAP = 24
const WAITLIST_RESPONSE_MIN = 10

type Table = {
	id: string
	areaId: string
	label: string
	minCovers: number
	maxCovers: number
	shape: 'round' | 'square'
	x: number
	y: number
	w: number
	h: number
	/** Minutes a table is kept after a party's stay (the server's conflict checks add it). */
	resetBufferMin: number
	/** The manager marked it as one that joins others for a large party. */
	combinable: boolean
}

const AREAS = [
	{ id: 'area_main', name: 'Main room', sort: 0, canvasW: 1200, canvasH: 800 },
	{ id: 'area_patio', name: 'Patio', sort: 1, canvasW: 1200, canvasH: 800 },
]

function table(
	id: string,
	areaId: string,
	label: string,
	covers: [number, number],
	shape: Table['shape'],
	box: [number, number, number, number],
	resetBufferMin = 0,
	combinable = false,
): Table {
	return {
		resetBufferMin,
		combinable,
		id,
		areaId,
		label,
		minCovers: covers[0],
		maxCovers: covers[1],
		shape,
		x: box[0],
		y: box[1],
		w: box[2],
		h: box[3],
	}
}

const TABLES: Table[] = [
	table('t1', 'area_main', '1', [1, 2], 'round', [110, 110, 80, 80], 0),
	table('t2', 'area_main', '2', [1, 2], 'round', [240, 110, 80, 80]),
	table('t3', 'area_main', '3', [1, 2], 'round', [370, 110, 80, 80]),
	table('t4', 'area_main', '4', [2, 4], 'square', [520, 100, 100, 100], 10),
	table('t5', 'area_main', '5', [2, 4], 'square', [660, 100, 100, 100]),
	table(
		't6',
		'area_main',
		'6',
		[4, 6],
		'square',
		[110, 310, 190, 100],
		10,
		true,
	),
	table(
		't7',
		'area_main',
		'7',
		[4, 6],
		'square',
		[350, 310, 190, 100],
		10,
		true,
	),
	table('t8', 'area_main', '8', [6, 10], 'square', [590, 310, 270, 110], 15),
	table('t9', 'area_main', '9', [3, 5], 'round', [150, 530, 110, 110], 5, true),
	table(
		't10',
		'area_main',
		'10',
		[3, 5],
		'round',
		[370, 530, 110, 110],
		5,
		true,
	),
	table('p1', 'area_patio', 'P1', [1, 2], 'round', [120, 140, 80, 80]),
	table('p2', 'area_patio', 'P2', [1, 2], 'round', [260, 140, 80, 80]),
	table('p3', 'area_patio', 'P3', [1, 2], 'round', [400, 140, 80, 80]),
	table('p4', 'area_patio', 'P4', [2, 4], 'square', [140, 360, 100, 100], 5),
	table('p5', 'area_patio', 'P5', [2, 4], 'square', [330, 360, 100, 100], 5),
	table(
		'p6',
		'area_patio',
		'P6',
		[4, 8],
		'square',
		[560, 330, 300, 110],
		10,
		true,
	),
	// Two small patio tables beside the big one: free all evening, to join for a large party.
	table(
		'p7',
		'area_patio',
		'P7',
		[2, 4],
		'square',
		[900, 330, 100, 110],
		0,
		true,
	),
	table(
		'p8',
		'area_patio',
		'P8',
		[2, 4],
		'square',
		[900, 490, 100, 110],
		0,
		true,
	),
]

/**
 * Tables the manager defined as one: Tables 6 and 7 side by side seat twelve.
 * Tables 9 and 10 are marked combinable too, with no combination defined: the
 * stand joins them by where they stand.
 */
const COMBOS = [
	{
		id: 'combo_67',
		label: '6 + 7',
		minCovers: 6,
		maxCovers: 12,
		tableIds: ['t6', 't7'],
	},
]

const ELEMENTS = [
	{
		id: 'el_bar',
		areaId: 'area_main',
		kind: 'bar',
		label: 'Bar',
		x: 920,
		y: 90,
		w: 190,
		h: 560,
	},
	{
		id: 'el_door',
		areaId: 'area_main',
		kind: 'door',
		label: 'Entrance',
		x: 520,
		y: 740,
		w: 180,
		h: 28,
	},
	{
		id: 'el_zone',
		areaId: 'area_patio',
		kind: 'zone',
		label: 'Terrace',
		x: 70,
		y: 70,
		w: 860,
		h: 620,
	},
]

const SERVICES = [
	{
		id: 'svc_lunch',
		name: 'Lunch',
		firstSeatingMin: 11 * 60,
		lastSeatingMin: 15 * 60 + 30,
		endMin: 16 * 60 + 30,
		sort: 0,
		sectionLayoutId: 'layout_demo',
	},
	{
		id: 'svc_dinner',
		name: 'Dinner',
		firstSeatingMin: 16 * 60 + 30,
		lastSeatingMin: 21 * 60 + 30,
		endMin: 23 * 60 + 30,
		sort: 1,
		sectionLayoutId: 'layout_demo',
	},
]

/** The floor split between three servers, as a manager would draw it in the App. */
const SECTION_LAYOUTS = [
	{
		id: 'layout_demo',
		name: 'Three sections',
		sections: [
			{
				id: 'sec_window',
				name: 'Window',
				colorToken: 'blue',
				sort: 0,
				tableIds: ['t1', 't2', 't3', 't4', 't5'],
			},
			{
				id: 'sec_floor',
				name: 'Floor',
				colorToken: 'emerald',
				sort: 1,
				tableIds: ['t6', 't7', 't8', 't9', 't10'],
			},
			{
				id: 'sec_patio',
				name: 'Patio',
				colorToken: 'amber',
				sort: 2,
				tableIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
			},
		],
	},
]

/** The sample staff: two on the clock, two scheduled (`/pos/reservations/servers`). */
const DEMO_SERVERS = [
	{ staffId: 'staff_maya', firstName: 'Maya', lastInitial: 'S', clock: true },
	{ staffId: 'staff_omar', firstName: 'Omar', lastInitial: 'H', clock: true },
	{ staffId: 'staff_lina', firstName: 'Lina', lastInitial: 'K', clock: false },
	{ staffId: 'staff_sami', firstName: 'Sami', lastInitial: 'R', clock: false },
] as const

const serviceAt = (minutes: number) =>
	SERVICES.find((s) => minutes >= s.firstSeatingMin && minutes < s.endMin)

type Block = {
	id: string
	tableId: string | null
	areaId: string | null
	startAt: number
	endAt: number
	reason: string | null
}

type Seed = {
	/** Minutes from the clock the sample is built around. */
	offset: number
	name: [string, string]
	phone?: string
	party: number
	status: DayReservation['status']
	tables: string[]
	occasion?: string
	allergy?: string
	vip?: boolean
	staffNotes?: string
	requests?: string
	runningLate?: number
	channel?: string
	visits?: number
	noShows?: number
	/** Guest tags by name (a tag named VIP is the VIP tag). */
	tags?: string[]
	/** Coded dietary values: an allergy said without any free text. */
	codes?: string[]
	/** `pending` (deposit awaited), `paid`, `guaranteed`, or none. */
	payment?: string
	/** Minutes before "now" the booking was made (default: a few days ago). */
	madeAgo?: number
	client?: string
	lateCancels?: number
	/** Days before today of the guest's last visit. */
	lastVisitDays?: number
	/** Notes the restaurant pinned to the guest (shown only with the guest grant). */
	pinned?: string[]
	/** For a finished party: minutes ago they left (so their table may still be resetting). */
	finishedAgo?: number
	/** For a no-show: minutes ago they were marked (default 6: still inside the undo window). */
	noShowAgo?: number
	/** For a party only partly at the door: how many are here. */
	arrivedCovers?: number
	/** Minutes before "now" the party was marked here (default 7). */
	arrivedAgo?: number
	/** Longer than a turn: minutes the table is kept. */
	durationMin?: number
	/** The defined combination the tables are. */
	comboId?: string
}

/**
 * The sample, as offsets from "now". Tables are chosen so nothing clashes: a
 * table seated now is booked again only after its party is done.
 */
const TODAY_SEEDS: Seed[] = [
	// Left already.
	{
		offset: -150,
		name: ['Noor', 'Aziz'],
		party: 2,
		status: 'finished',
		tables: ['t1'],
		visits: 4,
	},
	{
		offset: -135,
		name: ['Hamza', 'Karim'],
		party: 4,
		status: 'finished',
		tables: ['t4'],
		// Left a few minutes ago: Table 4 is still being reset.
		finishedAgo: 4,
	},
	// On the floor now, for different lengths of time.
	{
		offset: -95,
		name: ['Sarah', 'Lindqvist'],
		phone: '+14155550101',
		party: 6,
		status: 'seated',
		tables: ['t7'],
		occasion: 'birthday',
		staffNotes: 'Cake from the kitchen at dessert',
		visits: 2,
	},
	{
		offset: -70,
		name: ['Omar', 'Rashid'],
		phone: '+14155550102',
		party: 2,
		status: 'seated',
		tables: ['t2'],
		allergy: 'Peanuts, severe',
		visits: 7,
	},
	{
		offset: -40,
		name: ['Chris', 'Tanaka'],
		phone: '+14155550103',
		party: 4,
		status: 'seated',
		tables: ['t5'],
		vip: true,
		requests: 'Prefers the quiet side',
		visits: 12,
	},
	{
		offset: -30,
		name: ['Layla', 'Mansour'],
		phone: '+14155550104',
		party: 3,
		status: 'seated',
		tables: ['t9'],
	},
	// A no-show, just marked (can still be put right).
	{
		offset: -45,
		name: ['Dana', 'Whitfield'],
		phone: '+14155550105',
		party: 2,
		status: 'no_show',
		tables: ['t6'],
		// A guest with a record: three visits, two no-shows, a late cancel.
		visits: 3,
		noShows: 2,
		lateCancels: 1,
		lastVisitDays: 40,
	},
	// Booked and late: nobody has heard from them.
	{
		offset: -35,
		name: ['Yusuf', 'Barakat'],
		phone: '+14155550106',
		party: 2,
		status: 'confirmed',
		tables: ['t3'],
		visits: 1,
	},
	// Here, waiting to be seated.
	{
		offset: -10,
		name: ['Rana', 'Khalid'],
		phone: '+14155550107',
		party: 5,
		status: 'arrived',
		tables: [],
		allergy: 'Shellfish',
		vip: true,
		visits: 9,
		channel: 'online',
		client: 'web',
		payment: 'paid',
		madeAgo: 60 * 24 * 6,
		lastVisitDays: 21,
	},
	// Only some of them are here: three of five (an arrived booking short of its
	// size, as the server keeps it), waiting for the rest.
	{
		offset: -5,
		name: ['Dina', 'Khoury'],
		phone: '+14155550155',
		party: 5,
		status: 'arrived',
		tables: [],
		arrivedCovers: 3,
		arrivedAgo: 8,
	},
	// Here ahead of their time: booked 25 minutes from now, no table of their own yet.
	{
		offset: 25,
		name: ['Karim', 'Haddad'],
		phone: '+14155550151',
		party: 3,
		status: 'arrived',
		tables: [],
		arrivedAgo: 3,
	},
	// A no-show, marked a few minutes ago (still inside the undo window): a guest
	// who then walks in is found by name and put back on this booking.
	{
		offset: -50,
		name: ['Mariam', 'Qadri'],
		phone: '+14155550154',
		party: 3,
		status: 'no_show',
		tables: [],
		noShowAgo: 6,
	},
	// A no-show marked long ago (past the undo window): the server does not let a till reopen it.
	{
		offset: -140,
		name: ['Faisal', 'Rahman'],
		phone: '+14155550153',
		party: 2,
		status: 'no_show',
		tables: [],
		noShowAgo: 100,
		visits: 2,
	},
	// Running late: they called.
	{
		offset: 0,
		name: ['Tariq', 'Saleh'],
		phone: '+14155550108',
		party: 2,
		status: 'booked',
		tables: ['t10'],
		runningLate: 15,
	},
	// The hours to come.
	{
		offset: 15,
		name: ['Elena', 'Vasquez'],
		phone: '+14155550109',
		party: 4,
		status: 'confirmed',
		tables: ['p4'],
		occasion: 'anniversary',
	},
	{
		offset: 30,
		name: ['Ahmed', 'Al-Farsi'],
		phone: '+14155550110',
		party: 8,
		status: 'booked',
		tables: ['t8'],
		occasion: 'celebration',
		staffNotes: 'Highchair for two',
		visits: 3,
	},
	{
		offset: 45,
		name: ['Priya', 'Nair'],
		party: 2,
		status: 'booked',
		tables: ['p1'],
		staffNotes: 'Window if possible',
	},
	{
		offset: 60,
		name: ['Marco', 'Donati'],
		phone: '+14155550112',
		party: 4,
		status: 'confirmed',
		tables: ['p5'],
		vip: true,
		visits: 15,
		lastVisitDays: 9,
		pinned: ['Prefers the corner table, no bread basket'],
	},
	// A tag-rich regular: three tags, nine visits.
	{
		offset: 75,
		name: ['Giulia', 'Romano'],
		phone: '+14155550116',
		party: 2,
		status: 'confirmed',
		tables: ['t4'],
		tags: ['VIP', 'Wine lover', 'Friend of chef'],
		visits: 9,
		lastVisitDays: 18,
		madeAgo: 60 * 24 * 12,
	},
	// Booked online a few minutes ago, with the deposit paid.
	{
		offset: 105,
		name: ['Nadia', 'Farouk'],
		phone: '+14155550117',
		party: 4,
		status: 'booked',
		tables: ['t9'],
		channel: 'online',
		client: 'ios',
		payment: 'paid',
		madeAgo: 4,
	},
	// Held until the deposit is paid.
	{
		offset: 90,
		name: ['Dalia', 'Mourad'],
		phone: '+14155550118',
		party: 6,
		status: 'pending_payment',
		tables: [],
		channel: 'online',
		client: 'web',
		payment: 'pending',
		madeAgo: 40,
	},
	// An allergy told in codes only: no free text to read, whoever is signed in.
	{
		offset: 135,
		name: ['Hannah', 'Berg'],
		phone: '+14155550119',
		party: 3,
		status: 'booked',
		tables: ['t5'],
		codes: ['shellfish_allergy', 'nut_allergy', 'gluten_free'],
		visits: 2,
		lastVisitDays: 30,
	},
	{
		offset: 120,
		name: ['Jonas', 'Pettersson'],
		party: 2,
		status: 'booked',
		tables: [],
	},
	// A large party: twelve at Tables 6 and 7 joined (a defined combination).
	{
		offset: 165,
		name: ['Hassan', 'Al-Mutairi'],
		phone: '+14155550152',
		party: 12,
		status: 'confirmed',
		tables: ['t6', 't7'],
		comboId: 'combo_67',
		occasion: 'birthday',
		staffNotes: 'Birthday dinner, set the long table',
		visits: 6,
	},
	{
		offset: 150,
		name: ['Chen', 'Wei'],
		phone: '+14155550114',
		party: 6,
		status: 'confirmed',
		tables: ['p6'],
		allergy: 'Tree nuts',
	},
	{
		offset: 195,
		name: ['Ines', 'Ribeiro'],
		phone: '+14155550115',
		party: 3,
		status: 'booked',
		tables: ['t10'],
	},
]

/** Bookings for a day that is not today: a book to read, at set times. */
const OTHER_DAY: Array<{ min: number; name: [string, string]; party: number }> =
	[
		{ min: 11 * 60 + 30, name: ['Alma', 'Noor'], party: 2 },
		{ min: 12 * 60, name: ['Brian', 'Cole'], party: 4 },
		{ min: 12 * 60 + 30, name: ['Hana', 'Said'], party: 3 },
		{ min: 13 * 60, name: ['Peter', 'Lund'], party: 2 },
		{ min: 13 * 60 + 15, name: ['Mona', 'Zayed'], party: 6 },
		{ min: 17 * 60 + 30, name: ['Diego', 'Ortiz'], party: 2 },
		{ min: 18 * 60, name: ['Salma', 'Haddad'], party: 4 },
		{ min: 18 * 60 + 30, name: ['Tom', 'Hughes'], party: 2 },
		{ min: 19 * 60, name: ['Reem', 'Qasim'], party: 8 },
		{ min: 19 * 60 + 30, name: ['Leo', 'Marin'], party: 4 },
		{ min: 20 * 60, name: ['Aisha', 'Bell'], party: 2 },
		{ min: 20 * 60 + 30, name: ['Kenji', 'Mori'], party: 3 },
	]

type WaitlistSeed = {
	name: readonly [string, string]
	phone: string | null
	party: number
	quoted: number
	joinedAgo: number
	/** Joined through the restaurant's own page, not at the stand. */
	online?: boolean
	/** Agreed to be texted (a stand-added entry has not: the stand cannot record it). */
	consent?: boolean
	/** Simulates an SMS-less node for this one entry: telling them queues no text. */
	noSms?: boolean
	/** Already told their table is ready: minutes ago, and minutes until the hold ends. */
	told?: { agoMin: number; holdsMin: number }
}

const WAITLIST_SEEDS: WaitlistSeed[] = [
	// Joined online and agreed to texts, but this entry simulates a node that
	// sends none: marking them ready queues no text, so the stand says to call.
	{
		name: ['Jamal', 'Hussein'] as const,
		phone: '+14155550132',
		party: 2,
		quoted: 10,
		joinedAgo: 8,
		online: true,
		consent: true,
		noSms: true,
	},
	{
		name: ['Sofia', 'Marchetti'] as const,
		phone: null,
		party: 4,
		quoted: 20,
		joinedAgo: 14,
	},
	{
		name: ['Wei', 'Zhang'] as const,
		phone: '+14155550134',
		party: 3,
		quoted: 25,
		joinedAgo: 3,
	},
	// Told their table is ready: the hold runs down.
	{
		name: ['Amira', 'Saad'] as const,
		phone: '+14155550141',
		party: 2,
		quoted: 15,
		joinedAgo: 22,
		online: true,
		consent: true,
		told: { agoMin: 4, holdsMin: 6 },
	},
	// Joined online, from the restaurant's page.
	{
		name: ['Theo', 'Laurent'] as const,
		phone: '+14155550142',
		party: 3,
		quoted: 20,
		joinedAgo: 6,
		online: true,
		consent: true,
	},
	// A number, but no consent to text it.
	{
		name: ['Bilal', 'Qureshi'] as const,
		phone: '+14155550143',
		party: 2,
		quoted: 15,
		joinedAgo: 11,
	},
]

export type DemoHostOptions = {
	now?: () => number
	/** The location's time zone (default: this device's). */
	timeZone?: string
	/** A pause before every answer, so busy states show (default: none). */
	latencyMs?: number
	/**
	 * Whether the signed-in person has the guest-details grant (default: yes).
	 * Without it the server sends only the end of a phone number, no allergy
	 * notes and no pinned notes, and the stand offers no call or text.
	 */
	canReadGuest?: boolean
	/**
	 * Whether this node sends texts at all (default: yes). A KSA node, or a
	 * location with SMS off, never does: "tell them" then queues no text.
	 */
	smsEnabled?: boolean
}

type DemoDay = {
	reservations: DayReservation[]
	blocks: Block[]
	revision: number
	/** Who works which section, by service. */
	sections?: Array<{
		serviceId: string
		sectionId: string
		staffId: string | null
		serverLabel: string | null
	}>
}

const refuse = (status: number, code: string) => new HostApiError(status, code)

/**
 * A number as the server stores it (E.164, `+14155550142`), from what a host
 * typed: spaces and Arabic digits folded, `00` for the plus, a bare ten digit
 * number as the demo's own country (+1), a national number with a trunk zero
 * as the Gulf's (+966).
 */
export function toE164(phone: string | null): string | null {
	if (!phone) return null
	const typed = foldDigits(phone.normalize('NFKD')).trim()
	const digits = typed.replace(/\D/g, '')
	if (digits === '') return null
	if (typed.startsWith('+')) return `+${digits}`
	if (digits.startsWith('00')) return `+${digits.slice(2)}`
	if (digits.startsWith('0')) return `+966${digits.slice(1)}`
	return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

/** The device's own time zone, UTC when it cannot say. */
function deviceZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
	} catch {
		return 'UTC'
	}
}

export function createDemoHostApi(options: DemoHostOptions = {}): HostApi {
	const clock = options.now ?? (() => Date.now())
	const timeZone = options.timeZone ?? deviceZone()
	const latency = options.latencyMs ?? 0
	/** The connection is down (a control switches it): every call fails as an unreachable server does. */
	let offline = false
	const wait = async () => {
		if (latency > 0) await new Promise<void>((r) => setTimeout(r, latency))
		if (offline) throw new HostApiError(0, 'network_unavailable')
	}

	/** The guest-details grant, and whether texts go out, switchable while the stand is open. */
	let canRead = options.canReadGuest ?? true
	let smsEnabled = options.smsEnabled ?? true

	const today = () => zonedDate(clock(), timeZone)
	const at = (date: string, minutes: number) =>
		zonedEpoch(date, minutes, timeZone)
	const seedDate = today()
	/** The clock the sample is built around, to the quarter hour. */
	const baseMin =
		Math.floor(zonedMinutes(clock(), timeZone) / SLOT_MIN) * SLOT_MIN

	let sequence = 0
	const nextId = (prefix: string) => `${prefix}_demo_${++sequence}`
	const code = () =>
		Array.from(
			{ length: 6 },
			() => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)],
		).join('')

	const tableById = new Map(TABLES.map((t) => [t.id, t]))
	const labelOf = (ids: string[]) =>
		ids.map((id) => tableById.get(id)?.label ?? id)

	function makeReservation(input: {
		date: string
		startMin: number
		party: number
		status: DayReservation['status']
		tables: string[]
		name?: [string, string] | null
		phone?: string | null
		occasion?: string | null
		allergy?: string | null
		vip?: boolean
		staffNotes?: string | null
		requests?: string | null
		runningLate?: number | null
		channel?: string
		durationMin?: number
		visits?: number
		noShows?: number
		tags?: string[]
		codes?: string[]
		payment?: string
		madeAgo?: number
		client?: string
		lateCancels?: number
		lastVisitDays?: number
		pinned?: string[]
		arrivedAt?: number | null
		seatedAt?: number | null
		finishedAt?: number | null
		noShowAt?: number | null
		arrivedCovers?: number | null
		seatedCovers?: number | null
		comboId?: string | null
	}): DayReservation {
		const durationMin = input.durationMin ?? (input.party >= 6 ? 120 : 90)
		const startAt = at(input.date, input.startMin)
		const [first, last] = input.name ?? ['', '']
		const id = nextId('rsv')
		const now = clock()
		const codes = input.codes ?? []
		// The server marks any dietary value as an allergy flag.
		const flagged = Boolean(input.allergy) || codes.length > 0
		const tagNames = [...(input.vip ? ['VIP'] : []), ...(input.tags ?? [])]
		const uniqueTags = [...new Set(tagNames)]
		return reservationSchema.parse({
			id,
			version: 1,
			confirmationCode: code(),
			businessDate: input.date,
			status: input.status,
			channel: input.channel ?? 'phone',
			client: input.client ?? (input.channel === 'online' ? 'web' : 'operator'),
			createdAt: now - (input.madeAgo ?? 60 * 24 * 3) * MIN,
			paymentStatus: input.payment ?? 'none',
			dietaryCodes: codes,
			partySize: input.party,
			localStartMin: input.startMin,
			time: clockLabel(input.startMin),
			startAt,
			endAt: startAt + durationMin * MIN,
			durationMin,
			serviceId: serviceAt(input.startMin)?.id ?? null,
			tableIds: input.tables,
			tableLabels: labelOf(input.tables),
			runningLateMin: input.runningLate ?? null,
			occasion: input.occasion ?? null,
			staffNotes: input.staffNotes ?? null,
			guestRequests: input.requests ?? null,
			dietaryNotes:
				input.allergy ?? (codes.length > 0 ? codes.join(', ') : null),
			hasAllergy: flagged,
			comboId: input.comboId ?? null,
			arrivedCovers: input.arrivedCovers ?? null,
			seatedCovers: input.seatedCovers ?? null,
			arrivedAt: input.arrivedAt ?? null,
			seatedAt: input.seatedAt ?? null,
			finishedAt: input.finishedAt ?? null,
			noShowAt: input.noShowAt ?? null,
			guest: input.name
				? {
						id: nextId('gst'),
						name: `${first} ${last}`.trim(),
						firstName: first,
						lastName: last,
						phone: input.phone ?? null,
						allergyNotes: input.allergy ?? null,
						hasAllergy: flagged,
						visits: input.visits ?? 0,
						noShows: input.noShows ?? 0,
						lateCancels: input.lateCancels ?? 0,
						lastVisitAt:
							input.lastVisitDays !== undefined
								? now - input.lastVisitDays * 24 * 60 * MIN
								: null,
						tags: uniqueTags.map((name) => ({
							id: `tag_${name.toLowerCase().replace(/\W+/g, '_')}`,
							name,
						})),
						pinnedNotes: (input.pinned ?? []).map((body, index) => ({
							id: `note_${index}`,
							body,
						})),
					}
				: null,
		})
	}

	/** Tables of one room are free for a stretch of time when no live booking or block touches it. */
	function busy(
		day: DemoDay,
		tableId: string,
		from: number,
		to: number,
		ignoreId?: string,
	) {
		const now = clock()
		const table = tableById.get(tableId)
		// The server keeps a table through its reset buffer after each stay: a
		// window is the stay plus the buffer, and so is what a booking holds.
		const reset = (table?.resetBufferMin ?? 0) * MIN
		const booked = day.reservations.some((r) => {
			if (r.id === ignoreId || !r.tableIds.includes(tableId)) return false
			if (!(
				['booked', 'confirmed', 'arrived'].includes(r.status) || isOnFloor(r)
			))
				return false
			// A party still sitting past its time holds the table until it leaves.
			const end = isOnFloor(r) ? Math.max(r.endAt, now) : r.endAt
			return r.startAt < to + reset && end + reset > from
		})
		const blocked = day.blocks.some(
			(b) =>
				(b.tableId ? b.tableId === tableId : b.areaId === table?.areaId) &&
				b.startAt < to &&
				b.endAt > from,
		)
		return booked || blocked
	}

	/** Smallest free table that takes the party (the host's own preference when the booking names one). */
	function suggest(
		day: DemoDay,
		party: number,
		from: number,
		to: number,
		ignoreId?: string,
	) {
		return (
			TABLES.filter(
				(t) => t.maxCovers >= party && !busy(day, t.id, from, to, ignoreId),
			).sort((a, b) => a.maxCovers - b.maxCovers)[0] ?? null
		)
	}

	/**
	 * The tables for a party no single table seats: a defined combination whose
	 * tables are all free for the stay (the smallest that seats them).
	 */
	function suggestCombo(
		day: DemoDay,
		party: number,
		from: number,
		to: number,
		ignoreId?: string,
	) {
		return (
			COMBOS.filter(
				(combo) =>
					combo.maxCovers >= party &&
					combo.tableIds.every((id) => !busy(day, id, from, to, ignoreId)),
			).sort((a, b) => a.maxCovers - b.maxCovers)[0] ?? null
		)
	}

	function seedToday(): DemoDay {
		const now = clock()
		const day: DemoDay = { reservations: [], blocks: [], revision: 1 }
		for (const seed of TODAY_SEEDS) {
			const startMin = baseMin + seed.offset
			const startAt = at(seedDate, startMin)
			// Sample times are built around a clock kept inside service hours; a
			// real clock outside them (early morning) never puts a time in the future.
			const past = (value: number) => Math.min(value, now - MIN)
			day.reservations.push(
				makeReservation({
					date: seedDate,
					startMin,
					party: seed.party,
					status: seed.status,
					tables: seed.tables,
					name: seed.name,
					phone: seed.phone ?? null,
					occasion: seed.occasion,
					allergy: seed.allergy,
					vip: seed.vip,
					staffNotes: seed.staffNotes,
					requests: seed.requests,
					runningLate: seed.runningLate,
					channel: seed.channel,
					visits: seed.visits,
					noShows: seed.noShows,
					tags: seed.tags,
					codes: seed.codes,
					payment: seed.payment,
					madeAgo: seed.madeAgo,
					client: seed.client,
					lateCancels: seed.lateCancels,
					lastVisitDays: seed.lastVisitDays,
					pinned: seed.pinned,
					durationMin: seed.durationMin,
					comboId: seed.comboId,
					arrivedCovers: seed.arrivedCovers,
					arrivedAt:
						seed.status === 'arrived'
							? past(now - (seed.arrivedAgo ?? 7) * MIN)
							: seed.status === 'seated' || seed.status === 'finished'
								? past(startAt)
								: null,
					seatedAt:
						seed.status === 'seated'
							? past(startAt + 3 * MIN)
							: seed.status === 'finished'
								? past(startAt + 3 * MIN)
								: null,
					finishedAt:
						seed.status === 'finished'
							? seed.finishedAgo !== undefined
								? now - seed.finishedAgo * MIN
								: past(Math.max(startAt + 80 * MIN, now - 40 * MIN))
							: null,
					noShowAt:
						seed.status === 'no_show'
							? now - (seed.noShowAgo ?? 6) * MIN
							: null,
				}),
			)
		}
		// Table P3 is taped off for the afternoon.
		day.blocks.push({
			id: 'blk_demo_1',
			tableId: 'p3',
			areaId: null,
			startAt: at(seedDate, baseMin - 60),
			endAt: at(seedDate, baseMin + 150),
			reason: 'Wobbly leg',
		})
		// Table P2 is kept for a private party from a little later.
		day.blocks.push({
			id: 'blk_demo_2',
			tableId: 'p2',
			areaId: null,
			startAt: at(seedDate, baseMin + 45),
			endAt: at(seedDate, baseMin + 200),
			reason: 'Private party',
		})
		// Tonight's servers are on: Window and Floor have theirs, the patio waits for one.
		const service = serviceAt(baseMin)
		if (service)
			day.sections = [
				{
					serviceId: service.id,
					sectionId: 'sec_window',
					staffId: 'staff_maya',
					serverLabel: 'Maya S.',
				},
				{
					serviceId: service.id,
					sectionId: 'sec_floor',
					staffId: 'staff_omar',
					serverLabel: 'Omar H.',
				},
			]
		return day
	}

	function seedOther(date: string): DemoDay {
		const day: DemoDay = { reservations: [], blocks: [], revision: 1 }
		let hash = 7
		for (const char of date) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
		const rotated = [
			...OTHER_DAY.slice(hash % OTHER_DAY.length),
			...OTHER_DAY.slice(0, hash % OTHER_DAY.length),
		].slice(0, 7 + (hash % 5))
		const past = date < today()
		rotated
			.sort((a, b) => a.min - b.min)
			.forEach((entry, index) => {
				const startAt = at(date, entry.min)
				const duration = entry.party >= 6 ? 120 : 90
				const table = suggest(
					day,
					entry.party,
					startAt,
					startAt + duration * MIN,
				)
				day.reservations.push(
					makeReservation({
						date,
						startMin: entry.min,
						party: entry.party,
						status: past
							? index === 3
								? 'no_show'
								: 'finished'
							: index % 2 === 0
								? 'confirmed'
								: 'booked',
						tables: table ? [table.id] : [],
						name: entry.name,
						phone: `+1415555${String(2000 + (hash % 500) + index)}`,
						arrivedAt: past && index !== 3 ? startAt : null,
						seatedAt: past && index !== 3 ? startAt + 3 * MIN : null,
						finishedAt: past && index !== 3 ? startAt + 85 * MIN : null,
						noShowAt: past && index === 3 ? startAt + 20 * MIN : null,
					}),
				)
			})
		return day
	}

	const days = new Map<string, DemoDay>([[seedDate, seedToday()]])
	const dayOf = (date: string) => {
		let day = days.get(date)
		if (!day) {
			day = seedOther(date)
			days.set(date, day)
		}
		return day
	}
	const touch = (day: DemoDay) => {
		day.revision += 1
	}

	/** Extra state a reservation needs to be put back by an undo. */
	const priorTables = new Map<string, string[]>()
	const priorStatus = new Map<string, DayReservation['status']>()

	function locate(id: string) {
		for (const [date, day] of days) {
			const index = day.reservations.findIndex((r) => r.id === id)
			if (index !== -1)
				return { date, day, index, reservation: day.reservations[index]! }
		}
		throw refuse(404, 'not_found')
	}

	function update(id: string, patch: Partial<DayReservation>) {
		const found = locate(id)
		const next = {
			...found.reservation,
			...patch,
			version: found.reservation.version + 1,
		} as DayReservation
		found.day.reservations[found.index] = next
		touch(found.day)
		return next
	}

	const checkVersion = (r: DayReservation, expected?: number) => {
		if (expected !== undefined && expected !== r.version)
			throw refuse(409, 'stale_version')
	}
	const requireToday = (r: DayReservation) => {
		if ((r as { businessDate?: string }).businessDate !== today())
			throw refuse(409, 'not_today')
	}

	// ---- Waitlist -----------------------------------------------------------

	const waitlist: WaitlistEntry[] = []
	let waitlistSort = 0
	const activeWaitlist = () =>
		waitlist.filter((e) =>
			['waiting', 'notified', 'on_the_way'].includes(e.status),
		)
	const quoteFor = (party: number) => {
		const ahead = activeWaitlist().length
		return Math.round((8 + ahead * 6 + (party > 4 ? 6 : 0)) / 5) * 5
	}
	function newWaitlistEntry(input: {
		displayName: string
		party: number
		phone: string | null
		quoted: number
		joinedAt: number
		online?: boolean
		/** The guest agreed to be texted (only a guest who joined online can have). */
		consent?: boolean
		told?: { notifiedAt: number; deadlineAt: number }
	}): WaitlistEntry {
		const [first = '', ...rest] = input.displayName.trim().split(/\s+/)
		waitlistSort += 1
		return {
			id: nextId('wl'),
			locationId: DEMO_LOCATION,
			businessDate: seedDate,
			guestId: null,
			displayName: input.displayName.trim(),
			firstName: first,
			lastName: rest.join(' '),
			phone: input.phone,
			email: null,
			partySize: input.party,
			areaPrefId: null,
			channel: input.online ? 'remote' : 'walk_in',
			status: input.told ? 'notified' : 'waiting',
			quotedMin: input.quoted,
			quotedReadyAt: input.joinedAt + input.quoted * MIN,
			notifiedAt: input.told?.notifiedAt ?? null,
			responseDeadlineAt: input.told?.deadlineAt ?? null,
			reservationId: null,
			sortKey: waitlistSort,
			notes: null,
			smsOptIn: Boolean(input.phone) && input.consent === true,
			locale: null,
			version: 1,
			joinedAt: input.joinedAt,
			createdAt: input.joinedAt,
			position: waitlistSort,
		}
	}
	/** Entries that simulate a node that sends no texts, whatever the guest agreed to. */
	const noSmsEntries = new Set<string>()
	for (const seed of WAITLIST_SEEDS) {
		const entry = newWaitlistEntry({
			displayName: seed.name.join(' '),
			party: seed.party,
			phone: seed.phone,
			quoted: seed.quoted,
			joinedAt: clock() - seed.joinedAgo * MIN,
			online: seed.online,
			consent: seed.consent,
			told: seed.told
				? {
						notifiedAt: clock() - seed.told.agoMin * MIN,
						deadlineAt: clock() + seed.told.holdsMin * MIN,
					}
				: undefined,
		})
		waitlist.push(entry)
		if (seed.noSms) noSmsEntries.add(entry.id)
	}
	/**
	 * The server's tick: a party told their table is ready who has not answered
	 * by the end of their hold is no longer in line (`no_response`), whether or
	 * not a text was ever sent. Looked at whenever the waitlist is read.
	 */
	function expireHolds() {
		const now = clock()
		for (const entry of waitlist) {
			if (
				entry.status === 'notified' &&
				typeof entry.responseDeadlineAt === 'number' &&
				entry.responseDeadlineAt <= now
			)
				updateEntry(entry.id, { status: 'no_response' })
		}
	}
	const entryOf = (id: string) => {
		const entry = waitlist.find((e) => e.id === id)
		if (!entry) throw refuse(404, 'not_found')
		return entry
	}
	const updateEntry = (id: string, patch: Partial<WaitlistEntry>) => {
		const index = waitlist.findIndex((e) => e.id === id)
		const next = {
			...waitlist[index]!,
			...patch,
			version: waitlist[index]!.version + 1,
		}
		waitlist[index] = next
		return next
	}

	// ---- Placing a party ------------------------------------------------------

	/**
	 * Checks tables for a party seated now: each must exist, have nobody on it,
	 * not be blocked, and (unless the host insists) not be booked before the
	 * party would be done. A table smaller than the party is the host's call.
	 */
	function checkTables(
		tableIds: string[],
		durationMin: number,
		overbook: boolean,
		ignoreId?: string,
	) {
		if (tableIds.length === 0) throw refuse(400, 'table_required')
		const now = clock()
		const day = dayOf(today())
		for (const tableId of tableIds) {
			const table = tableById.get(tableId)
			if (!table) throw refuse(404, 'not_found')
			const seated = day.reservations.some(
				(r) =>
					r.id !== ignoreId && isOnFloor(r) && r.tableIds.includes(tableId),
			)
			const taped = day.blocks.some(
				(b) =>
					(b.tableId ? b.tableId === tableId : b.areaId === table.areaId) &&
					b.startAt <= now &&
					b.endAt > now,
			)
			if (seated || taped) throw refuse(409, 'table_occupied')
			if (
				!overbook &&
				busy(day, tableId, now, now + durationMin * MIN, ignoreId)
			)
				throw refuse(409, 'table_occupied')
		}
	}

	/** Statuses of a booking that holds its tables (the server's active occupancy). */
	const HOLDS_TABLE = [
		'pending_payment',
		'booked',
		'confirmed',
		'arrived',
		'seated',
	]
	/** The server's default freeze: a booking this close (or already begun) is not moved to make room. */
	const FREEZE_MIN = 30

	/**
	 * Puts a booking on tables the way the server's assignment does, judged
	 * against the booking's own window (its start to its end, plus each table's
	 * reset buffer): a block over it is `table_blocked`; another booking over it is
	 * moved to another table when it is soft and not due within the freeze window,
	 * else `locked_table_conflict` (a party sitting there is never moved). An
	 * overbook skips all of it.
	 *
	 * A party on the floor counts by its booked window too, as on the server (its
	 * table is held to its booked end, however late it sat): a booking given a
	 * table for later is judged by that alone. Seating someone now also refuses
	 * a table someone is still sitting at, which the server's window check does
	 * not; the stand never sends that seating (such a table reads "taken").
	 */
	function checkBookingTables(
		r: DayReservation,
		tableIds: string[],
		overbook: boolean,
		/** The party sits down now (not a table given to a booking for its own time). */
		seatingNow: boolean,
	) {
		if (tableIds.length === 0) throw refuse(400, 'table_required')
		const now = clock()
		const date = (r as { businessDate?: string }).businessDate ?? today()
		const day = dayOf(date)
		const moves: Array<{ other: DayReservation; to: string }> = []
		for (const tableId of tableIds) {
			const table = tableById.get(tableId)
			if (!table) throw refuse(404, 'not_found')
			// Taped off right now: nobody sits there, whatever the host insists.
			if (
				day.blocks.some(
					(b) =>
						(b.tableId ? b.tableId === tableId : b.areaId === table.areaId) &&
						b.startAt <= now &&
						b.endAt > now,
				)
			)
				throw refuse(409, 'table_occupied')
			if (overbook) continue
			const reset = table.resetBufferMin * MIN
			const from = r.startAt
			const until = r.endAt + reset
			const taped = day.blocks.some(
				(b) =>
					(b.tableId ? b.tableId === tableId : b.areaId === table.areaId) &&
					b.startAt < until &&
					b.endAt > from,
			)
			if (taped) throw refuse(409, 'table_blocked')
			const overlapping = day.reservations.filter(
				(o) =>
					o.id !== r.id &&
					HOLDS_TABLE.includes(o.status) &&
					o.tableIds.includes(tableId) &&
					o.startAt < until &&
					o.endAt + reset > from,
			)
			for (const other of overlapping) {
				const soft = ['pending_payment', 'booked', 'confirmed'].includes(
					other.status,
				)
				const frozen =
					other.startAt >= now - 12 * 60 * MIN &&
					other.startAt - now <= FREEZE_MIN * MIN
				if (!soft || frozen) throw refuse(409, 'locked_table_conflict')
				const replacement = TABLES.filter(
					(t) =>
						t.maxCovers >= other.partySize &&
						!tableIds.includes(t.id) &&
						!moves.some((m) => m.to === t.id) &&
						!busy(day, t.id, other.startAt, other.endAt, other.id),
				).sort((a, b) => a.maxCovers - b.maxCovers)[0]
				if (!replacement) throw refuse(409, 'reflow_failed')
				moves.push({ other, to: replacement.id })
			}
			// Seating now, someone still sitting there whose booked time does not reach
			// this window (an early arrival): the table is not free to put them at yet.
			if (
				seatingNow &&
				day.reservations.some(
					(o) => o.id !== r.id && isOnFloor(o) && o.tableIds.includes(tableId),
				)
			)
				throw refuse(409, 'table_occupied')
		}
		for (const { other, to } of moves)
			update(other.id, { tableIds: [to], tableLabels: labelOf([to]) })
	}

	function createSeated(input: {
		party: number
		tableIds: string[]
		name: string | null
		channel: string
	}) {
		const now = clock()
		const date = today()
		const [first = '', ...rest] = (input.name ?? '').trim().split(/\s+/)
		const made = makeReservation({
			date,
			startMin: zonedMinutes(now, timeZone),
			party: input.party,
			status: 'seated',
			tables: input.tableIds,
			name: input.name?.trim() ? [first, rest.join(' ')] : null,
			channel: input.channel,
			durationMin: DEFAULT_TURN_MIN,
			madeAgo: 0,
			arrivedAt: now,
			seatedAt: now,
		})
		// A walk-in starts when it is seated, to the minute.
		const reservation = {
			...made,
			startAt: now,
			endAt: now + DEFAULT_TURN_MIN * MIN,
		} as DayReservation
		const day = dayOf(date)
		day.reservations.push(reservation)
		touch(day)
		return reservation
	}

	// ---- Availability -----------------------------------------------------------

	function slotsFor(date: string, party: number, excludeId?: string) {
		const day = dayOf(date)
		const now = clock()
		const duration = party >= 6 ? 120 : DEFAULT_TURN_MIN
		const slots: Array<{
			localStartMin: number
			time: string
			available: boolean
			suggestedTableIds: string[]
		}> = []
		for (const service of SERVICES) {
			for (
				let minute = service.firstSeatingMin;
				minute <= service.lastSeatingMin;
				minute += SLOT_MIN
			) {
				const from = at(date, minute)
				const free =
					from >= now - 5 * MIN
						? suggest(day, party, from, from + duration * MIN, excludeId)
						: null
				// No table seats them alone: a defined combination may.
				const combo =
					from >= now - 5 * MIN && free === null
						? suggestCombo(day, party, from, from + duration * MIN, excludeId)
						: null
				slots.push({
					localStartMin: minute,
					time: clockLabel(minute),
					available: free !== null || combo !== null,
					suggestedTableIds: free ? [free.id] : (combo?.tableIds ?? []),
				})
			}
		}
		return slots
	}

	// ---- The feed -----------------------------------------------------------------

	function pacing(day: DemoDay) {
		const counted = day.reservations.filter(
			(r) => !['cancelled', 'no_show'].includes(r.status),
		)
		return SERVICES.flatMap((service) => {
			const rows = []
			for (
				let minute = service.firstSeatingMin;
				minute <= service.lastSeatingMin;
				minute += SLOT_MIN
			) {
				const starting = counted.filter(
					(r) =>
						r.localStartMin >= minute && r.localStartMin < minute + SLOT_MIN,
				)
				rows.push({
					localMin: minute,
					time: clockLabel(minute),
					serviceId: service.id,
					bookedCovers: starting.reduce((sum, r) => sum + r.partySize, 0),
					partyCount: starting.length,
					maxCovers: SLOT_CAP,
					// A rule sets this cap: it is the restaurant's own, not the server's default.
					maxCoversIsDefault: false,
				})
			}
			return rows
		})
	}

	function feedFor(date: string): { feed: DayFeed; etag: string } {
		const day = dayOf(date)
		const etag = `"demo-${date}-${day.revision}-${canRead ? 'g' : 'n'}"`
		const feed = dayFeedSchema.parse({
			locationId: DEMO_LOCATION,
			businessDate: date,
			etag,
			dayState: 'open',
			settings: { timeZone },
			closedLabel: null,
			areas: AREAS,
			tables: TABLES,
			combos: COMBOS,
			elements: ELEMENTS,
			blocks: day.blocks,
			services: SERVICES,
			pacing: pacing(day),
			reservations: day.reservations.map(forGrant),
			sectionLayouts: SECTION_LAYOUTS,
			sectionAssignments: day.sections ?? [],
		})
		return { feed, etag }
	}

	// ---- The guest-details grant: what the server leaves out without it -----------

	/** Only the end of a number, as the server sends it to someone without the grant. */
	const masked = (phone: string | null | undefined) =>
		phone ? `••••${phone.replace(/\D/g, '').slice(-4)}` : null
	const forGrant = (r: DayReservation): DayReservation =>
		canRead || !r.guest
			? r
			: ({
					...r,
					dietaryNotes: null,
					guest: {
						...r.guest,
						phone: masked(r.guest.phone),
						email: null,
						allergyNotes: null,
						pinnedNotes: [],
					},
				} as DayReservation)
	const entryForGrant = (entry: WaitlistEntry): WaitlistEntry =>
		canRead
			? entry
			: { ...entry, phone: masked(entry.phone), email: null, notes: null }

	// ---- Idempotency: the same key answers the same way ---------------------------

	const answered = new Map<string, unknown>()
	async function once<T>(key: string | undefined, run: () => T): Promise<T> {
		if (key && answered.has(key)) return answered.get(key) as T
		const result = run()
		if (key) answered.set(key, result)
		return result
	}

	// ---- The client ------------------------------------------------------------------

	const grant = (): PosReservationsTokenResponse => ({
		token: 'demo-token-xxxxxxxxxxxxxxxxxxxxxxxx',
		expiresAt: clock() + 60 * 60 * MIN,
		locationId: DEMO_LOCATION,
		canReadGuest: canRead,
		features: { waitlist: true, online: true },
	})

	const api: HostApi = {
		async grant() {
			await wait()
			return grant()
		},
		forget() {},

		async day(etag?: string, date?: string) {
			await wait()
			const { feed, etag: current } = feedFor(date ?? today())
			if (etag && etag === current) return { unchanged: true as const }
			return { feed, etag: current }
		},

		async servers(window: { from: number; to: number }) {
			await wait()
			return {
				available: true,
				servers: DEMO_SERVERS.map((person, index) => ({
					staffId: person.staffId,
					firstName: person.firstName,
					lastInitial: person.lastInitial,
					position: 'Server',
					onClock: person.clock,
					shift: person.clock
						? null
						: {
								startAt: window.from + index * 30 * MIN,
								endAt: window.to,
							},
				})),
			}
		},

		async assignSections(input) {
			await wait()
			const day = dayOf(input.date)
			day.sections = [
				...(day.sections ?? []).filter(
					(row) => row.serviceId !== input.serviceId,
				),
				...input.assignments.map((row) => ({
					serviceId: input.serviceId,
					sectionId: row.sectionId,
					staffId: row.staffId,
					serverLabel: row.serverLabel.trim() || null,
				})),
			]
			touch(day)
		},

		async waitlist() {
			await wait()
			expireHolds()
			const entries = activeWaitlist()
			return {
				locationId: DEMO_LOCATION,
				businessDate: today(),
				now: clock(),
				waitlistResponseMin: WAITLIST_RESPONSE_MIN,
				counts: {
					active: entries.length,
					waiting: entries.filter((e) => e.status === 'waiting').length,
					notified: entries.filter((e) => e.status === 'notified').length,
					onTheWay: entries.filter((e) => e.status === 'on_the_way').length,
				},
				// Parties whose hold just ran out are listed too: the stand offers a way back.
				entries: [
					...entries,
					...waitlist.filter(
						(e) =>
							e.status === 'no_response' &&
							clock() - (e.responseDeadlineAt ?? 0) <= 30 * MIN,
					),
				].map(entryForGrant),
			}
		},

		async availability(
			date: string,
			partySize: number,
			excludeReservationId?: string,
		) {
			await wait()
			return availabilitySchema.parse({
				businessDate: date,
				closed: false,
				slots: slotsFor(date, partySize, excludeReservationId),
			})
		},

		async transition(
			reservationId: string,
			toStatus: StatusTarget,
			options: {
				tableIds?: string[]
				comboId?: string
				expectedVersion?: number
				reason?: string
				arrivedCovers?: number
				seatedCovers?: number
				overbook?: boolean
				overbookReason?: string
			} = {},
		) {
			await wait()
			const r = locate(reservationId).reservation
			checkVersion(r, options.expectedVersion)
			const now = clock()
			const from = r.status
			// The steps the server's status route allows a till (its transition map):
			// there are no partial statuses, only counts kept on `arrived` and `seated`.
			const allowed: Record<StatusTarget, string[]> = {
				confirmed: ['booked'],
				arrived: ['booked', 'confirmed'],
				seated: ['booked', 'confirmed', 'arrived'],
				finished: ['seated'],
				no_show: ['booked', 'confirmed', 'arrived'],
				cancelled: ['booked', 'confirmed', 'arrived'],
			}
			if (!allowed[toStatus]?.includes(from))
				throw refuse(409, 'invalid_status_transition')
			// A deposit or a card on it: cancelling and a no-show touch the money, a manager's.
			if (
				(toStatus === 'cancelled' || toStatus === 'no_show') &&
				r.paymentStatus !== 'none'
			)
				throw refuse(409, 'manager_required')
			// A till works the live day: only a booking can be confirmed or cancelled ahead.
			if (toStatus !== 'confirmed' && toStatus !== 'cancelled') requireToday(r)
			if (toStatus === 'no_show' && now < r.startAt + NO_SHOW_GRACE_MIN * MIN)
				throw refuse(409, 'too_early')
			if (toStatus === 'seated') {
				const tableIds = options.tableIds?.length
					? options.tableIds
					: r.tableIds
				if (tableIds.length === 0) throw refuse(400, 'table_required')
				// Put on the tables the way an assignment does (a booking's own window).
				const changed =
					tableIds.length !== r.tableIds.length ||
					!tableIds.every((id) => r.tableIds.includes(id))
				if (changed)
					checkBookingTables(r, tableIds, options.overbook === true, true)
				else checkTables(tableIds, 0, true, r.id)
				priorTables.set(r.id, r.tableIds)
				return {
					reservation: update(r.id, {
						status: 'seated',
						tableIds,
						tableLabels: labelOf(tableIds),
						comboId: changed ? (options.comboId ?? null) : (r.comboId ?? null),
						arrivedAt: r.arrivedAt ?? now,
						seatedAt: now,
						// Without a count the server seats as many as were marked here.
						seatedCovers:
							options.seatedCovers ??
							r.seatedCovers ??
							r.arrivedCovers ??
							r.partySize,
					}),
				}
			}
			if (toStatus === 'arrived')
				return {
					reservation: update(r.id, {
						status: 'arrived',
						arrivedAt: now,
						arrivedCovers: Math.min(
							options.arrivedCovers ?? r.arrivedCovers ?? r.partySize,
							r.partySize,
						),
					}),
				}
			if (toStatus === 'finished')
				return {
					reservation: update(r.id, { status: 'finished', finishedAt: now }),
				}
			if (toStatus === 'no_show') {
				priorStatus.set(r.id, from)
				return {
					reservation: update(r.id, { status: 'no_show', noShowAt: now }),
				}
			}
			return { reservation: update(r.id, { status: toStatus }) }
		},

		async changeParty(
			reservationId: string,
			change: {
				partySize?: number
				time?: string
				localStartMin?: number
				durationMin?: number
			},
			expectedVersion?: number,
		) {
			await wait()
			const r = locate(reservationId).reservation
			checkVersion(r, expectedVersion)
			const now = clock()
			const seated = isOnFloor(r)
			// A party at the door or at its table: its size and stay change, never where it sits.
			const present = r.status === 'arrived' || seated
			if (!['booked', 'confirmed', 'arrived', 'seated'].includes(r.status))
				throw refuse(409, 'invalid_status')
			const movesTime =
				Boolean(change.time) || change.localStartMin !== undefined
			const resizes =
				change.partySize !== undefined && change.partySize !== r.partySize
			const lengthens =
				change.durationMin !== undefined && change.durationMin !== r.durationMin
			// A deposit, a card or an experience: a size, time or stay change is a manager's.
			if (
				(movesTime || resizes || lengthens) &&
				(r.paymentStatus !== 'none' || r.status === 'pending_payment')
			)
				throw refuse(409, 'manager_required')
			// A till only keeps a table longer, and no longer than it may set.
			if (change.durationMin !== undefined) {
				if (change.durationMin < r.durationMin)
					throw refuse(409, 'manager_required')
				if (change.durationMin > 360) throw refuse(409, 'manager_required')
			}
			// Someone already at the table has no time to move.
			if (present && movesTime) throw refuse(409, 'invalid_status')
			const date = (r as { businessDate?: string }).businessDate ?? today()
			const patch: Partial<DayReservation> = {}
			const party = change.partySize ?? r.partySize
			if (change.partySize) patch.partySize = change.partySize
			let startMin = r.localStartMin
			if (movesTime) {
				const [h = 0, m = 0] = (change.time ?? '').split(':').map(Number)
				startMin = change.localStartMin ?? h * 60 + m
				const startAt = at(date, startMin)
				// A till moves a booking forward, never into the past.
				if (startMin !== r.localStartMin && startAt < now - 15 * MIN)
					throw refuse(409, 'in_the_past')
				Object.assign(patch, {
					localStartMin: startMin,
					time: clockLabel(startMin),
					startAt,
					endAt: startAt + r.durationMin * MIN,
					serviceId: serviceAt(startMin)?.id ?? null,
				})
			}
			// How long the table is kept: the stay asked for, else (for a new size) a turn.
			const durationMin = change.durationMin ?? r.durationMin
			if (change.durationMin !== undefined) {
				patch.durationMin = durationMin
				patch.endAt = (patch.startAt ?? r.startAt) + durationMin * MIN
			}
			const startAt = at(date, startMin)
			const day = dayOf(date)
			if (present) {
				// A party at the door or the table stays on its tables: growing past their
				// seats is a manager's call (a bigger table), never done by itself.
				const seats = r.tableIds.reduce(
					(sum, id) => sum + (tableById.get(id)?.maxCovers ?? 0),
					0,
				)
				if (resizes && r.tableIds.length > 0 && party > seats)
					throw refuse(409, 'party_too_large_for_table')
			} else if (!lengthens || resizes || movesTime) {
				// A table the party no longer fits (or the new time clashes on) is let go.
				const keep = r.tableIds.filter((id) => {
					const t = tableById.get(id)
					return (
						t &&
						t.maxCovers >= party &&
						!busy(day, id, startAt, startAt + durationMin * MIN, r.id)
					)
				})
				if (keep.length !== r.tableIds.length)
					Object.assign(patch, { tableIds: keep, tableLabels: labelOf(keep) })
			}
			return { reservation: update(r.id, patch) }
		},

		async runningLate(
			reservationId: string,
			minutes: number,
			expectedVersion: number,
		) {
			await wait()
			const r = locate(reservationId).reservation
			checkVersion(r, expectedVersion)
			return {
				reservation: update(r.id, {
					runningLateMin: minutes > 0 ? minutes : null,
				}),
			}
		},

		async waitlistQuote(partySize: number) {
			await wait()
			const quotedMin = quoteFor(partySize)
			return {
				locationId: DEMO_LOCATION,
				businessDate: today(),
				partySize,
				quotedMin,
				quotedReadyAt: clock() + quotedMin * MIN,
				position: activeWaitlist().length + 1,
				now: clock(),
			}
		},

		async undo(reservationId: string) {
			await wait()
			const r = locate(reservationId).reservation
			const now = clock()
			requireToday(r)
			if (r.status === 'seated') {
				if (r.channel === 'walk_in') throw refuse(409, 'cannot_undo')
				if (now - (r.seatedAt ?? 0) > UNDO_WINDOW_MS)
					throw refuse(409, 'undo_window_expired')
				const tables = priorTables.get(r.id) ?? r.tableIds
				return {
					reservation: update(r.id, {
						status: 'arrived',
						seatedAt: null,
						tableIds: tables,
						tableLabels: labelOf(tables),
					}),
				}
			}
			if (r.status === 'finished') {
				if (now - (r.finishedAt ?? 0) > UNDO_WINDOW_MS)
					throw refuse(409, 'undo_window_expired')
				// Back to the table, if nobody has taken it since.
				checkTables(r.tableIds, 0, true, r.id)
				return {
					reservation: update(r.id, { status: 'seated', finishedAt: null }),
				}
			}
			if (r.status === 'no_show') {
				if (now - (r.noShowAt ?? 0) > UNDO_WINDOW_MS)
					throw refuse(409, 'undo_window_expired')
				return {
					reservation: update(r.id, {
						status: priorStatus.get(r.id) ?? 'arrived',
						noShowAt: null,
					}),
				}
			}
			throw refuse(409, 'cannot_undo')
		},

		async assign(
			reservationId: string,
			tableIds: string[],
			expectedVersion?: number,
			overbook: { overbook?: boolean; overbookReason?: string } = {},
			comboId?: string | null,
		) {
			await wait()
			const r = locate(reservationId).reservation
			checkVersion(r, expectedVersion)
			if (!['booked', 'confirmed', 'arrived', 'seated'].includes(r.status))
				throw refuse(409, 'reservation_not_active')
			// A party at the table moves for the rest of their stay; a booking, by its own window.
			const remaining = isOnFloor(r)
				? Math.max(15, Math.ceil((r.endAt - clock()) / MIN))
				: r.durationMin
			if (isOnFloor(r)) {
				checkTables(tableIds, remaining, overbook.overbook === true, r.id)
			} else {
				checkBookingTables(r, tableIds, overbook.overbook === true, false)
			}
			return {
				reservation: update(r.id, {
					tableIds,
					tableLabels: labelOf(tableIds),
					comboId: comboId ?? null,
				}),
			}
		},

		async walkIn(
			input: {
				partySize: number
				tableIds: string[]
				guestName?: string
				overbook?: boolean
				overbookReason?: string
			},
			idempotencyKey?: string,
		) {
			await wait()
			return once(idempotencyKey, () => {
				checkTables(input.tableIds, DEFAULT_TURN_MIN, input.overbook === true)
				return {
					reservation: createSeated({
						party: input.partySize,
						tableIds: input.tableIds,
						name: input.guestName?.trim() || null,
						channel: 'walk_in',
					}),
				}
			})
		},

		async book(
			input: {
				date: string
				time: string
				localStartMin?: number
				partySize: number
				firstName: string
				lastName: string
				phone: string | null
				notes: string | null
				tableIds?: string[]
			},
			idempotencyKey?: string,
		) {
			await wait()
			return once(idempotencyKey, () => {
				const [h = 0, m = 0] = input.time.split(':').map(Number)
				const startMin = input.localStartMin ?? h * 60 + m
				const slot = slotsFor(input.date, input.partySize).find(
					(s) => s.localStartMin === startMin,
				)
				if (!slot?.available) throw refuse(409, 'slot_unavailable')
				const startAt = at(input.date, startMin)
				const duration = input.partySize >= 6 ? 120 : DEFAULT_TURN_MIN
				const day = dayOf(input.date)
				// The table the host asked for, when it is free for the stay.
				const asked = (input.tableIds ?? []).filter((id) => {
					const t = tableById.get(id)
					return (
						t &&
						t.maxCovers >= input.partySize &&
						!busy(day, id, startAt, startAt + duration * MIN)
					)
				})
				if ((input.tableIds ?? []).length > 0 && asked.length === 0)
					throw refuse(409, 'slot_unavailable')
				const tables = asked.length > 0 ? asked : slot.suggestedTableIds
				const reservation = makeReservation({
					date: input.date,
					startMin,
					party: input.partySize,
					status: 'booked',
					tables,
					name: [input.firstName.trim(), input.lastName.trim()],
					phone: toE164(input.phone),
					staffNotes: input.notes,
					channel: 'host',
					durationMin: duration,
					madeAgo: 0,
					// Several tables that are a defined combination stay one on the book.
					comboId:
						COMBOS.find(
							(c) =>
								c.tableIds.length === tables.length &&
								c.tableIds.every((id) => tables.includes(id)),
						)?.id ?? null,
				})
				day.reservations.push(reservation)
				touch(day)
				return { reservation }
			})
		},

		async joinWaitlist(
			input: { displayName: string; partySize: number; phone: string | null },
			idempotencyKey?: string,
		) {
			await wait()
			return once(idempotencyKey, () => {
				const quoted = quoteFor(input.partySize)
				const entry = newWaitlistEntry({
					displayName: input.displayName,
					party: input.partySize,
					// The stand cannot record that a guest agreed to texts: only the
					// restaurant's own page or app can, so a stand-added entry has none.
					phone: toE164(input.phone),
					quoted,
					joinedAt: clock(),
					consent: false,
				})
				waitlist.push(entry)
				return entry
			})
		},

		async notifyWaitlist(entryId: string, expectedVersion: number) {
			await wait()
			const entry = entryOf(entryId)
			if (entry.version !== expectedVersion) throw refuse(409, 'stale_version')
			// Only a party still waiting is told. Marking them ready never needs a
			// text: whether one was queued is the answer's to say.
			if (entry.status !== 'waiting')
				throw refuse(409, 'invalid_status_transition')
			const textQueued =
				Boolean(entry.phone) &&
				entry.smsOptIn &&
				smsEnabled &&
				!noSmsEntries.has(entry.id)
			return {
				changed: true,
				textQueued,
				entry: updateEntry(entryId, {
					status: 'notified',
					notifiedAt: clock(),
					responseDeadlineAt: clock() + WAITLIST_RESPONSE_MIN * MIN,
				}),
			}
		},

		async seatWaitlist(
			entryId: string,
			tableIds: string[],
			expectedVersion: number,
			overbook: { overbook?: boolean; overbookReason?: string } = {},
		) {
			await wait()
			const entry = entryOf(entryId)
			if (entry.version !== expectedVersion) throw refuse(409, 'stale_version')
			if (!['waiting', 'notified', 'on_the_way'].includes(entry.status))
				throw refuse(409, 'invalid_status_transition')
			checkTables(tableIds, DEFAULT_TURN_MIN, overbook.overbook === true)
			const reservation = createSeated({
				party: entry.partySize,
				tableIds,
				name: entry.displayName,
				channel: 'walk_in',
			})
			updateEntry(entryId, { status: 'seated', reservationId: reservation.id })
			return { entry: waitlist.find((e) => e.id === entryId), reservation }
		},

		async leaveWaitlist(
			entryId: string,
			expectedVersion: number,
			target: 'left' | 'no_response' | 'waiting' = 'left',
		) {
			await wait()
			expireHolds()
			const entry = entryOf(entryId)
			if (entry.version !== expectedVersion) throw refuse(409, 'stale_version')
			// The server's own steps for a waitlist party.
			const next: Record<string, string[]> = {
				waiting: ['left', 'no_response'],
				notified: ['left', 'no_response', 'waiting'],
				on_the_way: ['left', 'no_response', 'waiting'],
				no_response: ['waiting'],
			}
			if (entry.status === target) return { entry }
			if (!next[entry.status]?.includes(target))
				throw refuse(409, 'invalid_status_transition')
			// Back in line: told no longer, and the hold is cleared.
			return {
				entry: updateEntry(
					entryId,
					target === 'waiting'
						? { status: 'waiting', notifiedAt: null, responseDeadlineAt: null }
						: { status: target },
				),
			}
		},
	}

	/**
	 * What other people do while the host looks: a guest books online, cancels,
	 * changes the size, another host marks a party here. For trying how the stand
	 * tells the host (and for tests); nothing in the stand itself calls these.
	 */
	const controls: DemoControls = {
		bookOnline(input) {
			const startMin = input.startMin ?? baseMin + 150
			const party = input.party ?? 4
			const startAt = at(seedDate, startMin)
			const duration = party >= 6 ? 120 : DEFAULT_TURN_MIN
			const table = suggest(
				dayOf(seedDate),
				party,
				startAt,
				startAt + duration * MIN,
			)
			const reservation = makeReservation({
				date: seedDate,
				startMin,
				party,
				status: 'booked',
				tables: table ? [table.id] : [],
				name: input.name ?? ['Layla', 'Ibrahim'],
				phone: '+14155550150',
				channel: input.channel ?? 'online',
				client: input.channel === 'native' ? 'ios' : 'web',
				madeAgo: 0,
				durationMin: duration,
			})
			const day = dayOf(seedDate)
			day.reservations.push(reservation)
			touch(day)
			return reservation.id
		},
		cancel(id) {
			update(id, { status: 'cancelled' })
		},
		resize(id, party) {
			update(id, { partySize: party })
		},
		arrive(id) {
			update(id, { status: 'arrived', arrivedAt: clock() })
		},
		setGuestDetails(on) {
			canRead = on
			// The days read differently now: every held day is looked at again.
			for (const day of days.values()) touch(day)
		},
		setSmsEnabled(on) {
			smsEnabled = on
		},
		setOffline(on) {
			offline = on
		},
	}
	return Object.assign(api, { controls })
}

/** What can happen at the sample day from outside the stand (see `controls` above). */
export type DemoControls = {
	/** A guest books online (or in the app): the booking id. */
	bookOnline: (input: {
		name?: [string, string]
		party?: number
		startMin?: number
		channel?: 'online' | 'native'
	}) => string
	cancel: (id: string) => void
	resize: (id: string, party: number) => void
	/** Another host marks a party as here. */
	arrive: (id: string) => void
	/**
	 * Gives or takes away the guest-details grant: without it phone numbers
	 * show only their end, allergy notes and pinned notes are not sent, and
	 * nothing can be called or texted.
	 */
	setGuestDetails: (on: boolean) => void
	/** Turns texting on or off for the whole node (off: marking ready queues no text). */
	setSmsEnabled: (on: boolean) => void
	/**
	 * Cuts the connection: every call fails as an unreachable server does, so
	 * the stand's next look fails and it shows "offline" with the book as it was.
	 */
	setOffline: (on: boolean) => void
}

/** The controls of this tab's sample day. */
export function demoControls(): DemoControls {
	return (demoHostApi() as HostApi & { controls: DemoControls }).controls
}

/**
 * The demo's own clock. The sample day is built around "now", and a real clock
 * outside service hours (a morning, the small hours) would leave nothing
 * happening: so the demo's time is the device's, moved by whole minutes into
 * the afternoon, once, when it is first read. It then runs at the real pace.
 */
/** How far to move a clock reading (in ms) so it falls in the afternoon service. */
export function demoShift(real: number, timeZone: string): number {
	const minutes = zonedMinutes(real, timeZone)
	const anchor = Math.min(19 * 60 + 30, Math.max(13 * 60 + 30, minutes))
	return (anchor - minutes) * MIN
}

let shift: number | null = null
export function demoClock(): number {
	shift ??= demoShift(Date.now(), deviceZone())
	return Date.now() + shift
}

let shared: HostApi | null = null

/** The one sample day of this tab: it keeps its changes while the stand is closed and opened again. */
export function demoHostApi(): HostApi {
	shared ??= createDemoHostApi({
		now: demoClock,
		latencyMs: 90,
		// `localStorage.setItem('station.demo.guestDetails', 'off')` shows the stand as
		// someone without the guest-details grant sees it (masked phones, no call or text).
		canReadGuest: demoSwitch('station.demo.guestDetails'),
		smsEnabled: demoSwitch('station.demo.sms'),
	})
	return shared
}

/** A demo switch kept in this browser: on unless it says `off`. */
function demoSwitch(key: string): boolean {
	try {
		return localStorage.getItem(key) !== 'off'
	} catch {
		return true
	}
}
