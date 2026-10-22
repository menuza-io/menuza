import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { type PosOrderRequest } from '@repo/common/pos-orders'
import {
	buildCsr,
	fromRefund,
	fromSale,
	generatePrivateKey,
	readCertificate,
	riyadhDateTime,
	signDocument,
	toHex,
	ZATCA_GENESIS_PIH,
	type ZatcaEnvironment,
	type ZatcaSeller,
} from '@repo/zatca'
import { fatooraClient, type Csid } from '@repo/zatca/api'
import {
	posDevices,
	posZatcaSettings,
	posZatcaSubmissions,
	posZatcaUnits,
	type PosDevice,
	type PosZatcaSettingsRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { z } from 'zod'
import { seal, unseal } from '../lib/zatca-seal.ts'

/**
 * ZATCA Phase 2 for walk-in sales. Each POS terminal is an EGS unit: the server
 * onboards it (key, CSR, compliance CSID, compliance checks, production CSID),
 * hands the till its key and certificate so it can sign simplified documents
 * offline, and reports every signed document to ZATCA within 24 hours.
 * Secrets are sealed at rest; CSID secrets never leave the server.
 */

export const zatcaSettingsSchema = z.strictObject({
	environment: z.enum(['sandbox', 'simulation', 'production']),
	sellerName: z.string().trim().min(1).max(200),
	vatNumber: z
		.string()
		.regex(
			/^3\d{13}3$/,
			'A VAT number has 15 digits and starts and ends with 3',
		),
	crNumber: z
		.string()
		.regex(/^\d{10}$/, 'A commercial registration number has 10 digits'),
	street: z.string().trim().min(1).max(200),
	buildingNumber: z.string().regex(/^\d{4}$/, 'A building number has 4 digits'),
	district: z.string().trim().min(1).max(200),
	city: z.string().trim().min(1).max(100),
	postalCode: z.string().regex(/^\d{5}$/, 'A postal code has 5 digits'),
	businessCategory: z.string().trim().min(1).max(100),
	branchName: z.string().trim().min(1).max(100),
})
export type ZatcaSettingsInput = z.infer<typeof zatcaSettingsSchema>

export async function getZatcaSettings(
	db: TenantDatabase,
): Promise<PosZatcaSettingsRow | null> {
	const [row] = await db
		.select()
		.from(posZatcaSettings)
		.where(eq(posZatcaSettings.id, 'main'))
		.limit(1)
	return row ?? null
}

export async function saveZatcaSettings(
	db: TenantDatabase,
	input: ZatcaSettingsInput,
	by: string,
	now = Date.now(),
) {
	const values = { ...input, updatedBy: by, updatedAt: now }
	await db
		.insert(posZatcaSettings)
		.values({ id: 'main', ...values })
		.onConflictDoUpdate({ target: posZatcaSettings.id, set: values })
	return getZatcaSettings(db)
}

const sellerOf = (s: PosZatcaSettingsRow): ZatcaSeller => ({
	name: s.sellerName,
	vatNumber: s.vatNumber,
	crNumber: s.crNumber,
	street: s.street,
	buildingNumber: s.buildingNumber,
	district: s.district,
	city: s.city,
	postalCode: s.postalCode,
})

type Deps = { fetch?: typeof fetch; now?: () => number }

/** A sample of each document type this unit issues, signed, for ZATCA's compliance checks. */
function complianceSamples(
	seller: ZatcaSeller,
	privateKey: Uint8Array,
	certificateToken: string,
	now: Date,
) {
	const certificate = readCertificate(certificateToken)
	const meta = (counter: number, previousHash: string, prefix: string) => ({
		id: `${prefix}-${counter}`,
		uuid: crypto.randomUUID(),
		issuedAt: now,
		counter,
		previousHash,
		seller,
	})
	const invoiceInput = fromSale(
		{
			lines: [
				{
					name: 'Compliance check item',
					variantLabel: null,
					quantity: 1,
					baseCents: 1000,
					options: [],
				},
			],
			taxRatePercent: 15,
			taxInclusive: false,
			totals: {
				adjustmentCents: 0,
				taxCents: 150,
				tipCents: 0,
				totalCents: 1150,
			},
			payments: [{ method: 'cash' }],
		},
		meta(1, ZATCA_GENESIS_PIH, 'CHK-INV'),
	)
	const invoice = signDocument(invoiceInput, privateKey, certificate)
	const reference = { id: invoiceInput.id, issueDate: riyadhDateTime(now).date }
	const sale = { taxRatePercent: 15, totalCents: 1150, outOfScopeCents: 0 }
	const creditInput = fromRefund(
		{ amountCents: 1150, method: 'cash', reason: 'Compliance check refund' },
		sale,
		{ ...meta(2, invoice.invoiceHash, 'CHK-CN'), billingReference: reference },
	)
	const credit = signDocument(creditInput, privateKey, certificate)
	const debitInput = fromRefund(
		{
			amountCents: 230,
			method: 'cash',
			reason: 'Compliance check charge',
			kind: 'debit_note',
		},
		sale,
		{ ...meta(3, credit.invoiceHash, 'CHK-DN'), billingReference: reference },
	)
	const debit = signDocument(debitInput, privateKey, certificate)
	return [invoice, credit, debit]
}

export type OnboardResult =
	| { ok: true }
	| {
			ok: false
			step: 'settings' | 'compliance' | 'checks' | 'production'
			error: string
	  }

/**
 * Onboards one terminal as an EGS unit with the one-time password a manager
 * generated in the Fatoora portal. Each step's outcome is recorded on the
 * unit, so a failed attempt says where it stopped.
 */
export async function onboardUnit(
	db: TenantDatabase,
	device: Pick<PosDevice, 'id' | 'terminalCode'>,
	otp: string,
	deps: Deps = {},
): Promise<OnboardResult> {
	const now = deps.now?.() ?? Date.now()
	const settings = await getZatcaSettings(db)
	if (!settings)
		return {
			ok: false,
			step: 'settings',
			error: 'Enter the seller details first.',
		}
	const environment = settings.environment as ZatcaEnvironment
	const client = fatooraClient(environment, deps.fetch)
	const privateKey = generatePrivateKey()
	const seller = sellerOf(settings)
	const csr = buildCsr(
		{
			environment,
			organizationName: settings.sellerName,
			organizationUnit: settings.branchName,
			commonName: `${device.terminalCode}-${device.id.slice(0, 8)}`,
			serialNumber: `1-Menuza|2-POS|3-${device.id}`,
			vatNumber: settings.vatNumber,
			invoiceTypes: '0100',
			address: `${settings.buildingNumber} ${settings.street}, ${settings.district}, ${settings.city} ${settings.postalCode}`,
			businessCategory: settings.businessCategory,
		},
		privateKey,
	)
	// A unit that is already active keeps its key, certificates and status until a
	// new onboarding has fully succeeded: a mistyped password or a ZATCA outage
	// must not cost a working terminal its signing key.
	const [existing] = await db
		.select()
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, device.id))
		.limit(1)
	const failed = async (
		step: Exclude<OnboardResult, { ok: true }>['step'],
		error: string,
	): Promise<OnboardResult> => {
		const lastError = `${step}: ${error}`
		if (existing?.status === 'active') {
			await db
				.update(posZatcaUnits)
				.set({ lastError, updatedAt: now })
				.where(eq(posZatcaUnits.deviceId, device.id))
		} else {
			const row = {
				environment,
				status: 'failed' as const,
				privateKeySealed: seal(toHex(privateKey)),
				lastError,
				updatedAt: now,
			}
			await db
				.insert(posZatcaUnits)
				.values({ deviceId: device.id, ...row })
				.onConflictDoUpdate({ target: posZatcaUnits.deviceId, set: row })
		}
		return { ok: false, step, error }
	}

	const compliance = await client.complianceCsid(csr.base64Pem, otp)
	if (!compliance.ok) return failed('compliance', compliance.error)
	const complianceCsid: Csid = compliance.value

	for (const sample of complianceSamples(
		seller,
		privateKey,
		complianceCsid.binarySecurityToken,
		new Date(now),
	)) {
		const check = await client.complianceCheck(complianceCsid, sample)
		if (!check.ok) return failed('checks', check.error)
	}

	const production = await client.productionCsid(complianceCsid)
	if (!production.ok) return failed('production', production.error)
	const row = {
		environment,
		status: 'active' as const,
		privateKeySealed: seal(toHex(privateKey)),
		complianceRequestId: complianceCsid.requestId,
		complianceToken: complianceCsid.binarySecurityToken,
		complianceSecretSealed: seal(complianceCsid.secret),
		productionToken: production.value.binarySecurityToken,
		productionSecretSealed: seal(production.value.secret),
		lastError: null,
		onboardedAt: now,
		updatedAt: now,
	}
	await db
		.insert(posZatcaUnits)
		.values({ deviceId: device.id, ...row })
		.onConflictDoUpdate({ target: posZatcaUnits.deviceId, set: row })
	return { ok: true }
}

