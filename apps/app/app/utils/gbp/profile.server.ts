/**
 * Description, opening date and attributes of the Google profile (#209).
 *
 *  - Derived attributes (delivery, takeout, curbside, dine-in, reservations)
 *    come from Menuza's settings and update by themselves while "Keep Google
 *    in sync" is on (`syncDerivedAttributes`).
 *  - Hand-set values (the description, the opening date, any attribute the
 *    operator sets) are stored in `GoogleProfileField` and never change by
 *    themselves. Each shows Google's answer: saved, pending review, or
 *    rejected with Google's reason; a rejected change is not retried until the
 *    value changes.
 */
import {
	type AttributeSuggestion,
	type AttributeGroup,
	type GoogleAttributeMeta,
	GBP_DESCRIPTION_MAX,
	GbpError,
	attributeGroup,
	deriveAttributes,
	descriptionProblems,
	suggestAttributeChanges,
} from '@repo/common/gbp-listing'
import { type FulfillmentOptions } from '@repo/common/location-types'
import { and, db, eq, GoogleProfileField, Organization } from '@repo/database'
import {
	type AttributeValues,
	type GbpClient,
	type GbpListing,
	gbpClientFor,
} from '@repo/integrations'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import {
	type GbpContext,
	gbpFlags,
	parseJson,
	recordGbpError,
	recordGbpEvent,
} from './context.server.ts'

export const DESCRIPTION_KEY = 'description'
export const OPENING_DATE_KEY = 'openingDate'
export const attributeKey = (name: string) => `attr:${name}`

export type ProfileFieldRow = typeof GoogleProfileField.$inferSelect

export async function loadProfileFields(locationId: string) {
	return db
		.select()
		.from(GoogleProfileField)
		.where(eq(GoogleProfileField.organizationLocationId, locationId))
}

/** Menuza's own answers for the derived attributes. */
export async function derivedAttributeValues(ctx: GbpContext) {
	const [organization] = await db
		.select({
			stripe: Organization.stripeConnectChargesEnabled,
			checkout: Organization.checkoutChargesEnabled,
		})
		.from(Organization)
		.where(eq(Organization.id, ctx.organization.id))
		.limit(1)
	return deriveAttributes({
		fulfillment: parseJson<Partial<FulfillmentOptions> | null>(
			ctx.location.fulfillmentOptions,
			null,
		),
		reservationsEnabled: await isReservationsFeatureEnabled(
			ctx.organization.id,
			'enabled',
		),
		onlinePaymentsConnected: Boolean(
			organization?.stripe || organization?.checkout,
		),
	})
}

export type ProfileAttributeView = {
	name: string
	displayName: string
	group: AttributeGroup
	/** What Google shows (null: not set). */
	google: boolean | null
	/** Hand-set by the operator (never changes by itself), else derived. */
	source: 'hand' | 'derived' | 'none'
	value: boolean | null
	status: 'saved' | 'pending' | 'rejected' | null
	reason: string | null
}

export type ProfileView = {
	available: boolean
	error: string | null
	description: { value: string; status: string | null; reason: string | null }
	openingDate: string | null
	attributes: ProfileAttributeView[]
	suggestions: AttributeSuggestion[]
	descriptionMax: number
}

