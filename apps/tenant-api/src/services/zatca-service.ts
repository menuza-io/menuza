import { and, asc, desc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { type PosOrderRequest } from '@repo/common/pos-orders'
import {
	buildCsr,
	fromRefund,
	fromSale,
	generatePrivateKey,
	hasXmlIllegal,
	readCertificate,
	readSignedDocument,
	riyadhDateTime,
	signDocument,
	toHex,
	ZATCA_GENESIS_PIH,
	xmlSafe,
	ZATCA_QR_TAG_MAX_BYTES,
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
import { needsReseal, seal, sealContext, unseal } from '../lib/zatca-seal.ts'

/**
 * ZATCA Phase 2 for walk-in sales. Each POS terminal is an EGS unit: the server
 * onboards it (key, CSR, compliance CSID, compliance checks, production CSID),
 * hands the till its key and certificate so it can sign simplified documents
 * offline, and reports every signed document to ZATCA within 24 hours.
 * Secrets are sealed at rest; CSID secrets never leave the server.
 */

/** Free text that goes into signed XML: no characters XML 1.0 does not allow. */
const xmlText = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((v) => !hasXmlIllegal(v), 'Remove control characters')

export const zatcaSettingsSchema = z.strictObject({
	environment: z.enum(['sandbox', 'simulation', 'production']),
	// The legal name is QR tag 1, whose length is a single byte.
	sellerName: xmlText(200).refine(
		(v) => new TextEncoder().encode(v).length <= ZATCA_QR_TAG_MAX_BYTES,
		`The legal name must fit in ${ZATCA_QR_TAG_MAX_BYTES} bytes (about 120 Arabic letters)`,
	),
	vatNumber: z
		.string()
		.regex(
			/^3\d{13}3$/,
			'A VAT number has 15 digits and starts and ends with 3',
		),
	crNumber: z
		.string()
		.regex(/^\d{10}$/, 'A commercial registration number has 10 digits'),
	street: xmlText(200),
	buildingNumber: z.string().regex(/^\d{4}$/, 'A building number has 4 digits'),
	district: xmlText(200),
	city: xmlText(100),
	postalCode: z.string().regex(/^\d{5}$/, 'A postal code has 5 digits'),
	businessCategory: xmlText(100),
	branchName: xmlText(100),
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

/** The organization's database, or a transaction on it. */
type Db =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

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
	const sale = {
		taxRatePercent: 15,
		totalCents: 1150,
		outOfScopeCents: 0,
		taxCents: 150,
	}
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
		if (existing?.status === 'active' || existing?.status === 'revoked') {
			await db
				.update(posZatcaUnits)
				.set({ lastError, updatedAt: now })
				.where(eq(posZatcaUnits.deviceId, device.id))
		} else {
			const row = {
				environment,
				status: 'failed' as const,
				privateKeySealed: seal(
					toHex(privateKey),
					sealContext(device.id, 'private_key'),
				),
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

	// A removed terminal's unit stays retired (its documents are still reported).
	if (existing?.status === 'revoked')
		return failed('settings', 'This terminal was removed.')

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
		privateKeySealed: seal(
			toHex(privateKey),
			sealContext(device.id, 'private_key'),
		),
		complianceRequestId: complianceCsid.requestId,
		complianceToken: complianceCsid.binarySecurityToken,
		complianceSecretSealed: seal(
			complianceCsid.secret,
			sealContext(device.id, 'compliance_secret'),
		),
		productionToken: production.value.binarySecurityToken,
		productionSecretSealed: seal(
			production.value.secret,
			sealContext(device.id, 'production_secret'),
		),
		// The certificate was issued for these details; the till signs with them
		// until the unit is onboarded again, whatever the settings say later.
		seller,
		authFailedAt: null,
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

/**
 * What a till needs to sign: its key, its production certificate and the
 * seller the certificate was issued for. Only for an active unit.
 */
export async function unitCredentials(db: TenantDatabase, deviceId: string) {
	const [unit] = await db
		.select()
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, deviceId))
		.limit(1)
	if (!unit || unit.status !== 'active' || !unit.productionToken) return null
	// Units onboarded before the seller was kept on the unit use the settings.
	const settings = unit.seller ? null : await getZatcaSettings(db)
	const seller = unit.seller ?? (settings ? sellerOf(settings) : null)
	if (!seller) return null
	return {
		environment: unit.environment,
		privateKeyHex: unseal(
			unit.privateKeySealed,
			sealContext(deviceId, 'private_key'),
		),
		certificate: unit.productionToken,
		seller,
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

/**
 * Retires the ZATCA unit of a terminal that was removed: the till can no longer
 * fetch its key, and nothing it uploads afterwards is reported. Documents it
 * uploaded before removal are still reported (ZATCA requires every issued
 * document within 24 hours). Revoke the CSID in the Fatoora portal too.
 */
export async function revokeZatcaUnitsForDevice(
	db: Db,
	deviceId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.update(posZatcaUnits)
		.set({ status: 'revoked', revokedAt: now, updatedAt: now })
		.where(
			and(
				eq(posZatcaUnits.deviceId, deviceId),
				ne(posZatcaUnits.status, 'revoked'),
			),
		)
}

const SEALED_COLUMNS = [
	['privateKeySealed', 'private_key'],
	['complianceSecretSealed', 'compliance_secret'],
	['productionSecretSealed', 'production_secret'],
] as const

/**
 * Moves sealed unit secrets onto the current `ZATCA_SEAL_KEY`: values sealed
 * with a previous key (`ZATCA_SEAL_KEY_PREVIOUS`), the derived key or the `v1`
 * format are opened and sealed again. Runs on the regional tick; a unit whose
 * secrets cannot be opened is logged and left as it is.
 */
export async function resealZatcaUnits(db: Db, now = Date.now()) {
	// bounded: one row per terminal of the organization.
	const units = await db
		.select({
			deviceId: posZatcaUnits.deviceId,
			privateKeySealed: posZatcaUnits.privateKeySealed,
			complianceSecretSealed: posZatcaUnits.complianceSecretSealed,
			productionSecretSealed: posZatcaUnits.productionSecretSealed,
		})
		.from(posZatcaUnits)
	let resealed = 0
	for (const unit of units) {
		try {
			const changes: Partial<
				Record<(typeof SEALED_COLUMNS)[number][0], string>
			> = {}
			for (const [field, column] of SEALED_COLUMNS) {
				const sealed = unit[field]
				if (!sealed || !needsReseal(sealed)) continue
				const context = sealContext(unit.deviceId, column)
				changes[field] = seal(unseal(sealed, context), context)
			}
			if (Object.keys(changes).length === 0) continue
			await db
				.update(posZatcaUnits)
				.set({ ...changes, updatedAt: now })
				.where(eq(posZatcaUnits.deviceId, unit.deviceId))
			resealed++
		} catch {
			console.error('ZATCA unit secret cannot be re-sealed', {
				deviceId: unit.deviceId,
			})
		}
	}
	return { resealed }
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

type FiscalDocument = PosOrderRequest['fiscal'][number]

/**
 * Why a document the till claims cannot be reported as it stands, or null.
 * The XML is what ZATCA receives, so what the server records (number, UUID,
 * counter, hash, amounts) must be what the XML says.
 */
function documentProblem(
	doc: FiscalDocument & { zatca: NonNullable<FiscalDocument['zatca']> },
	seller: { vatNumber: string } | null,
): string | null {
	const read = readSignedDocument(doc.zatca.xml)
	if (!read.ok) return read.error
	const xml = read.value
	const mismatch = [
		// The XML holds the number without characters XML does not allow.
		xml.id !== xmlSafe(doc.zatca.invoiceNumber) && 'invoice number',
		xml.uuid !== doc.zatca.uuid && 'UUID',
		xml.kind !== doc.kind && 'document type',
		xml.counter !== doc.counter && 'ICV',
		xml.invoiceHash !== doc.zatca.invoiceHash && 'invoice hash',
		xml.payableCents !== doc.zatca.totalCents && 'total',
		xml.taxCents !== doc.zatca.taxCents && 'VAT',
		seller && xml.vatNumber !== seller.vatNumber && 'VAT number',
	].filter(Boolean)
	return mismatch.length > 0
		? `the signed XML does not match its ${mismatch.join(', ')}`
		: null
}

/**
 * Queues the signed ZATCA documents an upload carries for reporting. A document
 * is stored once, and one per invoice counter value of a unit; a signed
 * document never changes (trigger). A document whose XML does not match what
 * the till says about it is kept as `rejected` and never sent.
 */
export async function queueZatcaDocuments(
	db: TenantDatabase,
	device: PosDevice,
	order: PosOrderRequest,
	now = Date.now(),
) {
	const signed = order.fiscal.filter(
		(
			d,
		): d is FiscalDocument & { zatca: NonNullable<FiscalDocument['zatca']> } =>
			Boolean(d.zatca),
	)
	if (signed.length === 0) return 0
	const [unit] = await db
		.select({ seller: posZatcaUnits.seller })
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, device.id))
		.limit(1)
	let queued = 0
	for (const doc of signed) {
		const problem = documentProblem(doc, unit?.seller ?? null)
		const stored = await db
			.insert(posZatcaSubmissions)
			.values({
				docId: doc.docId,
				deviceId: device.id,
				orderId: order.id,
				kind: doc.kind,
				counter: doc.counter,
				uuid: doc.zatca.uuid,
				invoiceHash: doc.zatca.invoiceHash,
				xmlBase64: doc.zatca.xml,
				status: problem ? 'rejected' : 'pending',
				lastError: problem ? `Not reported: ${problem}.` : null,
				issuedAt: Date.parse(doc.at),
				receivedAt: now,
			})
			// The same document again, or another one on a counter already used.
			.onConflictDoNothing()
			.returning({ docId: posZatcaSubmissions.docId })
		if (stored.length === 0) continue
		if (problem) {
			console.error('ZATCA document refused before reporting', {
				deviceId: device.id,
				docId: doc.docId,
				problem,
			})
			continue
		}
		await warnOnBrokenPih(db, device.id, doc.counter, doc.zatca.invoiceHash)
		queued++
	}
	return queued
}

/**
 * Logs (ids only) when a document's PIH does not continue the unit's chain as
 * the server holds it. Tills upload out of order, so this can only be seen
 * from the side that arrives second; ZATCA decides what it accepts.
 */
async function warnOnBrokenPih(
	db: TenantDatabase,
	deviceId: string,
	counter: number,
	invoiceHash: string,
) {
	const neighbours = await db
		.select({
			docId: posZatcaSubmissions.docId,
			counter: posZatcaSubmissions.counter,
			invoiceHash: posZatcaSubmissions.invoiceHash,
			xmlBase64: posZatcaSubmissions.xmlBase64,
		})
		.from(posZatcaSubmissions)
		.where(
			and(
				eq(posZatcaSubmissions.deviceId, deviceId),
				// bounded: three counters
				inArray(posZatcaSubmissions.counter, [
					counter - 1,
					counter,
					counter + 1,
				]),
			),
		)
	const at = (n: number) => neighbours.find((r) => r.counter === n)
	const self = at(counter)
	const before = at(counter - 1)
	const after = at(counter + 1)
	const pihOf = (xmlBase64: string) => {
		const read = readSignedDocument(xmlBase64)
		return read.ok ? read.value.previousHash : null
	}
	const broken =
		(self && before && pihOf(self.xmlBase64) !== before.invoiceHash) ||
		(after && pihOf(after.xmlBase64) !== invoiceHash)
	if (broken) console.warn('ZATCA PIH chain break', { deviceId, counter })
}

const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
/** How long a run holds the documents it claimed (each report may take 20 seconds). */
const LEASE_MS = 15 * 60_000
/** A credential ZATCA refused is tried again hourly, not on the usual backoff. */
const UNAUTHORIZED_RETRY_MS = 60 * 60_000
/** ZATCA wants simplified documents within 24 hours; warn well before. */
const OVERDUE_MS = 20 * 60 * 60_000
/** When each organization's database last warned about overdue documents. */
const lastOverdueWarning = new WeakMap<object, number>()

type ReportingUnit =
	| { ok: true; csid: Csid; environment: ZatcaEnvironment }
	| { ok: false; error: string; retryMs?: number }

/** The unit's production CSID, or why it cannot report. A secret that does not open fails this unit only. */
async function reportingUnit(db: Db, deviceId: string): Promise<ReportingUnit> {
	const [unit] = await db
		.select()
		.from(posZatcaUnits)
		.where(eq(posZatcaUnits.deviceId, deviceId))
		.limit(1)
	// A removed terminal's unit still reports what it uploaded while it was
	// active: ZATCA wants every issued document, and the CSID stays valid until
	// it is revoked in the Fatoora portal.
	if (
		!unit ||
		(unit.status !== 'active' && unit.status !== 'revoked') ||
		!unit.productionToken ||
		!unit.productionSecretSealed
	)
		return { ok: false, error: 'This terminal is not an active ZATCA unit.' }
	try {
		return {
			ok: true,
			environment: unit.environment as ZatcaEnvironment,
			csid: {
				binarySecurityToken: unit.productionToken,
				secret: unseal(
					unit.productionSecretSealed,
					sealContext(deviceId, 'production_secret'),
				),
				requestId: unit.complianceRequestId ?? '',
			},
		}
	} catch {
		console.error('ZATCA unit secret cannot be unsealed', { deviceId })
		return {
			ok: false,
			error:
				'The CSID secret cannot be opened (seal key changed?). Onboard the terminal again.',
		}
	}
}

/**
 * Reports due documents to ZATCA, oldest first. Accepted (200) is `reported`,
 * accepted with warnings (202) is `warning`, refused is `rejected` with
 * ZATCA's reasons; anything that may clear is retried with backoff.
 *
 * Runs concurrently (after uploads and from the tick), so each run first
 * claims its documents by pushing their next attempt out by a lease, and only
 * a document still `pending` takes a result: a duplicate report never turns a
 * reported document into a rejected one.
 */
export async function reportDueZatca(
	db: Db,
	deps: Deps & { limit?: number } = {},
) {
	const now = deps.now?.() ?? Date.now()
	await warnOverdue(db, now)
	const candidates = await db
		.select({ docId: posZatcaSubmissions.docId })
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
		// Durable Object SQLite binds at most 100 parameters per statement.
		.limit(Math.min(deps.limit ?? 20, 90))
	const totals = { reported: 0, warning: 0, rejected: 0, retry: 0 }
	if (candidates.length === 0) return totals
	const claimed = await db
		.update(posZatcaSubmissions)
		.set({ nextAttemptAt: now + LEASE_MS })
		.where(
			and(
				// bounded: at most 90 documents (the limit above)
				inArray(
					posZatcaSubmissions.docId,
					candidates.map((c) => c.docId),
				),
				eq(posZatcaSubmissions.status, 'pending'),
				lte(posZatcaSubmissions.nextAttemptAt, now),
			),
		)
		.returning()
	claimed.sort(
		(a, b) => a.deviceId.localeCompare(b.deviceId) || a.counter - b.counter,
	)
	const units = new Map<string, ReportingUnit>()
	const accepted = new Set<string>()
	/** Only a document this run still holds takes its result. */
	const settle = (
		docId: string,
		values: Partial<typeof posZatcaSubmissions.$inferInsert>,
	) =>
		db
			.update(posZatcaSubmissions)
			.set(values)
			.where(
				and(
					eq(posZatcaSubmissions.docId, docId),
					eq(posZatcaSubmissions.status, 'pending'),
				),
			)
	for (const doc of claimed) {
		let unit = units.get(doc.deviceId)
		if (!unit) {
			unit = await reportingUnit(db, doc.deviceId)
			units.set(doc.deviceId, unit)
		}
		const attempts = doc.attempts + 1
		const later = now + RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!
		if (!unit.ok) {
			await settle(doc.docId, {
				attempts,
				nextAttemptAt: unit.retryMs ? now + unit.retryMs : later,
				lastError: unit.error,
			})
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
			await settle(doc.docId, {
				status,
				attempts,
				response: result.value,
				reportedAt: now,
				lastError: null,
			})
			totals[status]++
			accepted.add(doc.deviceId)
		} else if (result.unauthorized) {
			// The CSID itself was refused: every document of this unit would be.
			// Not a refusal of the document, and not something to retry quietly.
			const error = `ZATCA refused this terminal's CSID (${result.error}). Onboard it again.`
			console.error('ZATCA refused a production CSID', {
				deviceId: doc.deviceId,
				status: result.status,
			})
			await db
				.update(posZatcaUnits)
				.set({ authFailedAt: now, lastError: `reporting: ${error}` })
				.where(eq(posZatcaUnits.deviceId, doc.deviceId))
			units.set(doc.deviceId, {
				ok: false,
				error,
				retryMs: UNAUTHORIZED_RETRY_MS,
			})
			await settle(doc.docId, {
				attempts,
				nextAttemptAt: now + UNAUTHORIZED_RETRY_MS,
				lastError: error,
			})
			totals.retry++
		} else if (result.retry) {
			await settle(doc.docId, {
				attempts,
				nextAttemptAt: later,
				lastError: result.error,
			})
			totals.retry++
		} else {
			await settle(doc.docId, {
				status: 'rejected',
				attempts,
				response: result.body,
				lastError: result.error,
			})
			totals.rejected++
		}
	}
	// A unit whose CSID was refused earlier works again.
	for (const deviceId of accepted)
		await db
			.update(posZatcaUnits)
			.set({ authFailedAt: null })
			.where(
				and(
					eq(posZatcaUnits.deviceId, deviceId),
					sql`${posZatcaUnits.authFailedAt} is not null`,
				),
			)
	return totals
}

/** Pending documents issued more than 20 hours ago (ZATCA's limit is 24). */
async function overdueCount(db: Db, now: number) {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(posZatcaSubmissions)
		.where(
			and(
				eq(posZatcaSubmissions.status, 'pending'),
				lt(posZatcaSubmissions.issuedAt, now - OVERDUE_MS),
			),
		)
	return Number(row?.n ?? 0)
}

/** Logs, at most hourly per process, that documents are close to ZATCA's 24-hour limit. */
async function warnOverdue(db: Db, now: number) {
	if (now - (lastOverdueWarning.get(db) ?? 0) < 60 * 60_000) return
	const overdue = await overdueCount(db, now)
	if (overdue === 0) return
	lastOverdueWarning.set(db, now)
	console.error('ZATCA documents pending for more than 20 hours', { overdue })
}

export async function zatcaOverview(db: TenantDatabase, now = Date.now()) {
	const settings = await getZatcaSettings(db)
	const rows = await db
		.select({
			deviceId: posZatcaUnits.deviceId,
			status: posZatcaUnits.status,
			environment: posZatcaUnits.environment,
			lastError: posZatcaUnits.lastError,
			onboardedAt: posZatcaUnits.onboardedAt,
			authFailedAt: posZatcaUnits.authFailedAt,
			revokedAt: posZatcaUnits.revokedAt,
			seller: posZatcaUnits.seller,
		})
		.from(posZatcaUnits)
	const current = settings ? JSON.stringify(sellerOf(settings)) : null
	const units = rows.map(({ seller, ...unit }) => ({
		...unit,
		// The seller details changed since this unit was onboarded: it keeps
		// signing with the old ones until it is onboarded again.
		sellerOutdated:
			unit.status === 'active' &&
			Boolean(seller && current && JSON.stringify(seller) !== current),
	}))
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
		/** Pending for more than 20 hours: close to ZATCA's 24-hour limit. */
		overdue: await overdueCount(db, now),
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
