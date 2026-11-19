/**
 * Guided Google Business Profile verification (#284). Nothing here runs
 * without the operator's click: the loader only reads Google's status and the
 * methods it offers; `requestVerification` and `submitVerificationCode` are
 * actions. The rules (14 days between postcards, name/address/category edits
 * held while a code is pending, state mapping) are pure and live in
 * `@repo/common/gbp-listing`.
 */
import {
	type VerificationOption,
	GbpError,
	canRequestPostcard,
	nextPostcardAt,
	verificationGuide,
} from '@repo/common/gbp-listing'
import { db, eq, GbpLocationSync } from '@repo/database'
import { type GbpClient, gbpClientFor } from '@repo/integrations'
import {
	type GbpContext,
	parseJson,
	recordGbpError,
	recordGbpEvent,
} from './context.server.ts'
import { enqueueGbpPush, pullLocation } from './sync.server.ts'

export type VerificationView = {
	guide: ReturnType<typeof verificationGuide>
	options: VerificationOption[]
	method: string | null
	destination: string | null
	requestedAt: string | null
	/** A second postcard may be requested from this time. */
	nextPostcardAt: string | null
	postcardAllowed: boolean
}

export function verificationView(
	sync: GbpContext['sync'],
	now: Date,
): VerificationView {
	const options = parseJson<VerificationOption[]>(sync.verificationOptions, [])
	const postcardAllowed =
		sync.verificationMethod !== 'ADDRESS' ||
		sync.verificationState !== 'pending'
			? canRequestPostcard(
					sync.verificationMethod === 'ADDRESS'
						? sync.verificationRequestedAt
						: null,
					now,
				)
			: false
	return {
		guide: verificationGuide({
			verificationState: sync.verificationState,
			connectionState: sync.state,
			options: sync.verificationState === 'unverified' ? options : null,
		}),
		options,
		method: sync.verificationMethod,
		destination: sync.verificationDestination,
		requestedAt: sync.verificationRequestedAt?.toISOString() ?? null,
		nextPostcardAt:
			sync.verificationMethod === 'ADDRESS'
				? (nextPostcardAt(sync.verificationRequestedAt)?.toISOString() ?? null)
				: null,
		postcardAllowed,
	}
}

/**
 * Reads Google's verification status and the methods on offer (and, when a
 * request is waiting for a code, which method and when). The daily sweep and
 * the Google tab call it; it changes nothing on Google.
 */
export async function refreshVerification(
	ctx: GbpContext,
	options: { client?: GbpClient; now?: Date } = {},
): Promise<void> {
	if (!ctx.integration?.isActive) return
	const now = options.now ?? new Date()
	try {
		const client = options.client ?? (await gbpClientFor(ctx.integration))
		const name = ctx.sync.googleLocationName
		const merchant = await client.getVoiceOfMerchantState(name)
		if (merchant.hasVoiceOfMerchant) {
			await db
				.update(GbpLocationSync)
				.set({
					verificationState: 'verified',
					state: merchant.suspended ? 'suspended' : 'ok',
					verificationCheckedAt: now,
				})
				.where(eq(GbpLocationSync.id, ctx.sync.id))
			return
		}
		const patch: Partial<typeof GbpLocationSync.$inferInsert> = {
			verificationCheckedAt: now,
			state: merchant.suspended
				? 'suspended'
				: !merchant.hasBusinessAuthority || merchant.ownershipConflict
					? 'access_lost'
					: 'not_verified',
		}
		if (merchant.hasPendingVerification) {
			const verifications = await client.listVerifications(name)
			const pending = verifications.find((entry) => entry.state === 'PENDING')
			patch.verificationState = 'pending'
			if (pending) {
				patch.verificationName = pending.name
				patch.verificationMethod = ctx.sync.verificationMethod ?? pending.method
			}
		} else {
			patch.verificationState = 'unverified'
			if (patch.state === 'not_verified') {
				const found = await client.fetchVerificationOptions(name, 'en')
				patch.verificationOptions = JSON.stringify(found)
			}
		}
		await db
			.update(GbpLocationSync)
			.set(patch)
			.where(eq(GbpLocationSync.id, ctx.sync.id))
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
	}
}

export type RequestVerificationResult =
	| { ok: true; method: string; destination: string | null }
	| {
			ok: false
			error:
				| 'not_linked'
				| 'already_verified'
				| 'method_not_offered'
				| 'postcard_too_soon'
				| 'not_available'
			nextAt?: string
	  }

/**
 * Asks Google to verify the profile with a method it offered. The destination
 * comes from Google's own options (never from the request), and a second
 * postcard is refused within 14 days.
 */
