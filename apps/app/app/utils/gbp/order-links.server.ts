/**
 * Place Actions links on the Google profile (#87 Order online and Reserve
 * links, #199 delivery-app links). ONE writer: `syncSiteLinks` keeps
 * Menuza's own pages on the profile; `makeMenuzaPreferred` switches the
 * preferred link after the operator's confirmation and `undoPreferredChange`
 * puts the previous state back. Classification comes from
 * `@repo/common/ordering-providers`.
 *
 * Nothing is removed from the profile except Menuza's own order links during a
 * long ordering pause. Links Google's partners manage (`AGGREGATOR_3P`) are
 * never touched; the card says so.
 */
import { createId } from '@paralleldrive/cuid2'
import { GbpError, orderLinkShouldBeRemoved } from '@repo/common/gbp-listing'
import {
	type OrderLinkClassification,
	type OrderLinkKind,
	ORDER_LINK_KINDS,
	classifyOrderLink,
	placeActionKind,
	placeActionTypeFor,
} from '@repo/common/ordering-providers'
import {
	and,
	db,
	desc,
	eq,
	GbpListingIssue,
	GbpLocationSync,
	GbpSyncEvent,
	ListingOrderLink,
} from '@repo/database'
import {
	type GbpClient,
	type PlaceActionLink,
	gbpClientFor,
} from '@repo/integrations'
import { ENV } from 'varlock/env'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'
import {
	type GbpContext,
	onlineOrderingOn,
	recordGbpEvent,
	siteLinks,
	siteOrigin,
} from './context.server.ts'

/** A weekly re-check is due when the last snapshot is older than this. */
export const ORDER_LINK_RECHECK_MS = 7 * 24 * 60 * 60_000

export type OrderLinkView = {
	kind: OrderLinkKind
	url: string
	provider: string
	classification: OrderLinkClassification
	isPreferred: boolean
	/** Short links hide where they lead. */
	isShortLink: boolean
	/** Google's partners manage it; Menuza cannot change or remove it. */
	editable: boolean
	googleLinkName: string | null
}

/** The restaurant's own origins: its site and, if any, the default subdomain. */
function ownOrigins(ctx: GbpContext): string[] {
	const origins = new Set([siteOrigin(ctx.organization)])
	origins.add(
		resolveSitesOrigin({
			slug: ctx.organization.slug,
			customDomain: null,
			baseUrl: ENV.BASE_URL ?? '',
			hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
				.PUBLIC_SITE_HOST_SUFFIXES,
		}).replace(/\/$/, ''),
	)
	return [...origins]
}

export function viewOfLink(
	link: PlaceActionLink,
	origins: readonly string[],
): OrderLinkView | null {
	const kind = placeActionKind(link.placeActionType)
	if (!kind) return null
	const classified = classifyOrderLink(link.uri, origins)
	return {
		kind,
		url: link.uri,
		provider: classified.provider,
		classification: classified.classification,
		isPreferred: link.isPreferred,
		isShortLink: classified.isShortLink,
		editable: link.isEditable && link.providerType !== 'AGGREGATOR_3P',
		googleLinkName: link.name || null,
	}
}

function sameUrl(left: string, right: string) {
	const clean = (value: string) =>
		value.trim().toLowerCase().replace(/\/+$/, '')
	return clean(left) === clean(right)
}

function ourUrlFor(ctx: GbpContext, kind: OrderLinkKind): string | null {
	const links = siteLinks(ctx.organization, ctx.location, ctx.locationCount)
	if (kind === 'reservation') return links.reservation
	return links.order
}

/**
 * Reads the profile's links, stores a snapshot, and opens (or resolves) the
 * Needs attention item "Order online link on Google points to a delivery
 * app" when a delivery app is the preferred order, pickup or delivery link.
 */