function openingDateText(
	date: { year: number; month: number; day: number } | undefined,
) {
	if (!date) return null
	return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

/** What the Google tab's profile form shows. */
export async function loadProfileView(
	ctx: GbpContext,
	options: { client?: GbpClient } = {},
): Promise<ProfileView> {
	const fields = await loadProfileFields(ctx.location.id)
	const byKey = new Map(fields.map((row) => [row.key, row]))
	const descriptionRow = byKey.get(DESCRIPTION_KEY)
	const empty: ProfileView = {
		available: false,
		error: null,
		description: {
			value: descriptionRow ? (JSON.parse(descriptionRow.value) as string) : '',
			status: descriptionRow?.status ?? null,
			reason: descriptionRow?.reason ?? null,
		},
		openingDate: null,
		attributes: [],
		suggestions: [],
		descriptionMax: GBP_DESCRIPTION_MAX,
	}
	if (!ctx.integration?.isActive) return empty
	try {
		const client = options.client ?? (await gbpClientFor(ctx.integration))
		const name = ctx.sync.googleLocationName
		const [listing, meta, googleAttributes, derived] = await Promise.all([
			client.getListing(name),
			client.listAttributeMetadata(name),
			client.getAttributes(name),
			derivedAttributeValues(ctx),
		])
		const available = meta.filter(
			(item) => !item.deprecated && item.valueType === 'BOOL',
		)
		const attributes: ProfileAttributeView[] = available.map((item) => {
			const row = byKey.get(attributeKey(item.name))
			const google =
				typeof googleAttributes[item.name] === 'boolean'
					? (googleAttributes[item.name] as boolean)
					: null
			const hand = row?.source === 'hand'
			const derivedValue = derived[item.name as keyof typeof derived]
			return {
				name: item.name,
				displayName: item.displayName,
				group: attributeGroup(item.name),
				google,
				source: hand ? 'hand' : derivedValue !== undefined ? 'derived' : 'none',
				value: hand
					? (JSON.parse(row!.value) as boolean)
					: derivedValue !== undefined
						? derivedValue
						: google,
				status: (row?.status as ProfileAttributeView['status']) ?? null,
				reason: row?.reason ?? null,
			}
		})
		const googleBooleans: Record<string, boolean | null> = {}
		for (const item of available) {
			googleBooleans[item.name] =
				typeof googleAttributes[item.name] === 'boolean'
					? (googleAttributes[item.name] as boolean)
					: null
		}
		const handNames = new Set(
			fields
				.filter((row) => row.key.startsWith('attr:') && row.source === 'hand')
				.map((row) => row.key.slice('attr:'.length)),
		)
		return {
			available: true,
			error: null,
			description: {
				value: descriptionRow
					? (JSON.parse(descriptionRow.value) as string)
					: (listing.profile?.description ?? ''),
				status: descriptionRow?.status ?? null,
				reason: descriptionRow?.reason ?? null,
			},
			openingDate: openingDateText(listing.openInfo?.openingDate),
			attributes,
			// Derived attributes only: hand-set ones never get suggestions.
			suggestions: suggestAttributeChanges(
				Object.fromEntries(
					Object.entries(derived).filter(([key]) => !handNames.has(key)),
				),
				googleBooleans,
				available as GoogleAttributeMeta[],
			),
			descriptionMax: GBP_DESCRIPTION_MAX,
		}
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		return { ...empty, error: known.code }
	}
}

async function upsertField(
	ctx: GbpContext,
	input: {
		key: string
		value: unknown
		source: 'hand' | 'derived'
		status: 'saved' | 'pending' | 'rejected'
		reason?: string | null
		actorId?: string | null
	},
) {
	const values = {
		value: JSON.stringify(input.value),
		source: input.source,
		status: input.status,
		reason: input.reason ?? null,
		pendingSince: input.status === 'pending' ? new Date() : null,
		updatedById: input.actorId ?? null,
	}
	await db
		.insert(GoogleProfileField)
		.values({
			organizationId: ctx.organization.id,
			organizationLocationId: ctx.location.id,
			key: input.key,
			...values,
		})
		.onConflictDoUpdate({
			target: [
				GoogleProfileField.organizationLocationId,
				GoogleProfileField.key,
			],
			set: values,
		})
}

export type SaveProfileInput = {
	ctx: GbpContext
	actorId: string
	/** `undefined` leaves the description alone. */
	description?: string
	/** `YYYY-MM-DD`, empty to leave alone. */
	openingDate?: string
	/** Hand-set attributes: `true`/`false` to set, `null` to hand control back. */
	attributes?: Record<string, boolean | null>
	client?: GbpClient
}

export type SaveProfileResult =
	| {
			ok: true
			outcomes: Array<{
				key: string
				status: 'saved' | 'pending' | 'rejected'
				reason?: string
			}>
	  }
	| {
			ok: false
			error:
				| 'flags_off'
				| 'not_ready'
				| 'invalid_description'
				| 'invalid_date'
				| 'not_linked'
			problems?: string[]
	  }

/**
 * Saves the hand-set profile fields and sends them to Google. Each value is
 * stored with Google's answer; a refusal keeps the value and Google's reason
 * so the operator can fix it (it is not retried by itself).
 */
export async function saveProfile(
	input: SaveProfileInput,
): Promise<SaveProfileResult> {
	const { ctx } = input
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_linked' }
	const flags = await gbpFlags(ctx.organization.id)
	if (!flags.sync || !flags.write) return { ok: false, error: 'flags_off' }
	if (ctx.sync.state !== 'ok' || ctx.sync.verificationState !== 'verified') {
		return { ok: false, error: 'not_ready' }
	}
	if (input.description !== undefined) {
		const problems = descriptionProblems(input.description)
		if (problems.length > 0) {
			return { ok: false, error: 'invalid_description', problems }
		}
	}
	if (input.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.openingDate)) {
		return { ok: false, error: 'invalid_date' }
	}

	const client = input.client ?? (await gbpClientFor(ctx.integration))
	const name = ctx.sync.googleLocationName
	const outcomes: Array<{
		key: string
		status: 'saved' | 'pending' | 'rejected'
		reason?: string
	}> = []

	// Description and opening date go in one listing patch.
	const masks: string[] = []
	const body: Partial<GbpListing> = {}
	if (input.description !== undefined) {
		masks.push('profile.description')
		body.profile = { description: input.description.trim() }
	}
	if (input.openingDate) {
		const [year, month, day] = input.openingDate.split('-').map(Number)
		masks.push('openInfo.openingDate')
		body.openInfo = { openingDate: { year: year!, month: month!, day: day! } }
	}
	if (masks.length > 0) {
		const keys = [
			...(input.description !== undefined ? [DESCRIPTION_KEY] : []),
			...(input.openingDate ? [OPENING_DATE_KEY] : []),
		]
		const values: Record<string, unknown> = {
			[DESCRIPTION_KEY]: input.description?.trim() ?? '',
			[OPENING_DATE_KEY]: input.openingDate ?? '',
		}
		try {
			const outcome = await client.patchListing(name, masks.join(','), body)
			const status = outcome.status === 'pending' ? 'pending' : 'saved'
			for (const key of keys) {
				await upsertField(ctx, {
					key,
					value: values[key],
					source: 'hand',
					status,
					actorId: input.actorId,
				})
				outcomes.push({ key, status })
			}
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'attributes',
				field: 'profile',
				actorId: input.actorId,
				summary:
					status === 'pending'
						? 'Profile text sent; Google is reviewing it'
						: 'Profile text updated on Google',
				request: { updateMask: masks.join(','), body },
				result: status === 'pending' ? 'pending_google' : 'accepted',
			})
		} catch (error) {
			if (error instanceof GbpError && error.code === 'gbp_rejected') {
				const reason = error.reason || 'Google refused this change.'
				for (const key of keys) {
					await upsertField(ctx, {
						key,
						value: values[key],
						source: 'hand',
						status: 'rejected',
						reason,
						actorId: input.actorId,
					})
					outcomes.push({ key, status: 'rejected', reason })
				}
				await recordGbpEvent({
					sync: ctx.sync,
					kind: 'attributes',
					field: 'profile',
					actorId: input.actorId,
					summary: 'Google refused the profile text',
					request: { updateMask: masks.join(','), body },
					result: 'rejected',
					response: reason,
				})
			} else {
				const known = await recordGbpError(ctx, error)
				if (!known) throw error
				return { ok: false, error: 'not_ready' }
			}
		}
	}

	// Hand-set attributes, in one call; `null` hands the attribute back to
	// the derived value without touching Google.
	const handSet: AttributeValues = {}
	for (const [attribute, value] of Object.entries(input.attributes ?? {})) {
		if (value === null) {
			await db
				.delete(GoogleProfileField)
				.where(
					and(
						eq(GoogleProfileField.organizationLocationId, ctx.location.id),
						eq(GoogleProfileField.key, attributeKey(attribute)),
					),
				)
		} else {
			handSet[attribute] = value
		}
	}
	if (Object.keys(handSet).length > 0) {
		try {
			const outcome = await client.updateAttributes(name, handSet)
			const status = outcome.status === 'pending' ? 'pending' : 'saved'
			for (const [attribute, value] of Object.entries(handSet)) {
				await upsertField(ctx, {
					key: attributeKey(attribute),
					value,
					source: 'hand',
					status,
					actorId: input.actorId,
				})
				outcomes.push({ key: attributeKey(attribute), status })
			}
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'attributes',
				field: 'attributes',
				actorId: input.actorId,
				summary: 'Attributes updated on Google',
				request: { attributes: handSet },
				result: status === 'pending' ? 'pending_google' : 'accepted',
			})
		} catch (error) {
			if (error instanceof GbpError && error.code === 'gbp_rejected') {
				const reason = error.reason || 'Google refused this change.'
				for (const [attribute, value] of Object.entries(handSet)) {
					await upsertField(ctx, {
						key: attributeKey(attribute),
						value,
						source: 'hand',
						status: 'rejected',
						reason,
						actorId: input.actorId,
					})
					outcomes.push({
						key: attributeKey(attribute),
						status: 'rejected',
						reason,
					})
				}
				await recordGbpEvent({
					sync: ctx.sync,
					kind: 'attributes',
					field: 'attributes',
					actorId: input.actorId,
					summary: 'Google refused the attributes',
					request: { attributes: handSet },
					result: 'rejected',
					response: reason,
				})
			} else {
				const known = await recordGbpError(ctx, error)
				if (!known) throw error
				return { ok: false, error: 'not_ready' }
			}
		}
	}
	return { ok: true, outcomes }
}