export async function requestVerification(input: {
	ctx: GbpContext
	method: string
	actorId: string
	client?: GbpClient
	now?: Date
}): Promise<RequestVerificationResult> {
	const { ctx } = input
	const now = input.now ?? new Date()
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_linked' }
	if (ctx.sync.verificationState === 'verified') {
		return { ok: false, error: 'already_verified' }
	}
	if (ctx.sync.state === 'suspended' || ctx.sync.state === 'access_lost') {
		return { ok: false, error: 'not_available' }
	}
	const client = input.client ?? (await gbpClientFor(ctx.integration))
	// Always the options Google offers right now, not a stale copy.
	const options = await client.fetchVerificationOptions(
		ctx.sync.googleLocationName,
		'en',
	)
	const chosen = options.find((option) => option.method === input.method)
	if (!chosen) return { ok: false, error: 'method_not_offered' }
	if (
		chosen.method === 'ADDRESS' &&
		ctx.sync.verificationMethod === 'ADDRESS' &&
		!canRequestPostcard(ctx.sync.verificationRequestedAt, now)
	) {
		return {
			ok: false,
			error: 'postcard_too_soon',
			nextAt: nextPostcardAt(ctx.sync.verificationRequestedAt)?.toISOString(),
		}
	}
	try {
		const record = await client.startVerification(ctx.sync.googleLocationName, {
			method: chosen.method,
			languageCode: 'en',
			destination: chosen.destination,
		})
		await db
			.update(GbpLocationSync)
			.set({
				verificationState: 'pending',
				verificationMethod: chosen.method,
				verificationDestination: chosen.destination,
				verificationName: record.name || null,
				verificationRequestedAt: now,
				verificationOptions: JSON.stringify(options),
				state: 'not_verified',
			})
			.where(eq(GbpLocationSync.id, ctx.sync.id))
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'verify',
			actorId: input.actorId,
			summary: `Verification requested by ${chosen.method.toLowerCase()}`,
			request: { method: chosen.method },
			result: 'accepted',
		})
		return { ok: true, method: chosen.method, destination: chosen.destination }
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'verify',
			actorId: input.actorId,
			summary: 'Google could not start the verification',
			result: 'failed',
			response: known.reason || known.code,
		})
		return { ok: false, error: 'not_available' }
	}
}

export type SubmitCodeResult =
	| { ok: true }
	| {
			ok: false
			error: 'wrong_code' | 'no_pending_request' | 'not_linked' | 'failed'
	  }

/**
 * Completes verification with the code. "I already have a code" works with no
 * request made in Menuza: the pending request is looked up at Google. On
 * success the profile is verified, the connection state clears and syncing is
 * unlocked (the outbox push runs).
 */
export async function submitVerificationCode(input: {
	ctx: GbpContext
	pin: string
	actorId: string
	client?: GbpClient
	now?: Date
}): Promise<SubmitCodeResult> {
	const { ctx } = input
	const now = input.now ?? new Date()
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_linked' }
	const pin = input.pin.trim()
	const client = input.client ?? (await gbpClientFor(ctx.integration))
	let verificationName = ctx.sync.verificationName
	if (!verificationName) {
		const pending = (
			await client.listVerifications(ctx.sync.googleLocationName)
		).find((entry) => entry.state === 'PENDING')
		verificationName = pending?.name ?? null
	}
	if (!verificationName) return { ok: false, error: 'no_pending_request' }
	try {
		await client.completeVerification(verificationName, pin)
	} catch (error) {
		if (error instanceof GbpError && error.code === 'gbp_rejected') {
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'verify',
				actorId: input.actorId,
				summary: 'Verification code was not accepted',
				result: 'rejected',
				response: error.reason || error.code,
			})
			return { ok: false, error: 'wrong_code' }
		}
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		return { ok: false, error: 'failed' }
	}
	await db
		.update(GbpLocationSync)
		.set({
			verificationState: 'verified',
			state: 'ok',
			lastError: null,
			verificationCheckedAt: now,
			pushRequestedAt: now,
		})
		.where(eq(GbpLocationSync.id, ctx.sync.id))
	await recordGbpEvent({
		sync: ctx.sync,
		kind: 'verify',
		actorId: input.actorId,
		summary: 'Profile verified',
		result: 'accepted',
	})
	// Syncing is unlocked: read the profile and send what was waiting.
	await pullLocation({
		organizationId: ctx.sync.organizationId,
		organizationLocationId: ctx.sync.organizationLocationId,
		now,
	}).catch(() => null)
	await enqueueGbpPush({
		organizationId: ctx.sync.organizationId,
		organizationLocationId: ctx.sync.organizationLocationId,
		actorId: input.actorId,
	})
	return { ok: true }
}
