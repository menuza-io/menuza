import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOYALTY_OTP_TTL_MS } from '@repo/loyalty'
import { sendSms } from '@repo/sms'
import {
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	loyaltyMemberBindings,
	loyaltyMembers,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOYALTY_RATE_LIMITS } from '../lib/loyalty-rate-limit.ts'
import { resolveBindingInTx, type TillDevice } from './loyalty-code-service.ts'
import {
	sendTillJoinCode,
	verifyTillJoinCode,
} from './loyalty-till-join-service.ts'
import { setMemberStatus } from './loyalty-member-service.ts'
import {
	activateProgram,
	expectLoyaltyError,
	insertCustomer,
	insertPosDevice,
	LOC_1,
	makeMember,
	NOW,
	saveDraftProgram,
} from './loyalty-test-fixture.ts'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'

vi.mock('@repo/sms', () => ({ sendSms: vi.fn() }))

const sms = vi.mocked(sendSms)

const ORG = 'org_ll_join'
const FEATURES = { enabled: true, redemption: true }
const PHONE = '+15550100401'

let directory: string
let device: TillDevice

/** The six digits the last text carried. */
function lastCode(): string {
	const message = sms.mock.calls.at(-1)?.[0]?.message ?? ''
	return /\b(\d{6})\b/.exec(message)![1]!
}

async function send(phone = PHONE, now = NOW) {
	return sendTillJoinCode(ORG, { phone, device, features: FEATURES, now })
}

async function verify(code: string, phone = PHONE, now = NOW) {
	return verifyTillJoinCode(ORG, {
		phone,
		code,
		device,
		features: FEATURES,
		now,
	})
}

