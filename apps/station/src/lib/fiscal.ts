import {
	issuePosFiscalDocument,
	newPosFiscalChain,
	posRefundTaxCents,
	type PosFiscalChainHead,
} from '@repo/common/pos-fiscal'
import { db, type FiscalDocument, type PosOrder, type Refund } from './db.ts'
import { signCreditNote, signInvoice } from './zatca.ts'

/**
 * This till's fiscal chain (see `@repo/common/pos-fiscal`): every closed sale
 * gets an invoice and every refund a credit note, numbered without gaps and
 * hash-linked to the one before. The head lives in IndexedDB beside the orders
 * and is advanced in the same transaction that closes the sale, so a document
 * can never be issued without being stored, or stored twice.
 */

const HEAD_KEY = 'fiscal:head'

/** Reads the chain head, starting a chain for this installation if there is none. Call inside a transaction that includes `db.meta`. */
async function readHead(): Promise<PosFiscalChainHead> {
	const row = await db.meta.get(HEAD_KEY)
	return (
		(row?.value as PosFiscalChainHead | undefined) ??
		newPosFiscalChain(crypto.randomUUID())
	)
}

export async function fiscalHead(): Promise<PosFiscalChainHead> {
	return readHead()
}

/**
 * Takes up the server's copy of the chain when this till has issued nothing
 * itself (its storage was wiped), so numbering continues instead of restarting.
 * A chain that already has documents here is never replaced.
 */
export async function adoptServerChain(
	heads: PosFiscalChainHead[],
): Promise<boolean> {
	return db.transaction('rw', db.meta, async () => {
		const local = await db.meta.get(HEAD_KEY)
		const current = local?.value as PosFiscalChainHead | undefined
		if (current && current.counter > 0) {
			const mine = heads.find((h) => h.chainId === current.chainId)
			if (!mine || mine.counter <= current.counter) return false
			await db.meta.put({ key: HEAD_KEY, value: mine })
			return true
		}
		const latest = heads[0]
		if (!latest) return false
		await db.meta.put({ key: HEAD_KEY, value: latest })
		return true
	})
}

/**
 * Issues the invoice for a sale that just closed, and signs it for ZATCA when
 * this till is an onboarded unit. Must run inside a transaction over `db.meta`.
 */
export async function issueInvoice(
	order: PosOrder,
	now: number,
): Promise<FiscalDocument> {
	const { document, head } = issuePosFiscalDocument(await readHead(), {
		kind: 'invoice',
		docId: order.id,
		orderId: order.id,
		at: new Date(now).toISOString(),
		currency: order.currency,
		totalCents: order.totals.totalCents,
		taxCents: order.totals.taxCents,
	})
	await db.meta.put({ key: HEAD_KEY, value: head })
	return { ...document, zatca: await signInvoice(order, document.counter, now) }
}

/** Words ZATCA shows for why a credit note was issued. */
const REFUND_REASON: Record<Refund['reason'], string> = {
	mistake: 'Rung up by mistake',
	guest_request: 'Customer request',
	out_of_stock: 'Item not available',
	quality: 'Quality issue',
	wrong_charge: 'Wrong amount charged',
	other: 'Refund',
}

/** Issues the credit note for one refund (signed for ZATCA when onboarded). Must run inside a transaction over `db.meta`. */
export async function issueCreditNote(
	order: PosOrder,
	refund: Refund,
): Promise<FiscalDocument> {
	const { document, head } = issuePosFiscalDocument(await readHead(), {
		kind: 'credit_note',
		docId: refund.id,
		orderId: order.id,
		at: new Date(refund.at).toISOString(),
		currency: order.currency,
		totalCents: refund.amountCents,
		taxCents: posRefundTaxCents(order.totals, refund.amountCents),
	})
	await db.meta.put({ key: HEAD_KEY, value: head })
	return {
		...document,
		zatca: await signCreditNote(
			order,
			refund,
			document.counter,
			REFUND_REASON[refund.reason],
		),
	}
}
