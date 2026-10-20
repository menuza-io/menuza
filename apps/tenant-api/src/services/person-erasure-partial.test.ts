import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	personErasureLog,
	provisionTenantDb,
	voiceCallRequests,
	voiceCalls,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = 'clw9x0a12000008l00erase3'
const PHONE = '+15550003333'

// The first voice target is erased for real; the second one's recording
// deletion fails. Later calls (the retry) use the real implementation.
const control = vi.hoisted(() => ({ calls: 0, failOn: 2 }))
vi.mock('../routes/voice.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../routes/voice.ts')>()
	return {
		...original,
		eraseCallerVoiceData: vi.fn(
			async (...args: Parameters<typeof original.eraseCallerVoiceData>) => {
				control.calls++
				if (control.calls === control.failOn) {
					return { error: 'recording_failed' as const }
				}
				return original.eraseCallerVoiceData(...args)
			},
		),
	}
})

const { erasePerson, PersonErasureError } =
	await import('./person-erasure-service.ts')

describe('person erasure when a recording deletion fails after an earlier target', () => {
	let tempDir: string
	let db: TenantDatabase
	let customerId: string

	beforeEach(async () => {
		control.calls = 0
		control.failOn = 2
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-erase-part-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({ name: 'Pat Partial', phone: PHONE, email: 'pat@example.test' })
			.returning()
		customerId = customer!.id
		const [call] = await db
			.insert(voiceCalls)
			.values({
				channel: 'phone',
				roomName: 'room-partial',
				startedAt: new Date(),
				callerPhone: PHONE,
				customerId,
			})
			.returning()
		await db.insert(voiceCallRequests).values({
			callId: call!.id,
			type: 'callback',
			callerName: 'Pat Partial',
			callerPhone: PHONE,
			details: {},
		} as never)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('reports and logs exactly what is gone, and a retry completes', async () => {
		const failure = await erasePerson(
			db,
			{ customerId },
			{ actorId: 'user_1' },
		).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(PersonErasureError)
		const error = failure as InstanceType<typeof PersonErasureError>
		expect(error).toMatchObject({
			status: 502,
			code: 'recording_delete_failed',
		})
		expect(error.message).toContain('earlier voice data may already be erased')

		// The first target really erased the call and the request...
		expect(await db.select().from(voiceCalls)).toEqual([])
		expect(await db.select().from(voiceCallRequests)).toEqual([])
		// ...the error says so (the request went with its call, so it was not
		// counted separately), and the customer is untouched.
		expect(error.erased).toEqual({
			voiceCalls: 1,
			voiceRequests: 0,
			voiceTexts: 0,
		})
		expect(await db.select().from(customers)).toHaveLength(1)

		const [log] = await db.select().from(personErasureLog)
		expect(log!.counts).toEqual({ incomplete: 1, ...error.erased })

		const retry = await erasePerson(db, { customerId }, { actorId: 'user_1' })
		expect(retry).toMatchObject({ alreadyErased: false, customersErased: 1 })
		expect(await db.select().from(customers)).toEqual([])
		const logs = await db.select().from(personErasureLog)
		expect(logs).toHaveLength(1)
		expect(logs[0]!.counts).toMatchObject({
			customers: 1,
			voiceCalls: 1,
		})
		expect(logs[0]!.counts).not.toHaveProperty('incomplete')
	})
})
