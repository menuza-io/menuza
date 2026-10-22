import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	issuePosFiscalDocument,
	newPosFiscalChain,
} from '@repo/common/pos-fiscal'
import { type PosOrderRequest } from '@repo/common/pos-orders'
import {
	fromSale,
	generatePrivateKey,
	signDocument,
	ZATCA_GENESIS_PIH,
	type ZatcaCertificate,
} from '@repo/zatca'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posZatcaSettings,
	posZatcaSubmissions,
	posZatcaUnits,
	provisionTenantDb,
	type PosDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { ORG_A, stubStaffEnv } from '../../tests/staff-harness.ts'
import { seal, sealContext } from '../lib/zatca-seal.ts'
import {
	queueZatcaDocuments,
	reportDueZatca,
	resealZatcaUnits,
	revokeZatcaUnitsForDevice,
	unitCredentials,
	zatcaOverview,
	zatcaSettingsSchema,
} from './zatca-service.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

const seller = {
	name: 'Al Hara Kitchen',
	vatNumber: '399999999900003',
	crNumber: '1010010000',
	street: 'Prince Sultan',
	buildingNumber: '2322',
	district: 'Al-Murabba',
	city: 'Riyadh',
	postalCode: '23333',
}
const settingsRow = {
	id: 'main',
	environment: 'sandbox' as const,
	sellerName: seller.name,
	vatNumber: seller.vatNumber,
	crNumber: seller.crNumber,
	street: seller.street,
	buildingNumber: seller.buildingNumber,
	district: seller.district,
	city: seller.city,
	postalCode: seller.postalCode,
	businessCategory: 'Restaurant',
	branchName: 'Main',
	updatedBy: 'test',
}
/** Signing needs these fields only; ZATCA is stubbed, so the certificate need not be real. */
const certificate: ZatcaCertificate = {
	base64: 'MIIBdGVzdA==',
	issuerName: 'CN=TSZEINVOICE-SubCA-1',
	serialNumber: '1',
	publicKey: new Uint8Array(88),
	signature: new Uint8Array(72),
}
const key = generatePrivateKey()

let directory: string
let db: TenantDatabase
let device: PosDevice

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zatca-service-'))
	stubStaffEnv(directory, 'ksa')
	await provisionTenantDb(ORG_A)
	db = await getTenantDb(ORG_A)
	const [row] = await db
		.insert(posDevices)
		.values({
			label: 'Front',
			terminalCode: 'T1',
			secretHash: 'x',
			pairedBy: 'test',
		})
		.returning()
	device = row!
	await db.insert(posZatcaSettings).values(settingsRow)
	await addUnit(device.id)
})

