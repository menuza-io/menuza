import crypto from 'node:crypto'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import {
	INVENTORY_POS_CONTRACT_HEADER,
	INVENTORY_POS_CONTRACT_VERSION,
	stationCatalogSchema,
	stationCountEntriesResultSchema,
	voiceProposalSchema,
} from '@repo/inventory'
import { invCountEntries } from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import { invalidateInventoryContext } from '../lib/inventory-context.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { speechReaderDeps } from '../lib/speech-reader.ts'
import { resetInvoiceReadLimits } from '../lib/vision-read-limit.ts'
import {
	createStationKit,
	ON,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * Counting by voice on a Station terminal (#488): the microphone shows only
 * when the node has a speech model in its own region (`catalog.settings
 * .voiceCountsEnabled`), a recording proposes lines for the terminal's own
 * location, nothing is saved, and the confirmed lines are ordinary entries.
 */

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(async () => null),
	hasScope: vi.fn(async () => true),
	getStaffingFeatures: vi.fn(async () => null),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../services/pos-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/pos-service.ts')>()),
	checkLocation: vi.fn(async () => 'known' as const),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`
const speechEnv = {
	SPEECH_COUNT_BASE_URL: 'https://speech.example.test/v1',
	SPEECH_COUNT_API_KEY: 'speech-key',
	SPEECH_COUNT_MODEL: 'speech-1',
	SPEECH_COUNT_DATA_REGION: 'us',
}

describe('voice counts on Station', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen
	let tablet: Awaited<ReturnType<StationKit['station']>>
	let calls = 0
	let said = 'two kilos of tomatoes and one bottle of olive oil'
	const original = speechReaderDeps.transcribe

	const withSpeech = (region = 'us') => {
		Object.assign(process.env, speechEnv, { SPEECH_COUNT_DATA_REGION: region })
		syncEnvFromProcess()
	}

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		invalidateInventoryContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		calls = 0
		said = 'two kilos of tomatoes and one bottle of olive oil'
		speechReaderDeps.transcribe = async () => {
			calls++
			return said
		}
		h = await createClockHarness([ORG_A, ORG_B])
		kit = createStationKit(h)
		kit.enableInventory(ORG_A, { ...ON, voiceCounts: true, useBy: true })
		kit.enableInventory(ORG_B)
		k = await kit.kitchen(ORG_A)
		tablet = await kit.station(ORG_A)
		withSpeech()
	})
	afterEach(async () => {
		for (const key of Object.keys(speechEnv)) process.env[key] = ''
		syncEnvFromProcess()
		speechReaderDeps.transcribe = original
		resetInvoiceReadLimits()
		invalidateInventoryContext()
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	const cashier = (
		method: string,
		path: string,
		options: Parameters<StationKit['request']>[2] = {},
	) =>
		kit.request(method, path, {
			secret: tablet.secret,
			session: tablet.cashier.session,
			...options,
		})

	const catalog = async () =>
		stationCatalogSchema.parse(
			(await cashier('GET', `/pos/inventory/catalog?locationId=${STOCK_LOC}`)).body,
		)

	// A recording is the request body itself, so it cannot go through the JSON kit.
	const propose = async (query = '') => {
		const res = await h.app.request(`/pos/inventory/voice/propose${query}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${tablet.secret}`,
				[POS_STAFF_SESSION_HEADER]: tablet.cashier.session,
				[INVENTORY_POS_CONTRACT_HEADER]: String(INVENTORY_POS_CONTRACT_VERSION),
				'content-type': 'audio/webm',
			},
			body: new Uint8Array(1500).fill(7),
		})
		const raw = await res.text()
		return { status: res.status, raw, body: raw ? JSON.parse(raw) : null }
	}

	it('the catalog offers the microphone only with the flag and a speech model in this region', async () => {
		expect((await catalog()).settings.voiceCountsEnabled).toBe(true)
		// A model in another region, or none: the tablet hides the button.
		withSpeech('ksa')
		invalidateInventoryContext()
		kit.enableInventory(ORG_A, { ...ON, voiceCounts: true })
		expect((await catalog()).settings.voiceCountsEnabled).toBeUndefined()
		for (const key of Object.keys(speechEnv)) process.env[key] = ''
		syncEnvFromProcess()
		expect((await catalog()).settings.voiceCountsEnabled).toBeUndefined()
		// The model is back, but the organization flag is off.
		withSpeech()
		kit.enableInventory(ORG_A, { ...ON, voiceCounts: false })
		expect((await catalog()).settings.voiceCountsEnabled).toBeUndefined()
	})

	it('proposes lines for the terminal\'s own location and saves nothing', async () => {
		const reply = await propose()
		expect(reply.status, reply.raw).toBe(200)
		const proposal = voiceProposalSchema.parse(reply.body)
		expect(proposal.lines).toMatchObject([
			{ itemId: k.items.tomato.id, amount: 2, unit: 'kg' },
		])
		// Olive oil has no bottle unit: asks which unit.
		expect(proposal.questions).toMatchObject([
			{ kind: 'which_unit', itemId: k.items.oil.id, unitWords: 'bottle' },
		])
		expect(calls).toBe(1)
		const db = await h.db(ORG_A)
		expect(await db.select().from(invCountEntries)).toHaveLength(0)
	})

	it('refuses with voice_not_available when the node has no speech model in its region', async () => {
		withSpeech('ksa')
		const reply = await propose()
		expect(reply.status).toBe(503)
		expect(reply.body).toMatchObject({ error: 'voice_not_available' })
		expect(calls).toBe(0)
	})

	it('answers voice_failed when the model does not answer', async () => {
		speechReaderDeps.transcribe = async () => {
			throw new Error('down')
		}
		const reply = await propose()
		expect(reply.status).toBe(502)
		expect(reply.body).toMatchObject({ error: 'voice_failed' })
	})

	it('re-reads typed words, and confirmed lines are ordinary entries with the words kept', async () => {
		const parsed = await cashier('POST', '/pos/inventory/voice/parse', {
			body: { transcript: 'three kilos of tomatoes' },
		})
		expect(parsed.status, parsed.raw).toBe(200)
		const [line] = voiceProposalSchema.parse(parsed.body).lines
		const started = await cashier('POST', '/pos/inventory/counts', {
			body: { clientId: uid('count'), locationId: STOCK_LOC, listId: null },
		})
		expect(started.status, started.raw).toBe(200)
		const countId = started.body.count.id as string
		const sent = await cashier('POST', `/pos/inventory/counts/${countId}/entries`, {
			body: {
				entries: [
					{
						clientId: uid('entry'),
						itemId: line!.itemId,
						areaId: null,
						amount: line!.amount,
						unit: line!.unit,
						transcript: 'three kilos of tomatoes',
					},
				],
			},
		})
		expect(sent.status, sent.raw).toBe(200)
		expect(stationCountEntriesResultSchema.parse(sent.body).accepted).toHaveLength(1)
		const db = await h.db(ORG_A)
		const [row] = await db.select().from(invCountEntries)
		expect(row).toMatchObject({
			transcript: 'three kilos of tomatoes',
			enteredAmount: '3',
			counterKind: 'staff',
		})
	})

	it('needs the voice flag', async () => {
		kit.enableInventory(ORG_A, { ...ON, voiceCounts: false })
		const reply = await propose()
		expect(reply.status).toBe(403)
		expect(reply.body).toMatchObject({ error: 'inventory_disabled' })
		expect(calls).toBe(0)
	})

	it('the catalog tells the tablet which items are tracked by date', async () => {
		const full = await catalog()
		expect(full.settings.useByEnabled).toBe(true)
		expect(full.items.every((item) => item.trackByDate === false)).toBe(true)
	})
})