/** What a till needs to sign: its key, its production certificate and the seller. Only for an active unit. */
export async function unitCredentials(db: TenantDatabase, deviceId: string) {
	const [unit] = await db
		.select()
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, deviceId))
		.limit(1)
	const settings = await getZatcaSettings(db)
	if (!unit || unit.status !== 'active' || !unit.productionToken || !settings)
		return null
	return {
		environment: unit.environment,
		privateKeyHex: unseal(unit.privateKeySealed),
		certificate: unit.productionToken,
		seller: sellerOf(settings),
	}
}

/**
 * The unit's state for the till, with the hash of the last document the server
 * holds from it, so a till that lost its storage continues the PIH chain.
 */
export async function unitStatus(db: TenantDatabase, deviceId: string) {
	const [unit] = await db
		.select({
			status: posZatcaUnits.status,
			environment: posZatcaUnits.environment,
		})
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, deviceId))
		.limit(1)
	if (!unit) return null
	const [last] = await db
		.select({ invoiceHash: posZatcaSubmissions.invoiceHash })
		.from(posZatcaSubmissions)
		.where(eq(posZatcaSubmissions.deviceId, deviceId))
		.orderBy(desc(posZatcaSubmissions.counter))
		.limit(1)
	return { ...unit, lastInvoiceHash: last?.invoiceHash ?? null }
}