afterEach(async () => {
	try {
		await destroyTenantDb(ORG_A)
	} catch {
		// already gone
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

async function addUnit(deviceId: string, over: Record<string, unknown> = {}) {
	await db.insert(posZatcaUnits).values({
		deviceId,
		environment: 'sandbox',
		status: 'active',
		privateKeySealed: seal(
			'aa'.repeat(32),
			sealContext(deviceId, 'private_key'),
		),
		productionToken: 'dG9rZW4=',
		productionSecretSealed: seal(
			'production-secret',
			sealContext(deviceId, 'production_secret'),
		),
		seller,
		onboardedAt: NOW,
		...over,
	})
}

/** A paid sale the till signed as document `counter` of its chain. */
function signedSale(counter: number, previousHash = ZATCA_GENESIS_PIH) {
	const orderId = crypto.randomUUID()
	const totals = {
		subtotalCents: 2000,
		adjustmentCents: 0,
		taxCents: 300,
		tipCents: 0,
		totalCents: 2300,
	}
	const invoiceNumber = `T1-${String(counter).padStart(4, '0')}-20261021`
	const signed = signDocument(
		fromSale(
			{
				lines: [
					{
						name: 'Burger',
						variantLabel: null,
						quantity: 2,
						baseCents: 1000,
						options: [],
					},
				],
				taxRatePercent: 15,
				taxInclusive: false,
				totals,
				payments: [{ method: 'cash' }],
			},
			{
				id: invoiceNumber,
				uuid: crypto.randomUUID(),
				issuedAt: new Date(NOW),
				counter,
				previousHash,
				seller,
			},
		),
		key,
		certificate,
	)
	const head = {
		...newPosFiscalChain(crypto.randomUUID()),
		counter: counter - 1,
	}
	const fiscal = issuePosFiscalDocument(head, {
		kind: 'invoice',
		docId: orderId,
		orderId,
		at: new Date(NOW).toISOString(),
		currency: 'SAR',
		totalCents: totals.totalCents,
		taxCents: totals.taxCents,
	}).document
	const zatca = {
		invoiceNumber,
		uuid: signed.uuid,
		invoiceHash: signed.invoiceHash,
		xml: signed.xmlBase64,
		qr: signed.qr,
		totalCents: signed.totalCents,
		taxCents: signed.taxCents,
	}
	return {
		signed,
		order: (over: Partial<typeof zatca> = {}) =>
			({
				id: orderId,
				fiscal: [{ ...fiscal, zatca: { ...zatca, ...over } }],
			}) as unknown as PosOrderRequest,
	}
}

const submissions = () => db.select().from(posZatcaSubmissions)

/** A Fatoora stub that answers reports with `answer`. */
function fatoora(answer: (body: { uuid: string }) => Response) {
	const calls: string[] = []
	const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { uuid: string }
		calls.push(body.uuid)
		return answer(body)
	}) as unknown as typeof globalThis.fetch
	return { calls, fetch }
}

describe('queueing what the till signed', () => {
	it('queues a document whose XML says what the till says', async () => {
		const { order } = signedSale(1)
		expect(await queueZatcaDocuments(db, device, order(), NOW)).toBe(1)
		expect(await submissions()).toMatchObject([
			{ status: 'pending', counter: 1, lastError: null },
		])
		// The same upload again changes nothing.
		expect(await queueZatcaDocuments(db, device, order(), NOW)).toBe(0)
		expect(await submissions()).toHaveLength(1)
	})

	it('keeps a document whose claims differ from its XML as rejected, and never sends it', async () => {
		const { order } = signedSale(1)
		expect(
			await queueZatcaDocuments(
				db,
				device,
				order({
					invoiceHash: Buffer.alloc(32, 7).toString('base64'),
					totalCents: 1,
				}),
				NOW,
			),
		).toBe(0)
		const [row] = await submissions()
		expect(row).toMatchObject({ status: 'rejected' })
		expect(row!.lastError).toMatch(/invoice hash, total/)
		const { calls, fetch } = fatoora(() => Response.json({}))
		await reportDueZatca(db, { fetch, now: () => NOW })
		expect(calls).toEqual([])
	})

	it('refuses XML that is not a signed document', async () => {
		const { order } = signedSale(1)
		await queueZatcaDocuments(
			db,
			device,
			order({ xml: Buffer.from('<Invoice/>').toString('base64') }),
			NOW,
		)
		expect(await submissions()).toMatchObject([{ status: 'rejected' }])
	})

	it('refuses a document signed for another seller', async () => {
		await db
			.update(posZatcaUnits)
			.set({ seller: { ...seller, vatNumber: '300000000000003' } })
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		const [row] = await submissions()
		expect(row!.lastError).toMatch(/VAT number/)
	})

	it('stores one document per counter of a unit, even when two arrive at once', async () => {
		const first = signedSale(5)
		const second = signedSale(5)
		const results = await Promise.all([
			queueZatcaDocuments(db, device, first.order(), NOW),
			queueZatcaDocuments(db, device, second.order(), NOW),
		])
		expect(results.sort()).toEqual([0, 1])
		expect(await submissions()).toHaveLength(1)
	})

	it('logs a PIH that does not continue the chain, and still reports it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const first = signedSale(1)
		await queueZatcaDocuments(db, device, first.order(), NOW)
		const second = signedSale(2, Buffer.alloc(32, 1).toString('base64'))
		expect(await queueZatcaDocuments(db, device, second.order(), NOW)).toBe(1)
		expect(warn).toHaveBeenCalledWith('ZATCA PIH chain break', {
			deviceId: device.id,
			counter: 2,
		})
		const chained = signedSale(3, second.signed.invoiceHash)
		warn.mockClear()
		await queueZatcaDocuments(db, device, chained.order(), NOW)
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe('reporting', () => {
	it('claims documents, so two runs at once report each document once', async () => {
		for (const n of [1, 2, 3])
			await queueZatcaDocuments(db, device, signedSale(n).order(), NOW)
		const { calls, fetch } = fatoora(() =>
			Response.json({ reportingStatus: 'REPORTED' }),
		)
		const [a, b] = await Promise.all([
			reportDueZatca(db, { fetch, now: () => NOW }),
			reportDueZatca(db, { fetch, now: () => NOW }),
		])
		expect(a.reported + b.reported).toBe(3)
		expect(calls).toHaveLength(3)
		expect(new Set(calls).size).toBe(3)
	})

	it('never turns a reported document into a rejected one', async () => {
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		const { fetch } = fatoora(() =>
			Response.json(
				{ validationResults: { errorMessages: [{ message: 'Duplicate' }] } },
				{ status: 400 },
			),
		)
		// Another run reported it while this one's lease ran out.
		const report = reportDueZatca(db, {
			fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
				await db
					.update(posZatcaSubmissions)
					.set({ status: 'reported', reportedAt: NOW })
				return fetch(...args)
			}) as typeof globalThis.fetch,
			now: () => NOW,
		})
		await report
		expect(await submissions()).toMatchObject([{ status: 'reported' }])
	})

	it('flags a refused CSID on the unit and backs off for an hour instead of retrying quietly', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		for (const n of [1, 2])
			await queueZatcaDocuments(db, device, signedSale(n).order(), NOW)
		const { calls, fetch } = fatoora(() => new Response('', { status: 401 }))
		expect(await reportDueZatca(db, { fetch, now: () => NOW })).toMatchObject({
			retry: 2,
			rejected: 0,
		})
		// The second document is not sent with credentials already refused.
		expect(calls).toHaveLength(1)
		const rows = await submissions()
		expect(rows.every((r) => r.status === 'pending')).toBe(true)
		expect(rows.every((r) => r.nextAttemptAt === NOW + 60 * 60_000)).toBe(true)
		const [unit] = await db.select().from(posZatcaUnits)
		expect(unit!.authFailedAt).toBe(NOW)
		expect(unit!.lastError).toMatch(/refused this terminal's CSID/)
		expect(error).toHaveBeenCalledWith(
			'ZATCA refused a production CSID',
			expect.objectContaining({ deviceId: device.id }),
		)
		// It clears once ZATCA accepts the credentials again.
		const ok = fatoora(() => Response.json({ reportingStatus: 'REPORTED' }))
		await reportDueZatca(db, { fetch: ok.fetch, now: () => NOW + 2 * 3600_000 })
		const [after] = await db.select().from(posZatcaUnits)
		expect(after!.authFailedAt).toBeNull()
		error.mockRestore()
	})

	it('treats a 2xx whose validation failed as a refusal', async () => {
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		const { fetch } = fatoora(() =>
			Response.json({
				validationResults: {
					status: 'ERROR',
					errorMessages: [{ code: 'BR-KSA-98', message: 'bad' }],
				},
				reportingStatus: 'NOT_REPORTED',
			}),
		)
		expect(await reportDueZatca(db, { fetch, now: () => NOW })).toMatchObject({
			rejected: 1,
		})
		expect(await submissions()).toMatchObject([
			{ status: 'rejected', lastError: 'BR-KSA-98: bad' },
		])
	})

	it('retries a unit whose secret does not open without stopping the others', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const [other] = await db
			.insert(posDevices)
			.values({
				label: 'Back',
				terminalCode: 'T2',
				secretHash: 'y',
				pairedBy: 'test',
			})
			.returning()
		// Sealed for another unit: the associated data does not match.
		await addUnit(other!.id, {
			productionSecretSealed: seal(
				'production-secret',
				sealContext(device.id, 'production_secret'),
			),
		})
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		await queueZatcaDocuments(db, other!, signedSale(1).order(), NOW)
		const { calls, fetch } = fatoora(() =>
			Response.json({ reportingStatus: 'REPORTED' }),
		)
		expect(await reportDueZatca(db, { fetch, now: () => NOW })).toMatchObject({
			reported: 1,
			retry: 1,
		})
		expect(calls).toHaveLength(1)
		const broken = (await submissions()).find((r) => r.deviceId === other!.id)
		expect(broken).toMatchObject({ status: 'pending' })
		expect(broken!.lastError).toMatch(/cannot be opened/)
		error.mockRestore()
	})

	it('warns about documents close to the 24-hour limit', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		await db
			.update(posZatcaSubmissions)
			.set({ nextAttemptAt: NOW + 30 * 3600_000 })
		const later = NOW + 21 * 3600_000
		await reportDueZatca(db, { now: () => later })
		expect(error).toHaveBeenCalledWith(
			'ZATCA documents pending for more than 20 hours',
			{ overdue: 1 },
		)
		expect((await zatcaOverview(db, later)).overdue).toBe(1)
		error.mockRestore()
	})
})

