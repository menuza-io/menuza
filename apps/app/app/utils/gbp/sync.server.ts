/**
 * Keeping Google Business Profile in sync (#87).
 *
 *  - `pushLocationToGoogle` sends what Menuza wants Google to show. Fields are
 *    batched into one `locations.patch` with the right `updateMask`; a value
 *    already sent is not sent again, and the same field is not retried within
 *    an hour (`shouldPushField`).
 *  - `enqueueGbpPush` is what a save calls: it marks the location in the outbox
 *    (`pushRequestedAt`) and tries to push at once, but never throws and never
 *    blocks the save; the hourly sweep finishes what could not go out.
 *  - `pullLocation` reads Google, refreshes the connection state, resolves
 *    pending changes and turns every difference into a Needs attention item
 *    (`GbpListingIssue`). Menuza is never overwritten silently.
 *  - `resolveIssue` applies the operator's choice: Use Menuza's value, Use
 *    Google's value, or Ignore.
 *
 * Every Google call goes through `GbpClient` (`@repo/integrations`), which a
 * test replaces. Flags `gbp.sync` and `gbp.write` default off.
 */
import {
	type GoogleSpecialHourPeriod,
	diffSpecialHours,
	diffWeeklyHours,
	fingerprint,
	googleSpecialToMenuza,
	isoFromGoogleDate,
	localDateIso,
	phonesEqual,
	weeklyHoursEqual,
} from '@repo/common/gbp-hours'
import {
	type FieldState,
	type GbpExplicitField,
	type GbpSyncField,
	GBP_EXPLICIT_FIELDS,
	GBP_SYNC_FIELDS,
	GBP_UPDATE_MASK,
	GbpError,
	connectionStateForError,
	heldFieldsWhilePending,
	parseFieldState,
	parseFieldsSynced,
	shouldPushField,
} from '@repo/common/gbp-listing'
import { type LocationAddress } from '@repo/common/location-types'
import {
	and,
	asc,
	db,
	eq,
	getLockedLocationSettingIds,
	GbpListingIssue,
	GbpLocationSync,
	inArray,
	OrganizationLocation,
} from '@repo/database'
import {
	type GbpClient,
	type GbpListing,
	gbpClientFor,
	googleAddressToMenuza,
	googleBusinessSchedule,
} from '@repo/integrations'
import {
	type GbpContext,
	addressToGoogle,
	desiredListing,
	gbpFlags,
	loadGbpContext,
	parseJson,
	recordGbpError,
	recordGbpEvent,
	saveSync,
} from './context.server.ts'
import { syncSiteLinks } from './order-links.server.ts'
import {
	derivedAttributeValues,
	reconcileProfileFields,
	syncDerivedAttributes,
} from './profile.server.ts'

/** Fields a push can carry in the one listing patch. */
type ListingField = Exclude<GbpSyncField, 'links'> | GbpExplicitField

export type PushFieldResult = {
	field: string
	status: 'sent' | 'pending_google' | 'rejected' | 'failed' | 'skipped'
	reason?: string
}

export type PushResult = {
	results: PushFieldResult[]
	/** Fields held back because a verification code is pending. */
	held: GbpExplicitField[]
	/** The push did not run: flags off, not linked, not verified. */
	blocked: 'flags_off' | 'not_linked' | 'sync_off' | 'not_ready' | null
}

type FieldPlan = {
	field: ListingField
	mask: string
	body: Partial<GbpListing>
	value: unknown
	label: string
}

function isListingField(field: string): field is ListingField {
	if (field === 'links' || field === 'categories') return false
	return (
		(GBP_SYNC_FIELDS as readonly string[]).includes(field) ||
		(GBP_EXPLICIT_FIELDS as readonly string[]).includes(field)
	)
}

/**
 * The listing patch for each requested field, from what Menuza wants Google
 * to show. A field with nothing to send (no hours set, no phone) is left out
 * rather than clearing the Google value.
 */
