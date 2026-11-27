import {
	countEntriesResultSchema,
	voiceCapabilitySchema,
	voiceProposalSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invAuditLog,
	invCountEntries,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { resetInvoiceReadLimits } from '../lib/vision-read-limit.ts'
import { speechReaderDeps } from '../lib/speech-reader.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	setupTenantEnv,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Counting by voice (#488), through a mock speech provider: lines are only
 * proposed, nothing is saved until the confirmed lines are sent as ordinary
 * entries (edits kept, the words stored, no audio anywhere), a word with no
 * match asks, and the microphone is off on a node with no speech model in its
 * own region.
 */

const ORG = 'org_inv_voice'
const LOC = 'loc_voice'
const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

const speechEnv = {
	SPEECH_COUNT_BASE_URL: 'https://speech.example.test/v1',
	SPEECH_COUNT_API_KEY: 'speech-key',
	SPEECH_COUNT_MODEL: 'speech-1',
	SPEECH_COUNT_DATA_REGION: 'us',
}

let env: ReturnType<typeof setupTenantEnv>
let owner: string
let noFlag: string
let tomatoes = ''
let romaine = ''
let caseUnit = ''
let bagUnit = ''
let countId = ''
let said = ''
const heard: Array<{ bytes: number; type: string; vocabulary: string[]; language?: string | null }> = []
const original = speechReaderDeps.transcribe

const withSpeech = (region = 'us') => {
	Object.assign(process.env, speechEnv, { SPEECH_COUNT_DATA_REGION: region })
	syncEnvFromProcess()
}

const audio = (bytes = 2_000, type = 'audio/webm') => ({
	bytes: new Uint8Array(bytes).fill(7),
	type,
})

async function propose(
	body: { bytes: Uint8Array; type: string } = audio(),
	token = owner,
	query = '',
) {
	const res = await app.request(
		`${BASE}/voice/propose?locationId=${LOC}${query}`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': body.type },
			body: body.bytes,
		},
	)
	return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
	env = setupTenantEnv('inv-voice')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	owner = await mintToken(ORG, { features: { voiceCounts: true } })
	noFlag = await mintToken(ORG, {})
	const item = async (name: string, unit: string, extra = {}) =>
		(
			await call('POST', `${BASE}/items`, {
				token: owner,
				body: {
					clientId: cid('item'),
					name,
					category: 'produce',
					kind: 'bought',
					baseUnit: 'g',
					units: [{ name: unit, baseQuantity: 5_000_000 }],
					...extra,
				},
			})
		).body
	const t = await item('Tomatoes', 'Case')
	const r = await item('Romaine', 'Bag')
	tomatoes = t.id
	romaine = r.id
	caseUnit = `unit:${t.units[0].id}`
	bagUnit = `unit:${r.units[0].id}`
	const count = await call('POST', `${BASE}/counts`, {
		token: owner,
		body: { clientId: cid('count'), locationId: LOC, listId: null },
	})
	countId = count.body.id
})

beforeEach(() => {
	heard.length = 0
	said = 'two cases of tomatoes and three bags of romaine'
	speechReaderDeps.transcribe = async (audioIn, hints) => {
		heard.push({
			bytes: audioIn.bytes.length,
			type: audioIn.contentType,
			vocabulary: hints.vocabulary,
			language: hints.language,
		})
		return said
	}
	withSpeech()
})