describe('a removed terminal', () => {
	it('retires the unit: no key for the till, but what it uploaded is still reported', async () => {
		await queueZatcaDocuments(db, device, signedSale(1).order(), NOW)
		await revokeZatcaUnitsForDevice(db, device.id, NOW)
		const [unit] = await db
			.select()
			.from(posZatcaUnits)
			.where(eq(posZatcaUnits.deviceId, device.id))
		expect(unit).toMatchObject({ status: 'revoked', revokedAt: NOW })
		expect(await unitCredentials(db, device.id)).toBeNull()
		const { calls, fetch } = fatoora(() =>
			Response.json({ reportingStatus: 'REPORTED' }),
		)
		await reportDueZatca(db, { fetch, now: () => NOW })
		expect(calls).toHaveLength(1)
		// Revoking twice keeps the first time.
		await revokeZatcaUnitsForDevice(db, device.id, NOW + 1000)
		const [again] = await db.select().from(posZatcaUnits)
		expect(again!.revokedAt).toBe(NOW)
	})

	it('works inside a transaction', async () => {
		await db.transaction(async (tx) => {
			await revokeZatcaUnitsForDevice(tx, device.id, NOW)
		})
		const [unit] = await db.select().from(posZatcaUnits)
		expect(unit!.status).toBe('revoked')
	})
})