/** Documents still waiting to be reported (the tick re-arms sooner while there are some). */
export async function hasPendingZatca(db: Db) {
	const [row] = await db
		.select({ id: posZatcaSubmissions.docId })
		.from(posZatcaSubmissions)
		.where(eq(posZatcaSubmissions.status, 'pending'))
		.limit(1)
	return Boolean(row)
}

/**
 * Queues the signed ZATCA documents an upload carries for reporting. A document
 * is stored once; a signed document never changes (trigger).
 */
export async function queueZatcaDocuments(
	db: TenantDatabase,
	device: PosDevice,
	order: PosOrderRequest,
	now = Date.now(),
) {
	let queued = 0
	for (const doc of order.fiscal) {
		if (!doc.zatca) continue
		const [existing] = await db
			.select({ id: posZatcaSubmissions.docId })
			.from(posZatcaSubmissions)
			.where(eq(posZatcaSubmissions.docId, doc.docId))
			.limit(1)
		if (existing) continue
		await db.insert(posZatcaSubmissions).values({
			docId: doc.docId,
			deviceId: device.id,
			orderId: order.id,
			kind: doc.kind,
			counter: doc.counter,
			uuid: doc.zatca.uuid,
			invoiceHash: doc.zatca.invoiceHash,
			xmlBase64: doc.zatca.xml,
			status: 'pending',
			issuedAt: Date.parse(doc.at),
			receivedAt: now,
		})
		queued++
	}
	return queued
}

const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

/**
 * Reports due documents to ZATCA, oldest first. Accepted (200) is `reported`,
 * accepted with warnings (202) is `warning`, refused is `rejected` with
 * ZATCA's reasons; anything that may clear is retried with backoff.
 */
/** The organization's database, or a transaction on it. */
type Db =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