/**
 * Sends the derived attributes that differ from what Google shows. Hand-set
 * attributes are skipped, and so is one Google refused for the same value.
 * Called by the sync push when `attributes` is an opted-in field.
 */
export async function syncDerivedAttributes(
	ctx: GbpContext,
	options: { actorId: string | null; client?: GbpClient },
): Promise<{ sent: string[]; skipped: string[] }> {
	if (!ctx.integration?.isActive) return { sent: [], skipped: [] }
	const client = options.client ?? (await gbpClientFor(ctx.integration))
	const name = ctx.sync.googleLocationName
	const [meta, google, derived, fields] = await Promise.all([
		client.listAttributeMetadata(name),
		client.getAttributes(name),
		derivedAttributeValues(ctx),
		loadProfileFields(ctx.location.id),
	])
	const byKey = new Map(fields.map((row) => [row.key, row]))
	const offered = new Set(
		meta
			.filter((item) => !item.deprecated && item.valueType === 'BOOL')
			.map((item) => item.name),
	)
	const updates: AttributeValues = {}
	const skipped: string[] = []
	for (const [attribute, value] of Object.entries(derived)) {
		if (!offered.has(attribute)) continue
		const row = byKey.get(attributeKey(attribute))
		if (row?.source === 'hand') {
			skipped.push(attribute)
			continue
		}
		if (row?.status === 'rejected' && JSON.parse(row.value) === value) {
			skipped.push(attribute)
			continue
		}
		if (google[attribute] === value) continue
		updates[attribute] = value
	}
	if (Object.keys(updates).length === 0) return { sent: [], skipped }
	try {
		const outcome = await client.updateAttributes(name, updates)
		const status = outcome.status === 'pending' ? 'pending' : 'saved'
		for (const [attribute, value] of Object.entries(updates)) {
			await upsertField(ctx, {
				key: attributeKey(attribute),
				value,
				source: 'derived',
				status,
				actorId: options.actorId,
			})
		}
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'attributes',
			field: 'attributes',
			actorId: options.actorId,
			summary: 'Service options updated on Google',
			request: { attributes: updates },
			result: status === 'pending' ? 'pending_google' : 'accepted',
		})
		return { sent: Object.keys(updates), skipped }
	} catch (error) {
		if (error instanceof GbpError && error.code === 'gbp_rejected') {
			const reason = error.reason || 'Google refused this change.'
			for (const [attribute, value] of Object.entries(updates)) {
				await upsertField(ctx, {
					key: attributeKey(attribute),
					value,
					source: 'derived',
					status: 'rejected',
					reason,
					actorId: options.actorId,
				})
			}
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'attributes',
				field: 'attributes',
				actorId: options.actorId,
				summary: 'Google refused the service options',
				request: { attributes: updates },
				result: 'rejected',
				response: reason,
			})
			return { sent: [], skipped }
		}
		throw error
	}
}