export async function refreshOrderLinks(
	ctx: GbpContext,
	options: { client?: GbpClient; now?: Date } = {},
): Promise<OrderLinkView[]> {
	if (!ctx.integration?.isActive) return []
	const now = options.now ?? new Date()
	const client = options.client ?? (await gbpClientFor(ctx.integration))
	const links = await client.listPlaceActionLinks(ctx.sync.googleLocationName)
	const origins = ownOrigins(ctx)
	const views = links
		.map((link) => viewOfLink(link, origins))
		.filter((view): view is OrderLinkView => view !== null)

	await db
		.delete(ListingOrderLink)
		.where(
			and(
				eq(ListingOrderLink.organizationLocationId, ctx.location.id),
				eq(ListingOrderLink.state, 'current'),
			),
		)
	for (const view of views) {
		await db.insert(ListingOrderLink).values({
			organizationId: ctx.organization.id,
			organizationLocationId: ctx.location.id,
			kind: view.kind,
			url: view.url,
			provider: view.provider || 'Unknown',
			classification: view.classification,
			isPreferred: view.isPreferred,
			googleLinkName: view.googleLinkName,
			googleProviderType: view.editable ? 'MERCHANT' : 'AGGREGATOR_3P',
			editable: view.editable,
			state: 'current',
			checkedAt: now,
		})
	}

	const offenders = views.filter(
		(view) =>
			view.isPreferred &&
			view.classification === 'delivery_app' &&
			view.kind !== 'reservation',
	)
	await syncOrderLinkIssue(ctx, offenders)
	return views
}

async function syncOrderLinkIssue(ctx: GbpContext, offenders: OrderLinkView[]) {
	const [existing] = await db
		.select()
		.from(GbpListingIssue)
		.where(
			and(
				eq(GbpListingIssue.syncId, ctx.sync.id),
				eq(GbpListingIssue.field, 'orderLink'),
			),
		)
		.orderBy(desc(GbpListingIssue.createdAt))
		.limit(1)
	const open = existing && existing.status !== 'resolved' ? existing : null
	if (offenders.length === 0) {
		if (open) {
			await db
				.update(GbpListingIssue)
				.set({ status: 'resolved', resolvedAt: new Date() })
				.where(eq(GbpListingIssue.id, open.id))
		}
		return
	}
	const googleValue = JSON.stringify({
		summary: offenders
			.map((view) => `${view.kind}: ${view.provider}`)
			.join('; '),
		value: offenders.map((view) => ({ kind: view.kind, url: view.url })),
	})
	const menuzaValue = JSON.stringify({
		summary: ourUrlFor(ctx, 'order') ?? '',
	})
	if (!open) {
		await db.insert(GbpListingIssue).values({
			syncId: ctx.sync.id,
			organizationId: ctx.organization.id,
			organizationLocationId: ctx.location.id,
			field: 'orderLink',
			menuzaValue,
			googleValue,
			status: 'open',
		})
	} else if (open.status !== 'ignored' || open.googleValue !== googleValue) {
		await db
			.update(GbpListingIssue)
			.set({ googleValue, menuzaValue, status: 'open' })
			.where(eq(GbpListingIssue.id, open.id))
	}
}

/** The stored snapshot, newest check first (no Google call). */
export async function listOrderLinkSnapshot(locationId: string) {
	return db
		.select()
		.from(ListingOrderLink)
		.where(
			and(
				eq(ListingOrderLink.organizationLocationId, locationId),
				eq(ListingOrderLink.state, 'current'),
			),
		)
}

// ---------------------------------------------------------------------------
// Keeping Menuza's own links on the profile (#87)
// ---------------------------------------------------------------------------

const ORDER_KINDS: OrderLinkKind[] = ['order']

/**
 * Makes sure Menuza's order and booking pages are on the profile. A missing
 * link is created (preferred only when nothing else is preferred: taking the
 * preference from a delivery app needs the operator's confirmation, #199). A
 * long ordering pause removes Menuza's order link and resuming puts it back;
 * a short pause changes nothing.
 */