describe('rotating the seal key', () => {
	it('moves unit secrets onto the current key, once, and skips a unit it cannot open', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const [other] = await db
			.insert(posDevices)
			.values({
				label: 'Back',
				terminalCode: 'T2',
				secretHash: 'y',
				pairedBy: 'test',
			})
			.returning()
		// Sealed for another unit: the associated data does not match.
		await addUnit(other!.id, {
			privateKeySealed: seal(
				'bb'.repeat(32),
				sealContext(device.id, 'private_key'),
			),
		})
		try {
			process.env.ZATCA_SEAL_KEY = 'ab'.repeat(32)
			expect(await resealZatcaUnits(db, NOW)).toEqual({ resealed: 1 })
			const [unit] = await db
				.select()
				.from(posZatcaUnits)
				.where(eq(posZatcaUnits.deviceId, device.id))
			expect(unit!.privateKeySealed).toMatch(/^v2\.z/)
			expect(unit!.productionSecretSealed).toMatch(/^v2\.z/)
			expect((await unitCredentials(db, device.id))!.privateKeyHex).toBe(
				'aa'.repeat(32),
			)
			expect(error).toHaveBeenCalledWith(
				'ZATCA unit secret cannot be re-sealed',
				{ deviceId: other!.id },
			)
			// Nothing left to move.
			expect(await resealZatcaUnits(db, NOW)).toEqual({ resealed: 0 })
		} finally {
			// Empty instead of deleted: the varlock sync only copies defined values.
			process.env.ZATCA_SEAL_KEY = ''
			error.mockRestore()
		}
	})
})

describe('seller details', () => {
	it('signs with the details the certificate was issued for, until the unit is onboarded again', async () => {
		await db
			.update(posZatcaSettings)
			.set({ sellerName: 'New Name', vatNumber: '300000000000003' })
		const credentials = await unitCredentials(db, device.id)
		expect(credentials!.seller).toEqual(seller)
		const overview = await zatcaOverview(db, NOW)
		expect(overview.units[0]).toMatchObject({ sellerOutdated: true })
	})

	it('falls back to the settings for a unit onboarded before the seller was kept', async () => {
		await db.update(posZatcaUnits).set({ seller: null })
		const credentials = await unitCredentials(db, device.id)
		expect(credentials!.seller.vatNumber).toBe(seller.vatNumber)
	})

	it('refuses a legal name too long for the QR code, and control characters', () => {
		const { id: _id, updatedBy: _by, ...input } = settingsRow
		expect(zatcaSettingsSchema.safeParse(input).success).toBe(true)
		// 130 Arabic letters: 130 characters, 260 bytes.
		expect(
			zatcaSettingsSchema.safeParse({ ...input, sellerName: 'م'.repeat(130) })
				.success,
		).toBe(false)
		expect(
			zatcaSettingsSchema.safeParse({ ...input, sellerName: 'م'.repeat(120) })
				.success,
		).toBe(true)
		expect(
			zatcaSettingsSchema.safeParse({ ...input, street: 'Main\u0001 St' })
				.success,
		).toBe(false)
	})
})