function planFields(
	ctx: GbpContext,
	fields: readonly ListingField[],
	now: Date,
	options: { includeEmptySpecial: boolean },
): FieldPlan[] {
	const desired = desiredListing(ctx, now)
	const plans: FieldPlan[] = []
	for (const field of fields) {
		switch (field) {
			case 'hours':
				if (!desired.storeHours || desired.hoursPeriods.length === 0) break
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.hours,
					body: { regularHours: { periods: desired.hoursPeriods } },
					value: desired.hoursPeriods,
					label: 'Opening hours',
				})
				break
			case 'specialHours':
				if (
					desired.specialPeriods.length === 0 &&
					!options.includeEmptySpecial
				) {
					break
				}
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.specialHours,
					body: {
						specialHours: { specialHourPeriods: desired.specialPeriods },
					},
					value: desired.specialPeriods,
					label: 'Special hours',
				})
				break
			case 'phone':
				if (!desired.phone) break
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.phone,
					body: { phoneNumbers: { primaryPhone: desired.phone } },
					value: desired.phone,
					label: 'Phone number',
				})
				break
			case 'website':
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.website,
					body: { websiteUri: desired.website },
					value: desired.website,
					label: 'Website link',
				})
				break
			case 'openState':
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.openState,
					body: { openInfo: { status: desired.openStatus } },
					value: desired.openStatus,
					label: 'Open or closed',
				})
				break
			case 'name':
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.name,
					body: { title: ctx.location.name },
					value: ctx.location.name,
					label: 'Name',
				})
				break
			case 'address': {
				const address = addressToGoogle(desired.address)
				if (!address) break
				plans.push({
					field,
					mask: GBP_UPDATE_MASK.address,
					body: { storefrontAddress: address },
					value: address,
					label: 'Address',
				})
				break
			}
			default:
				break
		}
	}
	return plans
}

function pendingReason(error: GbpError) {
	return error.reason || error.code
}

/** Whether the link may be written to: verified, connected, flags on. */
export function syncReady(
	sync: Pick<GbpContext['sync'], 'state' | 'verificationState'>,
) {
	return (
		sync.state === 'ok' &&
		sync.verificationState !== 'unverified' &&
		sync.verificationState !== 'pending'
	)
}

