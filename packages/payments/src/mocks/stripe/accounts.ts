import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import { type Json } from '../util'
import { invalidRequest, missingParam } from './errors'
import { ANY, metadataParam, rejectUnknownParams, stringParam } from './params'
import {
	emitStripeEvent,
	insertStripeObject,
	mutateStripeObject,
	publicObject,
	requireStripeObject,
	seconds,
} from './state'

export type OnboardingOutcome =
	'complete' | 'requirements_due' | 'payouts_restricted'

const ACCOUNT_PARAMS = {
	type: true,
	country: true,
	email: true,
	business_type: true,
	capabilities: {
		card_payments: { requested: true },
		transfers: { requested: true },
	},
	metadata: ANY,
} as const

export async function createAccount(ctx: EmulatorContext, params: Json) {
	rejectUnknownParams(params, ACCOUNT_PARAMS)
	const type = stringParam(params.type, 'type') ?? 'express'
	if (!['express', 'custom', 'standard'].includes(type)) {
		throw invalidRequest(`Invalid account type: ${type}`, {
			code: 'parameter_invalid_enum',
			param: 'type',
		})
	}
	const account = {
		id: stripeId('acct_', 16),
		object: 'account',
		type,
		country: stringParam(params.country, 'country') ?? 'US',
		email: stringParam(params.email, 'email') ?? null,
		business_type: stringParam(params.business_type, 'business_type') ?? null,
		default_currency: 'usd',
		created: seconds(ctx.clock.now()),
		charges_enabled: false,
		payouts_enabled: false,
		details_submitted: false,
		capabilities: {
			card_payments: 'inactive',
			transfers: 'inactive',
		},
		requirements: {
			currently_due: [
				'external_account',
				'business_profile.url',
				'representative.verification.document',
			],
			past_due: [],
			disabled_reason: 'requirements.past_due',
		},
		metadata: metadataParam(params.metadata),
	}
	await insertStripeObject(ctx, 'account', account)
	return account
}

export async function retrieveAccount(ctx: EmulatorContext, id: string) {
	const row = await requireStripeObject(ctx, id, 'account', 'account')
	return publicObject(row.json)
}

export async function createAccountLink(ctx: EmulatorContext, params: Json) {
	rejectUnknownParams(params, {
		account: true,
		refresh_url: true,
		return_url: true,
		type: true,
		collect: true,
	})
	const accountId = stringParam(params.account, 'account')
	if (!accountId) throw missingParam('account')
	const type = stringParam(params.type, 'type')
	if (!type) throw missingParam('type')
	if (type !== 'account_onboarding' && type !== 'account_update') {
		throw invalidRequest(`Invalid type: ${type}`, {
			code: 'parameter_invalid_enum',
			param: 'type',
		})
	}
	for (const field of ['return_url', 'refresh_url'] as const) {
		const value = stringParam(params[field], field)
		if (!value) throw missingParam(field)
		if (!/^https?:\/\//.test(value)) {
			throw invalidRequest(`Not a valid URL`, {
				code: 'url_invalid',
				param: field,
			})
		}
	}
	await requireStripeObject(ctx, accountId, 'account', 'account', 'account')
	const id = stripeId('alink_', 20)
	const now = ctx.clock.now()
	await insertStripeObject(
		ctx,
		'account_link',
		{
			id,
			object: 'account_link',
			account: accountId,
			created: seconds(now),
			expires_at: seconds(now) + 300,
			url: `${ctx.origin}/mock-payments/stripe/connect/onboard/${id}`,
			return_url: params.return_url,
			refresh_url: params.refresh_url,
		},
		{ parentId: accountId },
	)
	return {
		object: 'account_link',
		created: seconds(now),
		expires_at: seconds(now) + 300,
		url: `${ctx.origin}/mock-payments/stripe/connect/onboard/${id}`,
	}
}

export async function createLoginLink(ctx: EmulatorContext, accountId: string) {
	const row = await requireStripeObject(ctx, accountId, 'account', 'account')
	if (row.json.type !== 'express') {
		throw invalidRequest(
			'You can only create login links for connected accounts that have access to the Express Dashboard.',
		)
	}
	if (!row.json.details_submitted) {
		throw invalidRequest(
			'Cannot create a login link for an account that has not completed onboarding.',
		)
	}
	return {
		object: 'login_link',
		created: seconds(ctx.clock.now()),
		url: `${ctx.origin}/mock-payments/stripe/connect/dashboard/${accountId}`,
	}
}

/** What the hosted onboarding page does; also used by the dev helpers. */
export async function completeAccountOnboarding(
	ctx: EmulatorContext,
	accountId: string,
	outcome: OnboardingOutcome,
) {
	await requireStripeObject(ctx, accountId, 'account', 'account')
	const { row } = await mutateStripeObject(ctx, accountId, (json) => {
		json.details_submitted = true
		if (outcome === 'complete') {
			json.charges_enabled = true
			json.payouts_enabled = true
			json.capabilities = { card_payments: 'active', transfers: 'active' }
			json.requirements = {
				currently_due: [],
				past_due: [],
				disabled_reason: null,
			}
		} else if (outcome === 'payouts_restricted') {
			json.charges_enabled = true
			json.payouts_enabled = false
			json.capabilities = { card_payments: 'active', transfers: 'active' }
			json.requirements = {
				currently_due: ['external_account'],
				past_due: [],
				disabled_reason: null,
			}
		} else {
			json.charges_enabled = false
			json.payouts_enabled = false
			json.capabilities = { card_payments: 'pending', transfers: 'pending' }
			json.requirements = {
				currently_due: ['individual.verification.document'],
				past_due: [],
				disabled_reason: 'requirements.pending_verification',
			}
		}
	})
	await emitStripeEvent(ctx, 'account.updated', row.json, {
		account: accountId,
	})
	return publicObject(row.json)
}