async function customerByPhone(phone = PHONE) {
	const db = await getTenantDb(ORG)
	return db.select().from(customers).where(eq(customers.phone, phone)).get()
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-join-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
	device = { id: await insertPosDevice(ORG), locationId: LOC_1 }
	sms.mockReset()
	sms.mockResolvedValue(undefined as never)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('joining at the till', () => {
	it('a guest with no account gives a number, reads the code back and is a member with a binding', async () => {
		const sent = await send()
		expect(sent).toEqual({ sent: true, expiresAt: NOW + LOYALTY_OTP_TTL_MS })
		expect(sms).toHaveBeenCalledTimes(1)
		expect(sms.mock.calls[0]![0]).toMatchObject({ to: PHONE })
		expect(sms.mock.calls[0]![0].message).toContain('Test Club')

		// A number alone links nothing: no verified phone, no account yet.
		const db = await getTenantDb(ORG)
		expect((await customerByPhone())?.phoneVerified).toBe(false)
		expect(await db.select().from(loyaltyMembers).all()).toHaveLength(0)

		const joined = await verify(lastCode())
		expect(joined.joined).toBe(true)
		expect(joined.member.balance.available).toBe(0)
		expect(joined.redemptionEnabled).toBe(true)
		expect((await customerByPhone())?.phoneVerified).toBe(true)
		expect(await db.select().from(loyaltyMembers).all()).toHaveLength(1)

		// The binding is the one reading a member code gives: it resolves to
		// the member on this terminal.
		const resolved = await withLoyaltyWrite({ orgId: ORG, now: NOW }, (tx) =>
			resolveBindingInTx(tx, ORG, {
				binding: joined.member.binding,
				deviceId: device.id,
				at: NOW,
			}),
		)
		expect(resolved).toBeTruthy()
	})

	it('never sets marketing consent', async () => {
		await send()
		await verify(lastCode())
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customerSubscriptions).all()).toHaveLength(0)
	})

	it('an existing unverified POS contact becomes the member once the phone is proven', async () => {
		await insertCustomer(ORG, {
			id: 'cus_pos_contact',
			name: 'Ada Lovelace',
			phone: PHONE,
			verified: false,
		})
		await send()
		const joined = await verify(lastCode())
		expect(joined.joined).toBe(true)
		expect(joined.member.firstName).toBe('Ada')
		const db = await getTenantDb(ORG)
		const members = await db.select().from(loyaltyMembers).all()
		expect(members.map((m) => m.customerId)).toEqual(['cus_pos_contact'])
	})

	it('an existing member joining again gets a binding and joined=false', async () => {
		await insertCustomer(ORG, {
			id: 'cus_existing',
			name: 'Grace Hopper',
			phone: PHONE,
			verified: true,
		})
		await makeMember(ORG, { customerId: 'cus_existing' })
		await send()
		const again = await verify(lastCode())
		expect(again.joined).toBe(false)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(loyaltyMembers).all()).toHaveLength(1)
		expect(await db.select().from(loyaltyMemberBindings).all()).toHaveLength(1)
	})

	it('a wrong code, an expired code and a replayed code all answer otp_invalid', async () => {
		await send()
		const code = lastCode()
		const wrong = code === '000000' ? '111111' : '000000'
		await expectLoyaltyError(verify(wrong), 'otp_invalid')
		await expectLoyaltyError(
			verify(code, PHONE, NOW + LOYALTY_OTP_TTL_MS + 1),
			'otp_invalid',
		)
		await verify(code)
		await expectLoyaltyError(verify(code), 'otp_invalid')
	})

	it('a number that was never sent a code is otp_invalid and creates nothing', async () => {
		await expectLoyaltyError(verify('123456', '+15550100499'), 'otp_invalid')
		expect(await customerByPhone('+15550100499')).toBeUndefined()
	})

	it('a code only works for the number it was sent to', async () => {
		await send()
		const code = lastCode()
		await send('+15550100402')
		await expectLoyaltyError(verify(code, '+15550100402'), 'otp_invalid')
	})

	it('refuses an unreadable number without echoing it', async () => {
		await expectLoyaltyError(send('abc'), 'invalid_request')
		expect(sms).not.toHaveBeenCalled()
	})

	it('sends nothing while the program is not active', async () => {
		await destroyTenantDb(ORG)
		await provisionTenantDb(ORG)
		await saveDraftProgram(ORG)
		await expectLoyaltyError(send(), 'program_not_found')
		expect(sms).not.toHaveBeenCalled()
	})

	it('a suspended account is never reopened by joining', async () => {
		await insertCustomer(ORG, {
			id: 'cus_suspended',
			name: 'Sam Spade',
			phone: PHONE,
			verified: true,
		})
		const memberId = await makeMember(ORG, { customerId: 'cus_suspended' })
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			actorId: 'op_test',
			now: NOW,
		})
		await send()
		await expectLoyaltyError(verify(lastCode()), 'member_inactive')
	})

	it('reports an SMS failure as otp_unavailable without leaking the number', async () => {
		sms.mockRejectedValueOnce(new Error('provider down'))
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		await expectLoyaltyError(send(), 'otp_unavailable')
		const logged = JSON.stringify(spy.mock.calls)
		expect(logged).not.toContain(PHONE)
		spy.mockRestore()
	})

	it('leaves no row behind when the text cannot be sent to a new number', async () => {
		sms.mockRejectedValueOnce(new Error('provider down'))
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		await expectLoyaltyError(send(), 'otp_unavailable')
		spy.mockRestore()
		expect(await customerByPhone()).toBeUndefined()
	})

	it("does not overwrite a signed-in customer's live sign-in code", async () => {
		await insertCustomer(ORG, {
			id: 'cus_signing_in',
			name: 'Ada Lovelace',
			phone: PHONE,
			verified: true,
		})
		const db = await getTenantDb(ORG)
		await db
			.update(customers)
			.set({
				phoneVerificationCode: 'website-hash',
				phoneVerificationExpiresAt: new Date(NOW + 60_000),
			})
			.where(eq(customers.id, 'cus_signing_in'))
		await expectLoyaltyError(send(), 'otp_unavailable')
		expect(sms).not.toHaveBeenCalled()
		expect((await customerByPhone())?.phoneVerificationCode).toBe(
			'website-hash',
		)
	})

	it('concurrent sends for a new number do not fail on the UNIQUE phone', async () => {
		const results = await Promise.allSettled([send(), send()])
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers).all()).toHaveLength(1)
	})

	it('a suspended member does not burn the code', async () => {
		await insertCustomer(ORG, {
			id: 'cus_susp2',
			name: 'Sam Spade',
			phone: PHONE,
			verified: true,
		})
		const memberId = await makeMember(ORG, { customerId: 'cus_susp2' })
		await setMemberStatus(ORG, {
			memberId,
			status: 'suspended',
			actorId: 'op_test',
			now: NOW,
		})
		await send()
		await expectLoyaltyError(verify(lastCode()), 'member_inactive')
		const row = await customerByPhone()
		expect(row?.phoneVerificationCode).toBeTruthy()
		expect(row?.phoneVerificationExpiresAt).toBeTruthy()
	})

	it('limits texts per number and per terminal', async () => {
		const { max } = LOYALTY_RATE_LIMITS.joinSendPhone
		for (let i = 0; i < max; i++) await send()
		await expectLoyaltyError(send(), 'rate_limited')

		const perDevice = LOYALTY_RATE_LIMITS.joinSend.max
		const other = await insertPosDevice(ORG, { id: 'dev_join_many' })
		device = { id: other, locationId: LOC_1 }
		for (let i = 0; i < perDevice; i++) {
			await send(`+1555020${String(i).padStart(4, '0')}`)
		}
		await expectLoyaltyError(send('+15550209999'), 'rate_limited')
	})
})