export async function pushLocationToGoogle(input: {
	organizationId: string
	organizationLocationId: string
	actorId?: string | null
	/** Fields to send; default is every field the operator opted in to. */
	fields?: readonly (GbpSyncField | GbpExplicitField)[]
	/** "Use Menuza's value": send even with sync off, and send again. */
	explicit?: boolean
	now?: Date
	ctx?: GbpContext
}): Promise<PushResult> {
	const now = input.now ?? new Date()
	const flags = await gbpFlags(input.organizationId)
	if (!flags.sync || !flags.write) {
		return { results: [], held: [], blocked: 'flags_off' }
	}
	const ctx =
		input.ctx ??
		(await loadGbpContext(input.organizationId, input.organizationLocationId))
	if (!ctx || !ctx.integration?.isActive) {
		return { results: [], held: [], blocked: 'not_linked' }
	}
	if (!input.explicit && !ctx.sync.syncEnabled) {
		return { results: [], held: [], blocked: 'sync_off' }
	}
	const requested = (input.fields ??
		parseFieldsSynced(ctx.sync.fieldsSynced)) as readonly string[]
	// Name, address and category edits would void a pending code: held, with
	// an explanation on the Google tab, whatever else is going out.
	const held = heldFieldsWhilePending(ctx.sync, requested)
	for (const field of held) {
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'push',
			field,
			actorId: input.actorId,
			summary: `${field} edit held while a verification code is pending`,
			result: 'skipped',
			response: 'gbp_edit_held',
		})
	}
	if (!syncReady(ctx.sync)) {
		// Not verified, suspended or disconnected: nothing is sent, the outbox
		// mark stays so the push goes out once the profile is ready.
		return { results: [], held, blocked: 'not_ready' }
	}

	const wantsLinks = requested.includes('links')
	const listingFields = requested.filter(
		(field): field is ListingField =>
			isListingField(field) && !held.includes(field as GbpExplicitField),
	)

	const state: FieldState = parseFieldState(ctx.sync.fieldState)
	const plans = planFields(ctx, listingFields, now, {
		// Remove a special day we sent earlier; never wipe days set on Google.
		includeEmptySpecial: Boolean(state.specialHours),
	}).map((plan) => ({ ...plan, fp: fingerprint(plan.value) }))
	const due = plans.filter(
		(plan) =>
			input.explicit || shouldPushField(state, plan.field, plan.fp, now),
	)

	const results: PushFieldResult[] = []
	let client: GbpClient | null = null
	const patchTime = now.toISOString()
	const nextState: FieldState = { ...state }
	let stateError: GbpError | null = null

	const setResult = (
		plan: (typeof due)[number],
		status: PushFieldResult['status'],
		reason?: string,
	) => {
		results.push({ field: plan.field, status, reason })
		nextState[plan.field] = {
			fingerprint: plan.fp,
			attemptedAt: patchTime,
			status: status === 'skipped' ? 'failed' : status,
			reason: reason ?? null,
		}
	}

	if (due.length > 0) {
		try {
			client = await gbpClientFor(ctx.integration)
			// Never reopen a listing Google shows as permanently closed.
			let skipOpen = false
			if (due.some((plan) => plan.field === 'openState')) {
				const current = await client.getListing(ctx.sync.googleLocationName)
				skipOpen = current.openInfo?.status === 'CLOSED_PERMANENTLY'
			}
			const sendable = due.filter(
				(plan) => !(plan.field === 'openState' && skipOpen),
			)
			for (const plan of due) {
				if (!sendable.includes(plan)) {
					results.push({
						field: plan.field,
						status: 'skipped',
						reason: 'closed_permanently',
					})
				}
			}
			if (sendable.length > 0) {
				await sendBatch(
					ctx,
					client,
					sendable,
					input.actorId ?? null,
					(plan, status, reason) => setResult(plan, status, reason),
				)
			}
		} catch (error) {
			stateError = await recordGbpError(ctx, error)
			if (!stateError) throw error
			if (!connectionStateForError(stateError.code)) {
				for (const plan of due) {
					setResult(plan, 'failed', stateError.code)
					await recordGbpEvent({
						sync: ctx.sync,
						kind: 'push',
						field: plan.field,
						actorId: input.actorId,
						summary: `${plan.label} was not sent`,
						request: { updateMask: plan.mask, body: plan.body },
						result: 'failed',
						response: pendingReason(stateError),
					})
				}
			} else {
				await recordGbpEvent({
					sync: ctx.sync,
					kind: 'push',
					summary: 'Google refused the connection',
					result: 'failed',
					response: stateError.code,
				})
			}
		}
	}

	if (wantsLinks && !stateError) {
		try {
			await syncSiteLinks(ctx, { actorId: input.actorId ?? null, now })
			results.push({ field: 'links', status: 'sent' })
		} catch (error) {
			const known = await recordGbpError(ctx, error)
			if (!known) throw error
			results.push({ field: 'links', status: 'failed', reason: known.code })
		}
	}

	if (requested.includes('attributes') && !stateError) {
		try {
			const attributeFingerprint = fingerprint(
				await derivedAttributeValues(ctx),
			)
			if (
				input.explicit ||
				shouldPushField(state, 'attributes', attributeFingerprint, now)
			) {
				await syncDerivedAttributes(ctx, { actorId: input.actorId ?? null })
				results.push({ field: 'attributes', status: 'sent' })
				nextState.attributes = {
					fingerprint: attributeFingerprint,
					attemptedAt: patchTime,
					status: 'sent',
				}
			}
		} catch (error) {
			const known = await recordGbpError(ctx, error)
			if (!known) throw error
			results.push({
				field: 'attributes',
				status: 'failed',
				reason: known.code,
			})
		}
	}

	await saveSync(ctx.sync.id, {
		fieldState: JSON.stringify(nextState),
		...(results.some(
			(result) =>
				result.status === 'sent' || result.status === 'pending_google',
		)
			? { lastPushedAt: now }
			: {}),
		...(stateError && connectionStateForError(stateError.code)
			? {}
			: { pushRequestedAt: null, lastError: null }),
	})
	return { results, held, blocked: null }
}

/**
 * Sends the plans in one `locations.patch` (batched edits). If Google refuses
 * the batch, each field goes on its own so one bad value (a phone number) does
 * not hold back the others.
 */
