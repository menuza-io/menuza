/**
 * Cloud printers (#117, #426): what an operator sets up, how a printer is
 * addressed and authenticated, how a ticket is routed to printers, and what a
 * printer's status means. Pure: no I/O.
 *
 * A printer is not a tablet. It cannot hold a staff session or a long secret
 * (printer setup pages cap the password length), so it is addressed by a
 * public `ref` in the URL it polls (`<orgId>.<printerId>`) and proves itself
 * with a short random password shown once at setup. Only a keyed hash of the
 * password is stored. The ref routes the request to the right organization;
 * it grants nothing.
 */
import { z } from 'zod'

export const PRINTING_FLAG_KEY = 'kitchen.printers'

export const PRINT_PROTOCOL_VALUES = ['star_cloudprnt', 'epson_sdp'] as const
export type PrintProtocolValue = (typeof PRINT_PROTOCOL_VALUES)[number]

export const PRINT_PAPER_WIDTHS = [58, 80] as const

/** Offered again after this long without an acknowledgement. */
export const PRINT_REOFFER_MS = 30_000
/** At most this many offers; then the job is flagged for the operator. */
export const PRINT_MAX_ATTEMPTS = 5
/** A printer that has not polled for this long is offline. */
export const PRINT_ONLINE_WINDOW_MS = 3 * 60_000
/** Tickets older than this are not printed late: a stale kitchen ticket misleads. */
export const PRINT_JOB_MAX_AGE_MS = 6 * 60 * 60_000

export const PRINT_DEVICE_STATUSES = [
	'unknown',
	'ok',
	'out_of_paper',
	'cover_open',
	'error',
] as const
export type PrintDeviceStatus = (typeof PRINT_DEVICE_STATUSES)[number]

/** What an operator sees for a printer, worked out from what it last reported. */
export type PrinterHealth =
	| 'online'
	| 'offline'
	| 'out_of_paper'
	| 'cover_open'
	| 'error'
	| 'never_seen'
	| 'revoked'

export function printerHealth(
	device: {
		lastSeenAt: number | null
		status: string
		revokedAt: number | null
	},
	now: number,
): PrinterHealth {
	if (device.revokedAt !== null) return 'revoked'
	if (device.lastSeenAt === null) return 'never_seen'
	if (now - device.lastSeenAt > PRINT_ONLINE_WINDOW_MS) return 'offline'
	if (device.status === 'out_of_paper') return 'out_of_paper'
	if (device.status === 'cover_open') return 'cover_open'
	if (device.status === 'error') return 'error'
	return 'online'
}

/** Words for the operator: why a test failed or why a printer is not ready. */
export function printerHealthReason(health: PrinterHealth): string | null {
	switch (health) {
		case 'offline':
			return 'The printer is disconnected. Check its power and network, then try again.'
		case 'never_seen':
			return 'The printer has not connected yet. Enter the address and password in its cloud printing settings.'
		case 'out_of_paper':
			return 'The printer is out of paper.'
		case 'cover_open':
			return 'The printer cover is open.'
		case 'error':
			return 'The printer reported a problem.'
		case 'revoked':
			return 'This printer was removed.'
		case 'online':
			return null
	}
}

export const printerRoutesSchema = z.object({
	/** `all`: every ticket; `stations`: only the dishes of the listed stations; `off`. */
	kitchen: z.enum(['off', 'all', 'stations']).catch('off').default('off'),
	stationIds: z
		.array(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/))
		.max(50)
		.catch([])
		.default([]),
	/** Guest receipts print here. */
	receipts: z.boolean().catch(false).default(false),
	/** Dishes of a station with no printer of its own come here. */
	isDefault: z.boolean().catch(false).default(false),
	/** The delivery address prints on delivery kitchen tickets (off unless the location asks). */
	deliveryAddress: z.boolean().catch(false).default(false),
	/** The printer has an Arabic font: no picture is needed for Arabic text. */
	arabicFont: z.boolean().catch(false).default(false),
	/** Food-safety labels from Station print here (#523). */
	labels: z.boolean().catch(false).default(false),
})
export type PrinterRoutes = z.infer<typeof printerRoutesSchema>

export const DEFAULT_PRINTER_ROUTES: PrinterRoutes = printerRoutesSchema.parse({})

export function readPrinterRoutes(value: unknown): PrinterRoutes {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			raw = {}
		}
	}
	const parsed = printerRoutesSchema.safeParse(
		raw && typeof raw === 'object' ? raw : {},
	)
	return parsed.success ? parsed.data : DEFAULT_PRINTER_ROUTES
}

export const printerSetupSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
	name: z.string().trim().min(1).max(60),
	protocol: z.enum(PRINT_PROTOCOL_VALUES),
	widthMm: z.union([z.literal(58), z.literal(80)]),
	copies: z.number().int().min(1).max(5).default(1),
	routes: printerRoutesSchema.default(DEFAULT_PRINTER_ROUTES),
})
export type PrinterSetup = z.infer<typeof printerSetupSchema>

export const printerUpdateSchema = printerSetupSchema
	.omit({ locationId: true, protocol: true })
	.partial()
	.strict()

// ---------------------------------------------------------------------------
// Address and credential
// ---------------------------------------------------------------------------

