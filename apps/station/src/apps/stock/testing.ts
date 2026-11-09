import { type StationCatalog } from '@repo/inventory'
import { type StockApi } from './api.ts'
import catalogFixture from './fixtures/catalog.json'
import { type StockContext } from './queue.ts'
import { useStockSync } from './runner.ts'
import { type PosSettings } from '~/lib/config.ts'
import { db } from '~/lib/db.ts'
import { type Session } from '~/lib/signin.ts'

/** Shared set-up for the Stock tests: a paired terminal, a signed-in person, a recording region. */

export const ORIGIN = 'https://api.test|demo'

export const ctx: StockContext = {
	origin: ORIGIN,
	locationId: 'main',
	madeBy: 'stf_ana',
}

export const catalog = catalogFixture as unknown as StationCatalog

export const settings = {
	appUrl: 'https://app.test',
	slug: 'demo',
	tenantApiUrl: 'https://api.test',
	terminalCode: 'T1',
	locationId: 'main',
	locationLocked: true,
	scopeId: 'main',
	signInRequired: true,
	dayStartMinutes: 0,
	shiftsRequired: false,
	idleLockSeconds: 120,
	deviceToken: 'device-secret',
	deviceLabel: 'Kitchen tablet',
	demo: false,
	locale: null,
	apps: { timeclock: false, reservations: false, inventory: true },
	activeApp: 'stock',
} satisfies PosSettings

export const session = (
	over: Partial<Session> = {},
	token = 'staff-session-token-aaaaaaaa',
): Session => ({
	staff: { id: 'stf_ana', name: 'Ana K.' },
	role: 'cashier',
	mode: 'online',
	at: 0,
	serverSession: { token, expiresAt: Date.now() + 3_600_000 },
	...over,
})

export async function resetStock() {
	await db.transaction(
		'rw',
		db.stockQueue,
		db.stockBlobs,
		db.stockCatalog,
		async () => {
			await db.stockQueue.clear()
			await db.stockBlobs.clear()
			await db.stockCatalog.clear()
		},
	)
	useStockSync.setState({
		running: false,
		paused: null,
		error: null,
		retryAt: null,
		lastSentAt: null,
	})
}

/** One made item to make today, as the region plans it. */
export function preparedTask() {
	return {
		id: 'task_1',
		itemId: 'item_sauce',
		itemName: 'Garlic sauce',
		baseUnit: 'ml' as const,
		countUnit: 'l' as const,
		units: [],
		stationId: null,
		businessDate: '2026-01-01',
		plannedQuantity: 2_000_000,
		batchSize: 1_000_000,
		batches: 2,
		explain: {
			fillUpTo: 2_000_000,
			target: 2_000_000,
			onHand: 0,
			demandBp: 10_000,
		},
		status: 'todo' as const,
		startedAt: null,
		doneAt: null,
		madeQuantity: null,
		version: 1,
	}
}

export function preparedPlan() {
	return {
		locationId: 'main',
		date: '2026-01-01',
		stations: [{ id: 'kitchen', name: 'Kitchen' }],
		demand: { bp: 10_000, known: false, ramadan: false, samples: 0 },
		generated: true,
		canGenerate: true,
		tasks: [preparedTask()],
	}
}

export type Recorded = StockApi & {
	calls: Array<{ name: string; args: unknown[] }>
}

/**
 * A region that accepts everything and mints ids, recording each call in
 * order. Override a method to make it refuse or fail.
 */
export function fakeApi(over: Partial<StockApi> = {}): Recorded {
	const calls: Recorded['calls'] = []
	let serial = 0
	const record = <T>(name: string, args: unknown[], value: T): T => {
		calls.push({ name, args })
		return value
	}
	const summary = (id: string) => ({
		id,
		locationId: 'main',
		listId: null,
		listName: null,
		status: 'counting' as const,
		businessDate: '2026-01-01',
		startedBy: { kind: 'staff' as const, id: 'stf_ana' },
		itemTotal: 5,
		itemsCounted: 0,
		counters: [],
		sentForReviewAt: null,
		approvedAt: null,
		approvedBy: null,
		cancelledAt: null,
		createdAt: 1,
		version: 1,
	})
	const base: StockApi = {
		async catalog(...args) {
			return record('catalog', args, { status: 'ok' as const, catalog })
		},
		async startCount(...args) {
			return record('startCount', args, {
				count: summary(`cnt_${++serial}`),
				joined: false,
			})
		},
		async countSheet(...args) {
			return record('countSheet', args, {
				count: summary(String(args[0])),
				areas: [],
			})
		},
		async countEntries(...args) {
			const body = args[1] as { entries: Array<{ clientId: string }> }
			return record('countEntries', args, {
				accepted: body.entries.map((entry) => ({
					clientId: entry.clientId,
					quantity: null,
				})),
				duplicates: [],
				refused: [],
			})
		},
		async sendCount(...args) {
			return record('sendCount', args, {
				...summary(String(args[0])),
				status: 'in_review' as const,
			})
		},
		async waste(...args) {
			const body = args[0] as { entries: Array<{ clientId: string }> }
			return record('waste', args, {
				accepted: body.entries.map((entry) => ({
					clientId: entry.clientId,
					id: `wst_${++serial}`,
					quantity: 1000,
				})),
				duplicates: [],
				refused: [],
				lateSync: [],
			})
		},
		async prepPlan(...args) {
			return record('prepPlan', args, preparedPlan())
		},
		async prepGenerate(...args) {
			return record('prepGenerate', args, preparedPlan())
		},
		async prepStart(...args) {
			return record('prepStart', args, {
				...preparedTask(),
				id: String(args[0]),
				status: 'in_progress' as const,
				version: 2,
			})
		},
		async prepSkip(...args) {
			return record('prepSkip', args, {
				...preparedTask(),
				id: String(args[0]),
				status: 'skipped' as const,
				version: 2,
			})
		},
		async prepDone(...args) {
			return record('prepDone', args, {
				...preparedTask(),
				id: String(args[0]),
				status: 'done' as const,
				madeQuantity: 2_000_000,
				doneAt: 1,
				version: 3,
			})
		},
		async dishWaste(...args) {
			const body = args[0] as { lines: unknown[] }
			return record('dishWaste', args, {
				logged: body.lines.length,
				withoutRecipe: 0,
				duplicate: false,
			})
		},
		async undoWaste(...args) {
			return record('undoWaste', args, { id: `rev_${++serial}` })
		},
		async delivery(...args) {
			const body = args[0] as { lines: unknown[] }
			return record('delivery', args, {
				id: `dlv_${++serial}`,
				lineCount: body.lines.length,
				receivedAt: 1,
				pricesPending: true as const,
				lateSync: false,
				duplicate: false,
				order: null,
				orderLinkIgnored: null,
			})
		},
		async photoRequest(...args) {
			return record('photoRequest', args, {
				key: 'inventory-invoices/org/dlv/abc.jpg',
				method: 'PUT' as const,
				uploadUrl: 'https://storage.test/abc',
				headers: { 'Content-Type': 'image/jpeg' },
				expiresAt: 2,
				maxBytes: 5_242_880,
			})
		},
		async putPhoto(...args) {
			record('putPhoto', args, null)
		},
		async photoConfirm(...args) {
			record('photoConfirm', args, null)
		},
	}
	return Object.assign({ ...base, ...over }, { calls }) as Recorded
}