async function sendBatch(
	ctx: GbpContext,
	client: GbpClient,
	plans: Array<FieldPlan & { fp: string }>,
	actorId: string | null,
	report: (
		plan: FieldPlan & { fp: string },
		status: PushFieldResult['status'],
		reason?: string,
	) => void,
) {
	const send = async (group: Array<FieldPlan & { fp: string }>) => {
		const updateMask = group.map((plan) => plan.mask).join(',')
		const body = Object.assign(
			{},
			...group.map((plan) => plan.body),
		) as Partial<GbpListing>
		// Nested masks (`openInfo.status`) merge their parent objects above.
		const outcome = await client.patchListing(
			ctx.sync.googleLocationName,
			updateMask,
			body,
		)
		for (const plan of group) {
			const pending = outcome.status === 'pending'
			report(plan, pending ? 'pending_google' : 'sent')
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'push',
				field: plan.field,
				actorId,
				summary: pending
					? `${plan.label} sent; Google is reviewing it`
					: `${plan.label} updated on Google`,
				request: { updateMask: plan.mask, body: plan.body },
				result: pending ? 'pending_google' : 'accepted',
			})
		}
	}
	try {
		await send(plans)
	} catch (error) {
		if (
			!(error instanceof GbpError) ||
			error.code !== 'gbp_rejected' ||
			plans.length === 1
		) {
			if (error instanceof GbpError && error.code === 'gbp_rejected') {
				const [plan] = plans
				if (plan) {
					report(plan, 'rejected', pendingReason(error))
					await recordGbpEvent({
						sync: ctx.sync,
						kind: 'push',
						field: plan.field,
						actorId,
						summary: `Google refused ${plan.label.toLowerCase()}`,
						request: { updateMask: plan.mask, body: plan.body },
						result: 'rejected',
						response: pendingReason(error),
					})
				}
				return
			}
			throw error
		}
		for (const plan of plans) {
			try {
				await send([plan])
			} catch (single) {
				if (single instanceof GbpError && single.code === 'gbp_rejected') {
					report(plan, 'rejected', pendingReason(single))
					await recordGbpEvent({
						sync: ctx.sync,
						kind: 'push',
						field: plan.field,
						actorId,
						summary: `Google refused ${plan.label.toLowerCase()}`,
						request: { updateMask: plan.mask, body: plan.body },
						result: 'rejected',
						response: pendingReason(single),
					})
				} else {
					throw single
				}
			}
		}
	}
}

/**
 * Called after a save commits. Marks the location in the outbox and tries to
 * push right away, within a few seconds. It never throws and never lets a
 * Google problem reach the caller: a failed or slow push is finished by the
 * hourly sweep.
 */
export async function enqueueGbpPush(input: {
	organizationId: string
	organizationLocationId: string
	actorId?: string | null
	/** Limit the push to these fields (default: every opted-in field). */
	fields?: readonly (GbpSyncField | GbpExplicitField)[]
	timeoutMs?: number
}): Promise<void> {
	try {
		const flags = await gbpFlags(input.organizationId)
		if (!flags.sync || !flags.write) return
		const ctx = await loadGbpContext(
			input.organizationId,
			input.organizationLocationId,
		)
		if (!ctx || !ctx.sync.syncEnabled) return
		await saveSync(ctx.sync.id, { pushRequestedAt: new Date() })
		let timer: ReturnType<typeof setTimeout> | undefined
		await Promise.race([
			pushLocationToGoogle({
				organizationId: input.organizationId,
				organizationLocationId: input.organizationLocationId,
				actorId: input.actorId,
				fields: input.fields,
				ctx,
			}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, input.timeoutMs ?? 8_000)
			}),
		]).finally(() => timer && clearTimeout(timer))
	} catch (error) {
		console.error('Google listing push failed', {
			organizationId: input.organizationId,
			locationId: input.organizationLocationId,
			error: error instanceof Error ? error.name : 'unknown',
		})
	}
}

// ---------------------------------------------------------------------------
// Pull: connection state, pending changes and Needs attention items
// ---------------------------------------------------------------------------

type IssueValue = { summary: string; value?: unknown }

type FieldDifference = {
	field: string
	menuza: IssueValue
	google: IssueValue
}