const ID_PART = '[A-Za-z0-9_-]{1,64}'
const REF_PATTERN = new RegExp(`^(${ID_PART})\\.(${ID_PART})$`)
const PASSWORD_PATTERN = /^[A-Za-z0-9]{32}$/

export function formatPrintRef(orgId: string, printerId: string): string {
	const ref = `${orgId}.${printerId}`
	if (!REF_PATTERN.test(ref)) throw new Error('Invalid printer reference')
	return ref
}

export function parsePrintRef(
	value: unknown,
): { orgId: string; printerId: string } | null {
	if (typeof value !== 'string' || value.length > 140) return null
	const match = REF_PATTERN.exec(value)
	return match ? { orgId: match[1]!, printerId: match[2]! } : null
}

/** A short password a printer's setup page can hold: 32 letters and digits. */
export function generatePrinterPassword(): string {
	const alphabet =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	const bytes = new Uint8Array(32)
	// Rejection sampling keeps every character equally likely.
	let out = ''
	while (out.length < 32) {
		crypto.getRandomValues(bytes)
		for (const byte of bytes) {
			if (byte < 248 && out.length < 32) out += alphabet[byte % 62]
		}
	}
	return out
}

export const isPrinterPassword = (value: unknown): value is string =>
	typeof value === 'string' && PASSWORD_PATTERN.test(value)

/** The message fed to HMAC for the stored hash. */
export const printerPasswordHashMessage = (ref: string, password: string) =>
	`print-device:v1:${ref}:${password}`

/** The password a printer sends: HTTP Basic (any user name) or Bearer. */
export function readPrinterPassword(header: string | null | undefined): string | null {
	if (!header) return null
	const [scheme, rest] = header.trim().split(/\s+/, 2)
	if (!scheme || !rest) return null
	if (scheme.toLowerCase() === 'bearer') {
		return isPrinterPassword(rest) ? rest : null
	}
	if (scheme.toLowerCase() === 'basic') {
		try {
			const decoded = atob(rest)
			const colon = decoded.indexOf(':')
			const password = colon >= 0 ? decoded.slice(colon + 1) : decoded
			return isPrinterPassword(password) ? password : null
		} catch {
			return null
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Routing a ticket to printers
// ---------------------------------------------------------------------------

export type RoutablePrinter = {
	id: string
	locationId: string
	revokedAt: number | null
	routes: PrinterRoutes
}

export type RoutableLine = { stationIds: readonly string[] }

export type KitchenRoute = {
	printerId: string
	/** Indexes of the ticket's lines this printer prints. */
	lineIndexes: number[]
	/** Station names are shown on the ticket only when a printer takes part of it. */
	partial: boolean
}

/**
 * Which printer prints which dishes (#117). A printer set to `all` prints the
 * whole ticket. A printer set to `stations` prints the dishes of its stations.
 * A dish whose stations have no printer of their own goes to the default
 * printer, unless that printer already prints the whole ticket. Printers of
 * other locations and removed printers never receive anything.
 */
export function routeKitchenTicket(input: {
	locationId: string
	lines: readonly RoutableLine[]
	printers: readonly RoutablePrinter[]
}): KitchenRoute[] {
	const live = input.printers.filter(
		(printer) =>
			printer.locationId === input.locationId &&
			printer.revokedAt === null &&
			printer.routes.kitchen !== 'off',
	)
	const all = live.filter((printer) => printer.routes.kitchen === 'all')
	const byStation = live.filter((printer) => printer.routes.kitchen === 'stations')
	const wholeTicket = input.lines.map((_, index) => index)
	const routes: KitchenRoute[] = all.map((printer) => ({
		printerId: printer.id,
		lineIndexes: wholeTicket,
		partial: false,
	}))
	const covered = new Set(all.map((printer) => printer.id))
	const stationsWithPrinter = new Set(
		byStation.flatMap((printer) => printer.routes.stationIds),
	)
	const taken = new Map<string, Set<number>>()
	const give = (printerId: string, index: number) => {
		const set = taken.get(printerId) ?? new Set<number>()
		set.add(index)
		taken.set(printerId, set)
	}
	input.lines.forEach((line, index) => {
		let placed = false
		for (const printer of byStation) {
			if (line.stationIds.some((id) => printer.routes.stationIds.includes(id))) {
				give(printer.id, index)
				placed = true
			}
		}
		if (placed) return
		// No station printer for this dish: the default printer takes it.
		if (!line.stationIds.some((id) => stationsWithPrinter.has(id))) {
			const fallback = live.filter(
				(printer) => printer.routes.isDefault && !covered.has(printer.id),
			)
			for (const printer of fallback) give(printer.id, index)
		}
	})
	for (const [printerId, indexes] of taken) {
		routes.push({
			printerId,
			lineIndexes: [...indexes].sort((a, b) => a - b),
			partial: indexes.size < input.lines.length,
		})
	}
	return routes.filter((route) => route.lineIndexes.length > 0)
}

/** Printers that print guest receipts at a location. */
export function routeReceipt(input: {
	locationId: string
	printers: readonly RoutablePrinter[]
}): string[] {
	return input.printers
		.filter(
			(printer) =>
				printer.locationId === input.locationId &&
				printer.revokedAt === null &&
				printer.routes.receipts,
		)
		.map((printer) => printer.id)
}
