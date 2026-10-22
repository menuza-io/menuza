import {
	fromHex,
	fromRefund,
	fromSale,
	outOfScopeCents,
	readCertificate,
	riyadhDateTime,
	signDocument,
	ZATCA_GENESIS_PIH,
	type ZatcaCertificate,
	type ZatcaSeller,
} from '@repo/zatca'
import { type PosSettings } from './config.ts'
import { db, type PosOrder, type Refund, type ZatcaDocument } from './db.ts'

/**
 * This till as a ZATCA EGS unit. The server onboards the terminal and hands
 * over its signing key and production certificate; from then on every closed
 * sale and every refund is signed here, offline if need be, chained by PIH,
 * and uploaded with the order for the server to report.
 */

const UNIT_KEY = 'zatca:unit'
const PIH_KEY = 'zatca:pih'

export type ZatcaUnit = {
	environment: 'sandbox' | 'simulation' | 'production'
	privateKeyHex: string
	/** `binarySecurityToken` of the production CSID. */
	certificate: string
	seller: ZatcaSeller
}

/** Signing material read once per transaction: parsing the certificate is not free. */
let parsed: {
	token: string
	certificate: ZatcaCertificate
	key: Uint8Array
} | null = null

/** The unit, when this till is onboarded. Call inside a transaction over `db.meta`. */
async function unit(): Promise<
	(ZatcaUnit & { certificateParsed: ZatcaCertificate; key: Uint8Array }) | null
> {
	const row = (await db.meta.get(UNIT_KEY))?.value as ZatcaUnit | undefined
	if (!row) return null
	if (!parsed || parsed.token !== row.certificate) {
		parsed = {
			token: row.certificate,
			certificate: readCertificate(row.certificate),
			key: fromHex(row.privateKeyHex),
		}
	}
	return { ...row, certificateParsed: parsed.certificate, key: parsed.key }
}

const nextPih = async () =>
	((await db.meta.get(PIH_KEY))?.value as string | undefined) ??
	ZATCA_GENESIS_PIH

/** ZATCA reporting covers sales in riyals. */
const eligible = (order: Pick<PosOrder, 'currency'>) => order.currency === 'SAR'

/** Signs the invoice for a closed sale. Must run inside a transaction over `db.meta`. */
export async function signInvoice(
	order: PosOrder,
	counter: number,
	issuedAt: number,
): Promise<ZatcaDocument | null> {
	const egs = eligible(order) ? await unit() : null
	if (!egs) return null
	const invoiceNumber = invoiceId(order)
	const input = fromSale(saleOf(order), {
		id: invoiceNumber,
		uuid: crypto.randomUUID(),
		issuedAt: new Date(issuedAt),
		counter,
		previousHash: await nextPih(),
		seller: egs.seller,
	})
	const signed = signDocument(input, egs.key, egs.certificateParsed)
	await db.meta.put({ key: PIH_KEY, value: signed.invoiceHash })
	return {
		invoiceNumber,
		uuid: signed.uuid,
		invoiceHash: signed.invoiceHash,
		xml: signed.xmlBase64,
		qr: signed.qr,
		totalCents: signed.totalCents,
		taxCents: signed.taxCents,
	}
}

/** Signs the credit note for one refund. Must run inside a transaction over `db.meta`. */
export async function signCreditNote(
	order: PosOrder,
	refund: Refund,
	counter: number,
	reason: string,
): Promise<ZatcaDocument | null> {
	const egs = eligible(order) ? await unit() : null
	const invoice = order.fiscal.find((d) => d.kind === 'invoice')
	if (!egs || !invoice) return null
	// The invoice as it was signed: its number never follows a later renumbering.
	const invoiceNumber = invoice.zatca?.invoiceNumber ?? invoiceId(order)
	const noteNumber = `${invoiceNumber}-CN${counter}`
	const input = fromRefund(
		{ amountCents: refund.amountCents, method: refund.method, reason },
		{
			taxRatePercent: order.taxRatePercent,
			totalCents: order.totals.totalCents,
			outOfScopeCents: outOfScopeCents(saleOf(order)),
		},
		{
			id: noteNumber,
			uuid: crypto.randomUUID(),
			issuedAt: new Date(refund.at),
			counter,
			previousHash: await nextPih(),
			seller: egs.seller,
			billingReference: {
				id: invoiceNumber,
				issueDate: riyadhDateTime(new Date(invoice.at)).date,
			},
		},
	)
	const signed = signDocument(input, egs.key, egs.certificateParsed)
	await db.meta.put({ key: PIH_KEY, value: signed.invoiceHash })
	return {
		invoiceNumber: noteNumber,
		uuid: signed.uuid,
		invoiceHash: signed.invoiceHash,
		xml: signed.xmlBase64,
		qr: signed.qr,
		totalCents: signed.totalCents,
		taxCents: signed.taxCents,
	}
}

const saleOf = (order: PosOrder) => ({
	lines: order.lines,
	taxRatePercent: order.taxRatePercent,
	taxInclusive: order.taxInclusive,
	totals: order.totals,
	payments: order.payments,
})

/** The invoice number signed into a sale's invoice: the order number on its business day, as it was then. */
export const invoiceId = (order: Pick<PosOrder, 'number' | 'businessDate'>) =>
	`${order.number}-${order.businessDate.replace(/-/g, '')}`

/**
 * Keeps the till's signing material in step with the server: fetched when the
 * terminal is an active unit, forgotten when it is not (removed or re-onboarded).
 */
export async function syncZatcaUnit(
	settings: PosSettings,
	status: { status: string; lastInvoiceHash?: string | null } | null,
): Promise<void> {
	if (!settings.tenantApiUrl || !settings.deviceToken) return
	// A till whose storage was lost continues the chain from the last document
	// the server holds for it, rather than starting again from the genesis PIH.
	if (status?.lastInvoiceHash && !(await db.meta.get(PIH_KEY))) {
		await db.meta.put({ key: PIH_KEY, value: status.lastInvoiceHash })
	}
	if (!status || status.status !== 'active') {
		await db.meta.delete(UNIT_KEY)
		return
	}
	try {
		const response = await fetch(
			`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/zatca`,
			{
				headers: { Authorization: `Bearer ${settings.deviceToken}` },
				signal: AbortSignal.timeout(8_000),
			},
		)
		if (response.status === 404) {
			await db.meta.delete(UNIT_KEY)
			return
		}
		if (!response.ok) return
		const body = (await response.json()) as ZatcaUnit
		if (!/^[0-9a-f]{64}$/.test(body.privateKeyHex) || !body.certificate) return
		await db.meta.put({ key: UNIT_KEY, value: body })
	} catch {
		/* keep what we have; try again at the next check-in */
	}
}

export async function zatcaUnit(): Promise<ZatcaUnit | null> {
	return ((await db.meta.get(UNIT_KEY))?.value as ZatcaUnit | undefined) ?? null
}