export async function reportDueZatca(
	db: Db,
	deps: Deps & { limit?: number } = {},
) {
	const now = deps.now?.() ?? Date.now()
	const due = await db
		.select()
		.from(posZatcaSubmissions)
		.where(
			and(
				eq(posZatcaSubmissions.status, 'pending'),
				lte(posZatcaSubmissions.nextAttemptAt, now),
			),
		)
		.orderBy(
			asc(posZatcaSubmissions.deviceId),
			asc(posZatcaSubmissions.counter),
		)
		.limit(deps.limit ?? 20)
	const units = new Map<
		string,
		{ csid: Csid; environment: ZatcaEnvironment } | null
	>()
	const totals = { reported: 0, warning: 0, rejected: 0, retry: 0 }
	for (const doc of due) {
		if (!units.has(doc.deviceId)) {
			const [unit] = await db
				.select()
				.from(posZatcaUnits)
				.where(eq(posZatcaUnits.deviceId, doc.deviceId))
				.limit(1)
			units.set(
				doc.deviceId,
				unit?.status === 'active' &&
					unit.productionToken &&
					unit.productionSecretSealed
					? {
							environment: unit.environment as ZatcaEnvironment,
							csid: {
								binarySecurityToken: unit.productionToken,
								secret: unseal(unit.productionSecretSealed),
								requestId: unit.complianceRequestId ?? '',
							},
						}
					: null,
			)
		}
		const unit = units.get(doc.deviceId)
		const attempts = doc.attempts + 1
		const later = now + RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!
		if (!unit) {
			await db
				.update(posZatcaSubmissions)
				.set({
					attempts,
					nextAttemptAt: later,
					lastError: 'This terminal is not an active ZATCA unit.',
				})
				.where(eq(posZatcaSubmissions.docId, doc.docId))
			totals.retry++
			continue
		}
		const result = await fatooraClient(unit.environment, deps.fetch).report(
			unit.csid,
			{
				invoiceHash: doc.invoiceHash,
				uuid: doc.uuid,
				xmlBase64: doc.xmlBase64,
			},
		)
		if (result.ok) {
			const status = result.status === 202 ? 'warning' : 'reported'
			await db
				.update(posZatcaSubmissions)
				.set({
					status,
					attempts,
					response: result.value,
					reportedAt: now,
					lastError: null,
				})
				.where(eq(posZatcaSubmissions.docId, doc.docId))
			totals[status]++
		} else if (result.retry) {
			await db
				.update(posZatcaSubmissions)
				.set({ attempts, nextAttemptAt: later, lastError: result.error })
				.where(eq(posZatcaSubmissions.docId, doc.docId))
			totals.retry++
		} else {
			await db
				.update(posZatcaSubmissions)
				.set({
					status: 'rejected',
					attempts,
					response: result.body,
					lastError: result.error,
				})
				.where(eq(posZatcaSubmissions.docId, doc.docId))
			totals.rejected++
		}
	}
	return totals
}

export async function zatcaOverview(db: TenantDatabase) {
	const settings = await getZatcaSettings(db)
	const units = await db
		.select({
			deviceId: posZatcaUnits.deviceId,
			status: posZatcaUnits.status,
			environment: posZatcaUnits.environment,
			lastError: posZatcaUnits.lastError,
			onboardedAt: posZatcaUnits.onboardedAt,
		})
		.from(posZatcaUnits)
	const counts = await db
		.select({ status: posZatcaSubmissions.status, n: sql<number>`count(*)` })
		.from(posZatcaSubmissions)
		.groupBy(posZatcaSubmissions.status)
	return {
		settings,
		units,
		submissions: Object.fromEntries(
			counts.map((c) => [c.status, c.n]),
		) as Partial<
			Record<'pending' | 'reported' | 'warning' | 'rejected', number>
		>,
	}
}

export async function listZatcaSubmissions(
	db: TenantDatabase,
	options: {
		status?: 'pending' | 'reported' | 'warning' | 'rejected'
		limit: number
	},
) {
	return db
		.select({
			docId: posZatcaSubmissions.docId,
			orderId: posZatcaSubmissions.orderId,
			kind: posZatcaSubmissions.kind,
			counter: posZatcaSubmissions.counter,
			status: posZatcaSubmissions.status,
			attempts: posZatcaSubmissions.attempts,
			lastError: posZatcaSubmissions.lastError,
			issuedAt: posZatcaSubmissions.issuedAt,
			reportedAt: posZatcaSubmissions.reportedAt,
			terminalCode: posDevices.terminalCode,
		})
		.from(posZatcaSubmissions)
		.leftJoin(posDevices, eq(posDevices.id, posZatcaSubmissions.deviceId))
		.where(
			options.status
				? eq(posZatcaSubmissions.status, options.status)
				: undefined,
		)
		.orderBy(desc(posZatcaSubmissions.issuedAt))
		.limit(options.limit)
}