export async function syncSiteLinks(
	ctx: GbpContext,
	options: { actorId: string | null; now: Date; client?: GbpClient },
) {
	if (!ctx.integration?.isActive) return
	const client = options.client ?? (await gbpClientFor(ctx.integration))
	const name = ctx.sync.googleLocationName
	const origins = ownOrigins(ctx)
	const links = await client.listPlaceActionLinks(name)
	const removeOrderLinks = orderLinkShouldBeRemoved(
		{
			orderingPausedAt: ctx.location.orderingPausedAt,
			orderingPausedUntil: ctx.location.orderingPausedUntil,
		},
		options.now,
	)

	const wanted: OrderLinkKind[] = []
	if (!removeOrderLinks && onlineOrderingOn(ctx.location)) {
		wanted.push(...ORDER_KINDS)
	}
	if (await isReservationsFeatureEnabled(ctx.organization.id, 'enabled')) {
		wanted.push('reservation')
	}

	// Menuza's own order links come off during a long pause.
	if (removeOrderLinks) {
		const ours = links.filter((link) => {
			const kind = placeActionKind(link.placeActionType)
			return (
				kind &&
				kind !== 'reservation' &&
				link.isEditable &&
				classifyOrderLink(link.uri, origins).classification === 'direct'
			)
		})
		for (const link of ours) {
			await client.deletePlaceActionLink(link.name)
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'links',
				field: 'orderLink',
				actorId: options.actorId,
				summary: 'Order link removed from Google while ordering is paused',
				request: { deleted: link.name, uri: link.uri },
				result: 'accepted',
			})
		}
		if (!ctx.sync.orderLinkPausedAt) {
			await db
				.update(GbpLocationSync)
				.set({ orderLinkPausedAt: options.now })
				.where(eq(GbpLocationSync.id, ctx.sync.id))
			ctx.sync = { ...ctx.sync, orderLinkPausedAt: options.now }
		}
	} else if (ctx.sync.orderLinkPausedAt) {
		await db
			.update(GbpLocationSync)
			.set({ orderLinkPausedAt: null })
			.where(eq(GbpLocationSync.id, ctx.sync.id))
		ctx.sync = { ...ctx.sync, orderLinkPausedAt: null }
	}

	for (const kind of wanted) {
		const type = placeActionTypeFor(kind)
		const url = ourUrlFor(ctx, kind)
		if (!url) continue
		const ofKind = links.filter((link) => link.placeActionType === type)
		if (ofKind.some((link) => sameUrl(link.uri, url))) continue
		const created = await client.createPlaceActionLink(name, {
			uri: url,
			placeActionType: type,
			isPreferred: !ofKind.some((link) => link.isPreferred),
		})
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'links',
			field: kind === 'reservation' ? 'reserveLink' : 'orderLink',
			actorId: options.actorId,
			summary:
				kind === 'reservation'
					? 'Booking link added to Google'
					: 'Order link added to Google',
			request: { created: created.name, uri: url, placeActionType: type },
			result: 'accepted',
		})
	}
}

// ---------------------------------------------------------------------------
// "Make Menuza the preferred link" and Undo (#199)
// ---------------------------------------------------------------------------

export type PreferredError =
	| 'not_linked'
	| 'ordering_off'
	| 'reservations_off'
	| 'not_ready'
	| 'rejected'
	| 'nothing_to_change'

export type PreferredResult =
	| { ok: true; changeId: string; changed: number }
	| { ok: false; error: PreferredError; reason?: string }

type UndoOp =
	| { op: 'patch'; name: string; isPreferred: boolean }
	| { op: 'delete'; name: string }

/**
 * Sets Menuza's ordering page as the preferred order link (and the booking
 * page for reservations) after the operator confirmed. Previous links are not
 * removed, only no longer preferred, and the change is recorded so
 * `undoPreferredChange` can restore it. Never run while online ordering is
 * off.
 */