afterEach(() => {
	for (const key of Object.keys(speechEnv)) process.env[key] = ''
	syncEnvFromProcess()
	speechReaderDeps.transcribe = original
	resetInvoiceReadLimits()
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('proposing lines from a recording', () => {
	it('"two cases of tomatoes and three bags of romaine" proposes two lines with the right units', async () => {
		const reply = await propose()
		expect(reply.status, JSON.stringify(reply.body)).toBe(200)
		const proposal = voiceProposalSchema.parse(reply.body)
		expect(proposal.questions).toEqual([])
		expect(proposal.lines).toMatchObject([
			{ itemId: tomatoes, amount: 2, unit: caseUnit, unitLabel: 'Case' },
			{ itemId: romaine, amount: 3, unit: bagUnit, unitLabel: 'Bag' },
		])
		expect(proposal.transcript).toBe(said)
		// The model got the recording as it came, and the item names as a hint.
		expect(heard).toHaveLength(1)
		expect(heard[0]).toMatchObject({ bytes: 2_000, type: 'audio/webm' })
		expect(heard[0]!.vocabulary).toEqual(expect.arrayContaining(['Tomatoes', 'Romaine']))
	})

	it('saves nothing: no entry, no movement, no audit row, until the lines are confirmed', async () => {
		const db = await getTenantDb(ORG)
		const before = {
			entries: (await db.select().from(invCountEntries)).length,
			movements: (await db.select().from(invMovements)).length,
			audit: (await db.select().from(invAuditLog)).length,
		}
		const reply = await propose()
		expect(reply.status).toBe(200)
		expect({
			entries: (await db.select().from(invCountEntries)).length,
			movements: (await db.select().from(invMovements)).length,
			audit: (await db.select().from(invAuditLog)).length,
		}).toEqual(before)
	})

	it('confirmed lines are ordinary entries: an edit before confirming is kept, the words are stored, the audio is not', async () => {
		const reply = await propose()
		const [first, second] = voiceProposalSchema.parse(reply.body).lines
		// The person changes the first amount from 2 to 3 and drops nothing.
		const sent = await call('POST', `${BASE}/counts/${countId}/entries`, {
			token: owner,
			body: {
				entries: [
					{
						clientId: cid('v1'),
						itemId: first!.itemId,
						areaId: null,
						amount: 3,
						unit: first!.unit,
						transcript: said,
					},
					{
						clientId: cid('v2'),
						itemId: second!.itemId,
						areaId: null,
						amount: second!.amount,
						unit: second!.unit,
						transcript: said,
					},
				],
			},
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		expect(countEntriesResultSchema.parse(sent.body).accepted).toHaveLength(2)
		const db = await getTenantDb(ORG)
		const rows = await db.select().from(invCountEntries)
		const mine = rows.filter((row) => row.transcript === said)
		expect(mine).toHaveLength(2)
		expect(mine.find((row) => row.itemId === tomatoes)).toMatchObject({
			enteredAmount: '3',
			quantity: 15_000_000,
		})
		expect(mine.find((row) => row.itemId === romaine)).toMatchObject({
			enteredAmount: '3',
			quantity: 15_000_000,
		})
		// No column of the entry holds anything like audio: the words, nothing more.
		expect(JSON.stringify(mine)).not.toContain('audio')
	})

	it('stores no words when the flag is off, and a typed entry has none', async () => {
		const count = await call('POST', `${BASE}/counts`, {
			token: noFlag,
			body: { clientId: cid('count'), locationId: 'loc_voice_two', listId: null },
		})
		const typed = await call('POST', `${BASE}/counts/${count.body.id}/entries`, {
			token: noFlag,
			body: {
				entries: [
					{
						clientId: cid('t1'),
						itemId: tomatoes,
						areaId: null,
						amount: 1,
						unit: caseUnit,
						transcript: 'one case of tomatoes',
					},
				],
			},
		})
		expect(typed.status).toBe(200)
		const db = await getTenantDb(ORG)
		const [row] = (await db.select().from(invCountEntries)).filter(
			(entry) => entry.countId === count.body.id,
		)
		expect(row!.transcript).toBeNull()
	})

	it('an unmatched word asks which item instead of guessing', async () => {
		said = 'two cases of dragonfruit'
		const reply = await propose()
		const proposal = voiceProposalSchema.parse(reply.body)
		expect(proposal.lines).toEqual([])
		expect(proposal.questions).toMatchObject([
			{ kind: 'which_item', reason: 'no_match', heard: 'dragonfruit', amount: 2 },
		])
	})

	it('a unit the item does not have asks which unit', async () => {
		said = 'two cases of romaine'
		const proposal = voiceProposalSchema.parse((await propose()).body)
		expect(proposal.lines).toEqual([])
		expect(proposal.questions[0]).toMatchObject({
			kind: 'which_unit',
			itemId: romaine,
			options: expect.arrayContaining([{ ref: bagUnit, label: 'Bag' }]),
		})
	})

	it('hears Arabic: Arabic digits and an item Arabic name', async () => {
		const db = await getTenantDb(ORG)
		const { invItems } = await import('@repo/tenant-db')
		const { eq } = await import('drizzle-orm')
		await db.update(invItems).set({ nameAr: 'خس' }).where(eq(invItems.id, romaine))
		said = '٣ اكياس خس'
		const reply = await propose(audio(), owner, '&language=ar')
		const proposal = voiceProposalSchema.parse(reply.body)
		expect(proposal.lines).toMatchObject([
			{ itemId: romaine, amount: 3, unit: bagUnit },
		])
		expect(heard.at(-1)!.language).toBe('ar')
	})

	it('re-reads words a person typed or corrected, with no speech model needed', async () => {
		for (const key of Object.keys(speechEnv)) process.env[key] = ''
		syncEnvFromProcess()
		const reply = await call('POST', `${BASE}/voice/parse`, {
			token: owner,
			body: { locationId: LOC, transcript: 'one case of tomatoes' },
		})
		expect(reply.status).toBe(200)
		expect(voiceProposalSchema.parse(reply.body).lines).toMatchObject([
			{ itemId: tomatoes, amount: 1, unit: caseUnit },
		])
		expect(heard).toHaveLength(0)
	})
})

describe('the microphone is hidden unless the node can hear in its own region', () => {
	const available = async (token = owner) => {
		const reply = await call('GET', `${BASE}/voice?locationId=${LOC}`, { token })
		expect(reply.status).toBe(200)
		return voiceCapabilitySchema.parse(reply.body).available
	}

	it('is available with the flag and a speech model in this node\'s region', async () => {
		expect(await available()).toBe(true)
	})

	it('is hidden when no speech model is set', async () => {
		for (const key of Object.keys(speechEnv)) process.env[key] = ''
		syncEnvFromProcess()
		expect(await available()).toBe(false)
		const reply = await propose()
		expect(reply.status).toBe(503)
		expect(reply.body.code).toBe('reader_not_configured')
		expect(heard).toHaveLength(0)
	})

	it('is hidden when the speech model is in another region, and the recording is never sent to it', async () => {
		withSpeech('ksa')
		expect(await available()).toBe(false)
		const reply = await propose()
		expect(reply.status).toBe(503)
		expect(reply.body.code).toBe('reader_not_configured')
		expect(heard).toHaveLength(0)
	})

	it('is hidden while the organization flag is off', async () => {
		expect(await available(noFlag)).toBe(false)
		const reply = await propose(audio(), noFlag)
		expect(reply.status).toBe(403)
		expect(reply.body.code).toBe('feature_disabled')
		expect(heard).toHaveLength(0)
	})
})

describe('what the node refuses', () => {
	it('a recording of another kind, an empty one and one that is too large', async () => {
		expect((await propose(audio(100, 'image/png'))).status).toBe(400)
		expect((await propose(audio(0))).status).toBe(400)
		const big = await propose(audio(2_000_001))
		expect([400, 413]).toContain(big.status)
		expect(heard).toHaveLength(0)
	})

	it('a model that does not answer is 502 reader_failed, never a made-up line', async () => {
		speechReaderDeps.transcribe = async () => {
			throw new Error('down')
		}
		const reply = await propose()
		expect(reply.status).toBe(502)
		expect(reply.body.code).toBe('reader_failed')
	})

	it('an unclear recording answers nothing, not a guess', async () => {
		said = ''
		const proposal = voiceProposalSchema.parse((await propose()).body)
		expect(proposal).toMatchObject({ lines: [], questions: [] })
	})

	it('limits a runaway client', async () => {
		let last = 200
		for (let i = 0; i < 125; i++) last = (await propose()).status
		expect(last).toBe(429)
	})
})