function normalizeUrl(value: string | undefined | null) {
	return (value ?? '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(www\.)?/, '')
		.replace(/\/+$/, '')
}

function formatAddress(address: Record<string, unknown> | null | undefined) {
	if (!address) return ''
	const lines = Array.isArray(address.addressLines)
		? (address.addressLines as string[]).join(' ')
		: ''
	return [
		lines,
		address.locality,
		address.administrativeArea,
		address.postalCode,
	]
		.filter(Boolean)
		.join(', ')
		.toLowerCase()
}

/** Every difference between Menuza and the listing Google shows. */
export function listingDifferences(
	ctx: GbpContext,
	listing: GbpListing,
	now: Date,
): FieldDifference[] {
	const desired = desiredListing(ctx, now)
	const today = localDateIso(now, ctx.location.timezone || 'UTC')
	const out: FieldDifference[] = []

	if (desired.storeHours && desired.hoursPeriods.length > 0) {
		const googlePeriods = listing.regularHours?.periods ?? []
		if (!weeklyHoursEqual(desired.storeHours, googlePeriods)) {
			const days = diffWeeklyHours(desired.storeHours, googlePeriods)
			out.push({
				field: 'hours',
				menuza: {
					summary: days.map((d) => `${d.label} ${d.menuza}`).join('; '),
					value: desired.hoursPeriods,
				},
				google: {
					summary: days.map((d) => `${d.label} ${d.google}`).join('; '),
					value: googlePeriods,
				},
			})
		}
	}

	const googleSpecial = listing.specialHours?.specialHourPeriods ?? []
	const specialDiff = diffSpecialHours(
		desired.specialHours,
		googleSpecial,
		today,
	)
	if (specialDiff.length > 0) {
		out.push({
			field: 'specialHours',
			menuza: {
				summary: specialDiff.map((d) => `${d.date} ${d.menuza}`).join('; '),
				value: desired.specialPeriods,
			},
			google: {
				summary: specialDiff.map((d) => `${d.date} ${d.google}`).join('; '),
				value: googleSpecial,
			},
		})
	}

	if (desired.phone) {
		const googlePhone = listing.phoneNumbers?.primaryPhone ?? ''
		if (!phonesEqual(desired.phone, googlePhone)) {
			out.push({
				field: 'phone',
				menuza: { summary: desired.phone, value: desired.phone },
				google: { summary: googlePhone || 'Not set', value: googlePhone },
			})
		}
	}

	if (normalizeUrl(desired.website) !== normalizeUrl(listing.websiteUri)) {
		out.push({
			field: 'website',
			menuza: { summary: desired.website, value: desired.website },
			google: {
				summary: listing.websiteUri || 'Not set',
				value: listing.websiteUri ?? '',
			},
		})
	}

	const googleStatus = listing.openInfo?.status ?? 'OPEN'
	if (
		googleStatus !== 'CLOSED_PERMANENTLY' &&
		googleStatus !== 'OPEN_FOR_BUSINESS_UNSPECIFIED' &&
		googleStatus !== desired.openStatus
	) {
		out.push({
			field: 'openState',
			menuza: {
				summary: desired.openStatus === 'OPEN' ? 'Open' : 'Temporarily closed',
				value: desired.openStatus,
			},
			google: {
				summary: googleStatus === 'OPEN' ? 'Open' : 'Temporarily closed',
				value: googleStatus,
			},
		})
	}

	if (
		listing.title &&
		listing.title.trim().toLowerCase() !==
			ctx.location.name.trim().toLowerCase()
	) {
		out.push({
			field: 'name',
			menuza: { summary: ctx.location.name, value: ctx.location.name },
			google: { summary: listing.title, value: listing.title },
		})
	}

	const mineAddress = formatAddress(addressToGoogle(desired.address))
	const theirAddress = formatAddress(listing.storefrontAddress)
	if (mineAddress && theirAddress && mineAddress !== theirAddress) {
		out.push({
			field: 'address',
			menuza: { summary: desired.address?.formattedAddress ?? mineAddress },
			google: {
				summary: theirAddress,
				value: listing.storefrontAddress,
			},
		})
	}
	return out
}

/**
 * Brings the issue list in line with the differences found: new differences
 * open an item; a changed difference reopens an ignored one; a difference that
 * went away resolves its item. Items for fields Menuza sent that Google still
 * holds for review are `pending_google`.
 */
export async function upsertListingIssues(
	ctx: Pick<GbpContext, 'sync'>,
	differences: FieldDifference[],
	options: {
		pendingFields: ReadonlySet<string>
		/** Fields this pull compared (others keep their items untouched). */
		comparedFields: ReadonlySet<string>
	},
) {
	const existing = await db
		.select()
		.from(GbpListingIssue)
		.where(
			and(
				eq(GbpListingIssue.syncId, ctx.sync.id),
				inArray(GbpListingIssue.status, ['open', 'ignored', 'pending_google']),
			),
		)
		.orderBy(asc(GbpListingIssue.createdAt))
	const byField = new Map(existing.map((issue) => [issue.field, issue]))
	const now = new Date()
	for (const difference of differences) {
		const menuzaValue = JSON.stringify(difference.menuza)
		const googleValue = JSON.stringify(difference.google)
		const status = options.pendingFields.has(difference.field)
			? 'pending_google'
			: 'open'
		const current = byField.get(difference.field)
		if (!current) {
			await db.insert(GbpListingIssue).values({
				syncId: ctx.sync.id,
				organizationId: ctx.sync.organizationId,
				organizationLocationId: ctx.sync.organizationLocationId,
				field: difference.field,
				menuzaValue,
				googleValue,
				status,
			})
			continue
		}
		const changed =
			current.menuzaValue !== menuzaValue || current.googleValue !== googleValue
		if (current.status === 'ignored' && !changed) continue
		await db
			.update(GbpListingIssue)
			.set({
				menuzaValue,
				googleValue,
				status,
				resolvedAt: null,
				resolvedById: null,
			})
			.where(eq(GbpListingIssue.id, current.id))
	}
	const stillDifferent = new Set(
		differences.map((difference) => difference.field),
	)
	for (const issue of existing) {
		if (!options.comparedFields.has(issue.field)) continue
		if (stillDifferent.has(issue.field)) continue
		await db
			.update(GbpListingIssue)
			.set({ status: 'resolved', resolvedAt: now })
			.where(eq(GbpListingIssue.id, issue.id))
	}
}

export type PullResult = {
	ok: boolean
	differences: number
	error?: string
}

const COMPARED_FIELDS = new Set([
	'hours',
	'specialHours',
	'phone',
	'website',
	'openState',
	'name',
	'address',
])

/** Reads the listing and refreshes the link's state and issue list. */
export async function pullLocation(input: {
	organizationId: string
	organizationLocationId: string
	now?: Date
	ctx?: GbpContext
}): Promise<PullResult> {
	const now = input.now ?? new Date()
	const ctx =
		input.ctx ??
		(await loadGbpContext(input.organizationId, input.organizationLocationId))
	if (!ctx || !ctx.integration?.isActive) {
		return { ok: false, differences: 0, error: 'not_linked' }
	}
	try {
		const client = await gbpClientFor(ctx.integration)
		const name = ctx.sync.googleLocationName
		const merchant = await client.getVoiceOfMerchantState(name)
		const connection = merchant.suspended
			? 'suspended'
			: !merchant.hasBusinessAuthority || merchant.ownershipConflict
				? 'access_lost'
				: merchant.hasVoiceOfMerchant
					? 'ok'
					: 'not_verified'
		const verificationState = merchant.hasVoiceOfMerchant
			? 'verified'
			: merchant.hasPendingVerification
				? 'pending'
				: 'unverified'
		await saveSync(ctx.sync.id, {
			state: connection,
			verificationState,
			verificationCheckedAt: now,
			lastPulledAt: now,
			...(connection === 'ok' ? { lastError: null } : {}),
		})
		ctx.sync = {
			...ctx.sync,
			state: connection,
			verificationState,
		}
		if (connection !== 'ok') {
			return { ok: true, differences: 0 }
		}

		const [listing, updated] = await Promise.all([
			client.getListing(name),
			client.getGoogleUpdated(name),
		])
		const pendingMask = new Set(updated.pendingMask.split(',').filter(Boolean))
		const fieldState = parseFieldState(ctx.sync.fieldState)
		const pendingFields = new Set<string>()
		const settledState: FieldState = { ...fieldState }
		const differencesNow = listingDifferences(ctx, listing, now)
		const differentFields = new Set(
			differencesNow.map((difference) => difference.field),
		)
		for (const [field, attempt] of Object.entries(fieldState)) {
			if (!attempt || attempt.status !== 'pending_google') continue
			const mask = (GBP_UPDATE_MASK as Record<string, string>)[field]
			const stillPending = mask
				? [...pendingMask].some(
						(entry) => entry === mask || mask.startsWith(`${entry}.`),
					)
				: false
			if (stillPending) {
				pendingFields.add(field)
			} else if (differentFields.has(field)) {
				// Google reviewed it and kept its own value.
				settledState[field] = {
					...attempt,
					status: 'rejected',
					reason: 'Google did not accept this change.',
				}
				await recordGbpEvent({
					sync: ctx.sync,
					kind: 'pull',
					field,
					summary: `Google did not accept the ${field} change`,
					result: 'rejected',
					response: 'Google did not accept this change.',
				})
			} else {
				settledState[field] = { ...attempt, status: 'sent', reason: null }
				await recordGbpEvent({
					sync: ctx.sync,
					kind: 'pull',
					field,
					summary: `Google accepted the ${field} change`,
					result: 'accepted',
				})
			}
		}

		await reconcileProfileFields(ctx, listing, pendingMask)
		await upsertListingIssues(ctx, differencesNow, {
			pendingFields,
			comparedFields: COMPARED_FIELDS,
		})
		await saveSync(ctx.sync.id, {
			lastGoogleSnapshot: JSON.stringify(snapshotOf(listing)),
			fieldState: JSON.stringify(settledState),
		})
		return { ok: true, differences: differencesNow.length }
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		return { ok: false, differences: 0, error: known.code }
	}
}

function snapshotOf(listing: GbpListing) {
	return {
		title: listing.title ?? null,
		phone: listing.phoneNumbers?.primaryPhone ?? null,
		website: listing.websiteUri ?? null,
		openStatus: listing.openInfo?.status ?? null,
		hasRegularHours: (listing.regularHours?.periods?.length ?? 0) > 0,
		description: listing.profile?.description ?? null,
		categories: listing.categories ?? null,
	}
}

// ---------------------------------------------------------------------------
// Resolve an issue
// ---------------------------------------------------------------------------

export type ResolveChoice = 'menuza' | 'google' | 'ignore'

export type ResolveResult =
	| { ok: true; status: 'resolved' | 'ignored' | 'pending_google' }
	| {
			ok: false
			error:
				| 'not_found'
				| 'held'
				| 'locked'
				| 'not_supported'
				| 'flags_off'
				| 'not_ready'
				| 'rejected'
				| 'failed'
			reason?: string
	  }

async function setIssue(
	issueId: string,
	status: 'resolved' | 'ignored' | 'pending_google',
	actorId: string,
) {
	await db
		.update(GbpListingIssue)
		.set({ status, resolvedById: actorId, resolvedAt: new Date() })
		.where(eq(GbpListingIssue.id, issueId))
}

/**
 * Applies the operator's choice for one Needs attention item. "Use Menuza's
 * value" pushes the field now (name and address only ever change this way);
 * "Use Google's value" updates Menuza from the listing and never pushes.
 */
export async function resolveIssue(input: {
	organizationId: string
	organizationLocationId: string
	issueId: string
	choice: ResolveChoice
	actorId: string
	now?: Date
}): Promise<ResolveResult> {
	const now = input.now ?? new Date()
	const ctx = await loadGbpContext(
		input.organizationId,
		input.organizationLocationId,
	)
	if (!ctx) return { ok: false, error: 'not_found' }
	const [issue] = await db
		.select()
		.from(GbpListingIssue)
		.where(
			and(
				eq(GbpListingIssue.id, input.issueId),
				eq(GbpListingIssue.syncId, ctx.sync.id),
				eq(GbpListingIssue.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!issue) return { ok: false, error: 'not_found' }

	if (input.choice === 'ignore') {
		await setIssue(issue.id, 'ignored', input.actorId)
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'resolve',
			field: issue.field,
			actorId: input.actorId,
			summary: `Ignored the ${issue.field} difference`,
			result: 'skipped',
		})
		return { ok: true, status: 'ignored' }
	}

	if (input.choice === 'menuza') {
		if (issue.field === 'orderLink' || issue.field === 'reserveLink') {
			return { ok: false, error: 'not_supported' }
		}
		const result = await pushLocationToGoogle({
			organizationId: input.organizationId,
			organizationLocationId: input.organizationLocationId,
			actorId: input.actorId,
			fields: [issue.field as GbpSyncField | GbpExplicitField],
			explicit: true,
			now,
			ctx,
		})
		if (result.blocked === 'flags_off') return { ok: false, error: 'flags_off' }
		if (result.held.length > 0) return { ok: false, error: 'held' }
		if (result.blocked) return { ok: false, error: 'not_ready' }
		const outcome = result.results.find((r) => r.field === issue.field)
		if (!outcome) return { ok: false, error: 'not_supported' }
		if (outcome.status === 'rejected') {
			return { ok: false, error: 'rejected', reason: outcome.reason }
		}
		if (outcome.status === 'failed' || outcome.status === 'skipped') {
			return { ok: false, error: 'failed', reason: outcome.reason }
		}
		const status =
			outcome.status === 'pending_google' ? 'pending_google' : 'resolved'
		await setIssue(issue.id, status, input.actorId)
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'resolve',
			field: issue.field,
			actorId: input.actorId,
			summary: `Used Menuza's ${issue.field} on Google`,
			result: status === 'pending_google' ? 'pending_google' : 'accepted',
		})
		return { ok: true, status }
	}

	// Use Google's value: update Menuza from the listing Google shows now.
	const applied = await applyGoogleValue(ctx, issue.field, now)
	if (!applied.ok) return applied
	await setIssue(issue.id, 'resolved', input.actorId)
	await recordGbpEvent({
		sync: ctx.sync,
		kind: 'resolve',
		field: issue.field,
		actorId: input.actorId,
		summary: `Used Google's ${issue.field} in Menuza`,
		result: 'accepted',
	})
	return { ok: true, status: 'resolved' }
}