/**
 * Settles pending profile fields after Google reviewed them: the value Google
 * now shows decides saved or rejected. Called from the pull.
 */
export async function reconcileProfileFields(
	ctx: GbpContext,
	listing: GbpListing,
	pendingMask: ReadonlySet<string>,
) {
	const fields = await loadProfileFields(ctx.location.id)
	for (const row of fields) {
		if (row.status !== 'pending') continue
		if (row.key === DESCRIPTION_KEY) {
			if (pendingMask.has('profile.description') || pendingMask.has('profile'))
				continue
			const shown = listing.profile?.description ?? ''
			const mine = JSON.parse(row.value) as string
			await db
				.update(GoogleProfileField)
				.set(
					shown.trim() === mine.trim()
						? { status: 'saved', reason: null, pendingSince: null }
						: {
								status: 'rejected',
								reason: 'Google did not accept this change.',
								pendingSince: null,
							},
				)
				.where(eq(GoogleProfileField.id, row.id))
		}
	}
}

// ---------------------------------------------------------------------------
// Draft with AI
// ---------------------------------------------------------------------------

export type DescriptionGenerator = (input: {
	system: string
	prompt: string
}) => Promise<string>

/**
 * A draft description from the restaurant's own public profile (name, cuisine,
 * city) through the existing `@repo/ai` path. No guest data goes into the
 * prompt. The result is cleaned to Google's rules and only ever filled into
 * the form; the operator saves it.
 */
export async function draftDescription(
	ctx: GbpContext,
	generate: DescriptionGenerator,
): Promise<string> {
	const address = parseJson<{ city?: string; state?: string } | null>(
		ctx.location.address,
		null,
	)
	const prompt = [
		`Restaurant: ${ctx.organization.name}`,
		`Location: ${ctx.location.name}`,
		address?.city ? `City: ${address.city}` : '',
	]
		.filter(Boolean)
		.join('\n')
	const text = await generate({
		system:
			`Write a Google Business Profile description for a restaurant in at most ${GBP_DESCRIPTION_MAX - 50} characters. ` +
			'Plain sentences, no web addresses, no phone numbers, no emoji, no promotions or prices.',
		prompt,
	})
	return text
		.replace(/(https?:\/\/|www\.)\S+/gi, '')
		.replace(/\+?\d[\d\s().-]{6,}\d/g, '')
		.trim()
		.slice(0, GBP_DESCRIPTION_MAX)
}
