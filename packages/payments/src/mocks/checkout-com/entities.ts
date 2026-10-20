import { type EmulatorContext } from '../context'
import { checkoutId } from '../ids'
import { isRecord, type Json } from '../util'
import { invalidRequest, notFound } from './errors'
import {
	CHECKOUT_LINK_HOST,
	findCheckoutObject,
	insertCheckoutObject,
	isoNow,
	mutateCheckoutObject,
	publicObject,
} from './state'

function entityBody(json: Json) {
	return {
		id: json.id,
		reference: json.reference,
		status: json.status,
		capabilities: json.capabilities,
		contact_details: json.contact_details,
		_links: {
			self: { href: `${CHECKOUT_LINK_HOST}/accounts/entities/${json.id}` },
		},
	}
}

/** `POST /accounts/entities`: the sub-entity invite (starts not activated). */
export async function createEntity(ctx: EmulatorContext, body: unknown) {
	const input = isRecord(body) ? body : {}
	const codes: string[] = []
	if (typeof input.reference !== 'string' || input.reference.trim() === '') {
		codes.push('reference_required')
	}
	const email = input.contact_details?.invitee?.email
	if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) {
		codes.push('contact_details_invitee_email_invalid')
	}
	if (codes.length > 0) throw invalidRequest(...codes)
	const entity = {
		id: checkoutId('ent_'),
		reference: input.reference,
		status: input.is_draft === false ? 'pending' : 'draft',
		capabilities: {
			payments: { enabled: false },
			payouts: { enabled: false },
		},
		contact_details: input.contact_details,
		created_on: isoNow(ctx),
	}
	await insertCheckoutObject(ctx, 'entity', entity)
	return entityBody(entity)
}

export async function retrieveEntity(ctx: EmulatorContext, id: string) {
	const row = await findCheckoutObject(ctx, id, 'entity')
	if (!row) throw notFound()
	return entityBody(row.json)
}

/** What the mock dashboard's Activate buttons do. */
export async function activateEntity(
	ctx: EmulatorContext,
	id: string,
	capabilities: { payments?: boolean; payouts?: boolean },
) {
	const row = await findCheckoutObject(ctx, id, 'entity')
	if (!row) throw notFound()
	const { row: updated } = await mutateCheckoutObject(ctx, id, (json) => {
		if (capabilities.payments !== undefined) {
			json.capabilities.payments.enabled = capabilities.payments
		}
		if (capabilities.payouts !== undefined) {
			json.capabilities.payouts.enabled = capabilities.payouts
		}
		json.status =
			json.capabilities.payments.enabled || json.capabilities.payouts.enabled
				? 'active'
				: 'pending'
	})
	return publicObject(updated.json)
}