async function applyGoogleValue(
	ctx: GbpContext,
	field: string,
	now: Date,
): Promise<{ ok: true } | Extract<ResolveResult, { ok: false }>> {
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_ready' }
	let listing: GbpListing
	try {
		listing = await (
			await gbpClientFor(ctx.integration)
		).getListing(ctx.sync.googleLocationName)
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		return { ok: false, error: 'failed', reason: known?.code }
	}
	const locked = await getLockedLocationSettingIds(ctx.organization.id)
	const set: Partial<typeof OrganizationLocation.$inferInsert> = {}
	switch (field) {
		case 'hours': {
			if (locked.has('storeHours')) return { ok: false, error: 'locked' }
			const schedule = googleBusinessSchedule({
				name: ctx.sync.googleLocationName,
				title: listing.title ?? ctx.location.name,
				regularHours: listing.regularHours,
			})
			set.storeHours = schedule ? JSON.stringify(schedule) : null
			break
		}
		case 'specialHours': {
			if (locked.has('specialHours')) return { ok: false, error: 'locked' }
			const today = localDateIso(now, ctx.location.timezone || 'UTC')
			const merged = googleSpecialToMenuza(
				(listing.specialHours?.specialHourPeriods ??
					[]) as GoogleSpecialHourPeriod[],
				today,
				parseJson(ctx.location.specialHours, []),
			)
			set.specialHours = JSON.stringify(merged)
			break
		}
		case 'phone':
			set.phone = listing.phoneNumbers?.primaryPhone ?? null
			break
		case 'openState':
			set.temporarilyClosed = listing.openInfo?.status === 'CLOSED_TEMPORARILY'
			set.temporarilyClosedUntil = null
			break
		case 'name':
			if (!listing.title) return { ok: false, error: 'not_supported' }
			set.name = listing.title
			break
		case 'address': {
			const address = googleAddressToMenuza({
				storefrontAddress: listing.storefrontAddress as never,
				latlng: undefined,
			})
			if (!address) return { ok: false, error: 'not_supported' }
			const current = parseJson<LocationAddress | null>(
				ctx.location.address,
				null,
			)
			// Keep the coordinates Menuza already has: Google's read mask here
			// does not carry them.
			set.address = JSON.stringify({
				...address,
				lat: current?.lat ?? address.lat,
				lng: current?.lng ?? address.lng,
			})
			break
		}
		default:
			// The website link has no Menuza field: it is derived from the site.
			return { ok: false, error: 'not_supported' }
	}
	await db
		.update(OrganizationLocation)
		.set(set)
		.where(
			and(
				eq(OrganizationLocation.id, ctx.location.id),
				eq(OrganizationLocation.organizationId, ctx.organization.id),
			),
		)
	return { ok: true }
}

// ---------------------------------------------------------------------------
// Settings on the link
// ---------------------------------------------------------------------------

export async function setSyncSettings(input: {
	organizationId: string
	organizationLocationId: string
	syncEnabled?: boolean
	fieldsSynced?: GbpSyncField[]
}): Promise<boolean> {
	const [row] = await db
		.select({ id: GbpLocationSync.id })
		.from(GbpLocationSync)
		.where(
			and(
				eq(GbpLocationSync.organizationId, input.organizationId),
				eq(
					GbpLocationSync.organizationLocationId,
					input.organizationLocationId,
				),
			),
		)
		.limit(1)
	if (!row) return false
	await saveSync(row.id, {
		...(input.syncEnabled === undefined
			? {}
			: { syncEnabled: input.syncEnabled }),
		...(input.fieldsSynced
			? {
					fieldsSynced: JSON.stringify(
						input.fieldsSynced.filter((field) =>
							(GBP_SYNC_FIELDS as readonly string[]).includes(field),
						),
					),
				}
			: {}),
		...(input.syncEnabled ? { pushRequestedAt: new Date() } : {}),
	})
	return true
}

export { isoFromGoogleDate, recordGbpError }