export async function makeMenuzaPreferred(input: {
	ctx: GbpContext
	actorId: string
	kinds: readonly ('order' | 'reservation')[]
	client?: GbpClient
	now?: Date
}): Promise<PreferredResult> {
	const { ctx } = input
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_linked' }
	if (ctx.sync.state !== 'ok' || ctx.sync.verificationState === 'unverified') {
		return { ok: false, error: 'not_ready' }
	}
	const wantsOrder = input.kinds.includes('order')
	const wantsReservation = input.kinds.includes('reservation')
	if (wantsOrder && !onlineOrderingOn(ctx.location)) {
		return { ok: false, error: 'ordering_off' }
	}
	if (
		wantsReservation &&
		!(await isReservationsFeatureEnabled(ctx.organization.id, 'enabled'))
	) {
		return { ok: false, error: 'reservations_off' }
	}
	const client = input.client ?? (await gbpClientFor(ctx.integration))
	const name = ctx.sync.googleLocationName
	const links = await client.listPlaceActionLinks(name)
	const origins = ownOrigins(ctx)
	const changeId = createId()
	const undo: UndoOp[] = []
	const previous: Array<{ kind: string; uri: string; name: string }> = []
	let changed = 0

	const targets: OrderLinkKind[] = []
	if (wantsOrder) {
		targets.push('order')
		// Pickup and delivery links the profile already has move with it.
		for (const kind of ['pickup', 'delivery'] as const) {
			if (
				links.some((link) => placeActionKind(link.placeActionType) === kind)
			) {
				targets.push(kind)
			}
		}
	}
	if (wantsReservation) targets.push('reservation')

	try {
		for (const kind of targets) {
			const type = placeActionTypeFor(kind)
			const url = ourUrlFor(input.ctx, kind)
			if (!url) continue
			const ofKind = links.filter((link) => link.placeActionType === type)
			const ours = ofKind.find(
				(link) =>
					classifyOrderLink(link.uri, origins).classification === 'direct',
			)
			if (ours?.isPreferred) continue
			for (const link of ofKind.filter((item) => item.isPreferred)) {
				previous.push({ kind, uri: link.uri, name: link.name })
				undo.push({ op: 'patch', name: link.name, isPreferred: true })
			}
			if (ours) {
				await client.patchPlaceActionLink(ours.name, { isPreferred: true })
				undo.push({ op: 'patch', name: ours.name, isPreferred: false })
			} else {
				const created = await client.createPlaceActionLink(name, {
					uri: url,
					placeActionType: type,
					isPreferred: true,
				})
				undo.push({ op: 'delete', name: created.name })
			}
			changed += 1
		}
	} catch (error) {
		// Put back whatever was already changed, then report.
		await applyUndo(client, undo.reverse()).catch(() => null)
		if (error instanceof GbpError) {
			return {
				ok: false,
				error: error.code === 'gbp_rejected' ? 'rejected' : 'not_ready',
				reason: error.reason || error.code,
			}
		}
		throw error
	}
	if (changed === 0) return { ok: false, error: 'nothing_to_change' }
	await recordGbpEvent({
		sync: ctx.sync,
		kind: 'links',
		field: 'preferred',
		actorId: input.actorId,
		summary: 'Menuza made the preferred link on Google',
		request: { changeId, previous, undo },
		result: 'accepted',
	})
	await refreshOrderLinks(ctx, { client, now: input.now })
	return { ok: true, changeId, changed }
}

async function applyUndo(client: GbpClient, ops: UndoOp[]) {
	for (const op of ops) {
		if (op.op === 'patch') {
			await client.patchPlaceActionLink(op.name, {
				isPreferred: op.isPreferred,
			})
		} else {
			await client.deletePlaceActionLink(op.name)
		}
	}
}

/** The latest confirmed change that has not been undone, if any. */
export async function lastPreferredChange(ctx: Pick<GbpContext, 'sync'>) {
	const events = await db
		.select()
		.from(GbpSyncEvent)
		.where(
			and(eq(GbpSyncEvent.syncId, ctx.sync.id), eq(GbpSyncEvent.kind, 'links')),
		)
		.orderBy(desc(GbpSyncEvent.createdAt))
		.limit(50)
	const undone = new Set<string>()
	for (const event of events) {
		if (event.field !== 'undo' || !event.request) continue
		try {
			const parsed = JSON.parse(event.request) as { undoes?: string }
			if (parsed.undoes) undone.add(parsed.undoes)
		} catch {
			// ignore a malformed row
		}
	}
	for (const event of events) {
		if (event.field !== 'preferred' || !event.request) continue
		try {
			const parsed = JSON.parse(event.request) as {
				changeId: string
				previous: Array<{ kind: string; uri: string; name: string }>
				undo: UndoOp[]
			}
			if (!undone.has(parsed.changeId)) {
				return { ...parsed, at: event.createdAt }
			}
		} catch {
			// ignore a malformed row
		}
		return null
	}
	return null
}

/** Puts the previous preferred links back (the "Undo" of the last change). */
export async function undoPreferredChange(input: {
	ctx: GbpContext
	actorId: string
	client?: GbpClient
	now?: Date
}): Promise<
	{ ok: true } | { ok: false; error: 'nothing_to_undo' | 'not_ready' }
> {
	const { ctx } = input
	if (!ctx.integration?.isActive) return { ok: false, error: 'not_ready' }
	const change = await lastPreferredChange(ctx)
	if (!change) return { ok: false, error: 'nothing_to_undo' }
	const client = input.client ?? (await gbpClientFor(ctx.integration))
	// Reverse order: restore the old preferred links before dropping ours.
	await applyUndo(client, [...change.undo].reverse())
	await recordGbpEvent({
		sync: ctx.sync,
		kind: 'links',
		field: 'undo',
		actorId: input.actorId,
		summary: 'Menuza undid the preferred link change',
		request: { undoes: change.changeId },
		result: 'accepted',
	})
	await refreshOrderLinks(ctx, { client, now: input.now })
	return { ok: true }
}

export { ORDER_LINK_KINDS }
