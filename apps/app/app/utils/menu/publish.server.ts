import {
	db,
	eq,
	and,
	desc,
	Integration,
	OrganizationMenu,
	OrganizationMenuChannelState,
	OrganizationMenuPublish,
	OrganizationMenuPublished,
} from '@repo/database'
import {
	isPosProvider,
	providerKind,
	providerNames,
	providerWriteMode,
	pushMenu,
	type PosProvider,
} from '@repo/integrations'
import {
	collectLiveMenuContent,
	encodeMenuSnapshot,
} from '#app/utils/menu/public-projection.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * Master-menu publishing: the Menuza menu is the source of truth. A publish
 * freezes the menu into a published snapshot (served to the storefront), and
 * fans the menu out to every selected connected channel (POS / delivery
 * platforms) using each provider's existing sync path.
 */

export type PublishChannel = {
	integrationId: string
	providerName: string
	/** Display name, e.g. "Uber Eats". */
	displayName: string
	kind: 'pos' | 'delivery'
	writeMode: 'item' | 'menu'
}

export type ChannelSyncStatus = {
	integrationId: string
	providerName: string
	displayName: string
	kind: 'pos' | 'delivery'
	writeMode: 'item' | 'menu'
	selected: boolean | null
	lastStatus: 'success' | 'error' | null
	lastError: string | null
	pushedCount: number | null
	lastSyncAt: Date | null
}

export type PublishTargetSummary = {
	type: 'storefront' | 'channel'
	name: string
	integrationId: string | null
	status: 'success' | 'error'
	pushed: number | null
	error: string | null
}

export type PublishResult = {
	menuId: string
	revision: number
	publishedAt: Date
	status: 'succeeded' | 'partial' | 'failed'
	targets: PublishTargetSummary[]
}

/** Every connected, write-capable POS/delivery channel for the organization. */
export async function listPublishChannels(
	organizationId: string,
): Promise<PublishChannel[]> {
	const integrations = await db
		.select({
			id: Integration.id,
			providerName: Integration.providerName,
		})
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
			),
		)

	const channels: PublishChannel[] = []
	for (const integration of integrations) {
		if (!isPosProvider(integration.providerName)) continue
		const providerName: PosProvider = integration.providerName
		const writeMode = providerWriteMode[providerName]
		if (writeMode === 'none') continue
		channels.push({
			integrationId: integration.id,
			providerName,
			displayName: providerNames[providerName],
			kind: providerKind[providerName],
			writeMode,
		})
	}
	return channels
}

/** The publish state a menu's UI needs: published snapshot + per-channel sync. */
export async function getMenuPublishState(
	organizationId: string,
	menuId: string,
) {
	const [published, channelRows, events] = await Promise.all([
		db
			.select({
				revision: OrganizationMenuPublished.revision,
				publishedAt: OrganizationMenuPublished.publishedAt,
			})
			.from(OrganizationMenuPublished)
			.where(
				and(
					eq(OrganizationMenuPublished.organizationId, organizationId),
					eq(OrganizationMenuPublished.menuId, menuId),
				),
			)
			.limit(1),
		db
			.select()
			.from(OrganizationMenuChannelState)
			.where(
				and(
					eq(OrganizationMenuChannelState.organizationId, organizationId),
					eq(OrganizationMenuChannelState.menuId, menuId),
				),
			),
		db
			.select({
				id: OrganizationMenuPublish.id,
				revision: OrganizationMenuPublish.revision,
				status: OrganizationMenuPublish.status,
				targets: OrganizationMenuPublish.targets,
				createdAt: OrganizationMenuPublish.createdAt,
			})
			.from(OrganizationMenuPublish)
			.where(
				and(
					eq(OrganizationMenuPublish.organizationId, organizationId),
					eq(OrganizationMenuPublish.menuId, menuId),
				),
			)
			.orderBy(desc(OrganizationMenuPublish.createdAt))
			.limit(10),
	])

	const channels = await listPublishChannels(organizationId)
	const stateByIntegration = new Map(
		channelRows.map((row) => [row.integrationId, row]),
	)

	const channelStatuses: ChannelSyncStatus[] = channels.map((channel) => {
		const state = stateByIntegration.get(channel.integrationId)
		return {
			...channel,
			selected: state?.selected ?? null,
			lastStatus: (state?.lastStatus as 'success' | 'error' | null) ?? null,
			lastError: state?.lastError ?? null,
			pushedCount: state?.pushedCount ?? null,
			lastSyncAt: state?.lastSyncAt ?? null,
		}
	})

	return {
		// null when the menu has never been published (storefront serves live).
		published: published[0] ?? null,
		channels: channelStatuses,
		events: events.map((event) => ({
			id: event.id,
			revision: event.revision,
			status: event.status,
			targets: safeParseTargets(event.targets),
			createdAt: event.createdAt.toISOString(),
		})),
	}
}

function safeParseTargets(raw: string): PublishTargetSummary[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as PublishTargetSummary[]) : []
	} catch {
		return []
	}
}

/** Records the outcome of syncing one channel (also used by manual syncs). */
export async function recordChannelSync(options: {
	organizationId: string
	menuId: string
	integrationId: string
	status: 'success' | 'error'
	pushedCount?: number | null
	error?: string | null
}) {
	const { organizationId, menuId, integrationId } = options
	await db
		.insert(OrganizationMenuChannelState)
		.values({
			organizationId,
			menuId,
			integrationId,
			lastStatus: options.status,
			lastError: options.error ?? null,
			pushedCount: options.pushedCount ?? null,
			lastSyncAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [
				OrganizationMenuChannelState.menuId,
				OrganizationMenuChannelState.integrationId,
			],
			set: {
				lastStatus: options.status,
				lastError: options.error ?? null,
				pushedCount: options.pushedCount ?? null,
				lastSyncAt: new Date(),
				updatedAt: new Date(),
			},
		})

	await db
		.update(Integration)
		.set({ lastSyncAt: new Date() })
		.where(eq(Integration.id, integrationId))
}

/** Remembers the publish-dialog selections per channel for next time. */
async function recordChannelSelections(
	organizationId: string,
	menuId: string,
	channels: PublishChannel[],
	selectedIntegrationIds: Set<string>,
) {
	for (const channel of channels) {
		const selected = selectedIntegrationIds.has(channel.integrationId)
		await db
			.insert(OrganizationMenuChannelState)
			.values({
				organizationId,
				menuId,
				integrationId: channel.integrationId,
				selected,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [
					OrganizationMenuChannelState.menuId,
					OrganizationMenuChannelState.integrationId,
				],
				set: { selected, updatedAt: new Date() },
			})
	}
}

export type PublishMenuOptions = {
	organizationId: string
	organizationSlug: string
	menuId: string
	/** Push the published snapshot to the storefront (purge site KV cache). */
	includeStorefront: boolean
	/** Integration ids of the channels to sync. Empty array = storefront only. */
	integrationIds: string[]
	userId: string | null
}

/**
 * Publishes a menu: freezes the live content into the published snapshot,
 * updates the storefront when selected, and fans the menu out to every
 * selected connected channel. Failures on individual targets never abort the
 * publish; they are recorded per target and reflected in the overall status.
 */
export async function publishMenu(
	options: PublishMenuOptions,
): Promise<PublishResult> {
	const {
		organizationId,
		organizationSlug,
		menuId,
		includeStorefront,
		integrationIds,
		userId,
	} = options

	const [menu] = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, menuId),
				eq(OrganizationMenu.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!menu) {
		throw new Response('Menu not found', { status: 404 })
	}

	const content = await collectLiveMenuContent(organizationId, menuId)
	if (!content) {
		throw new Response('Menu not found', { status: 404 })
	}

	// 1. Fan out to the selected targets. The published snapshot only advances
	// when the storefront is a target: channel-only publishes must not change
	// what customers see.
	const channels = await listPublishChannels(organizationId)
	const selectedChannels = channels.filter((channel) =>
		integrationIds.includes(channel.integrationId),
	)

	const targets: PublishTargetSummary[] = []
	let revision = 0

	if (includeStorefront) {
		const [existing] = await db
			.select({ revision: OrganizationMenuPublished.revision })
			.from(OrganizationMenuPublished)
			.where(eq(OrganizationMenuPublished.menuId, menuId))
			.limit(1)
		revision = (existing?.revision ?? 0) + 1
		const publishedAt = new Date()

		try {
			await db
				.insert(OrganizationMenuPublished)
				.values({
					organizationId,
					menuId,
					revision,
					content: encodeMenuSnapshot(content),
					publishedAt,
					publishedByUserId: userId,
					updatedAt: publishedAt,
				})
				.onConflictDoUpdate({
					target: OrganizationMenuPublished.menuId,
					set: {
						revision,
						content: encodeMenuSnapshot(content),
						publishedAt,
						publishedByUserId: userId,
						updatedAt: publishedAt,
					},
				})
			await purgeOrganizationSiteCache(organizationId, organizationSlug)
			targets.push({
				type: 'storefront',
				name: 'Website',
				integrationId: null,
				status: 'success',
				pushed: null,
				error: null,
			})
		} catch (error) {
			targets.push({
				type: 'storefront',
				name: 'Website',
				integrationId: null,
				status: 'error',
				pushed: null,
				error: error instanceof Error ? error.message : 'Unknown error',
			})
		}
	}

	for (const channel of selectedChannels) {
		try {
			const result = await pushMenu(
				channel.integrationId,
				organizationId,
				menuId,
			)
			await recordChannelSync({
				organizationId,
				menuId,
				integrationId: channel.integrationId,
				status: 'success',
				pushedCount: result.pushed,
			})
			targets.push({
				type: 'channel',
				name: channel.displayName,
				integrationId: channel.integrationId,
				status: 'success',
				pushed: result.pushed,
				error: null,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			await recordChannelSync({
				organizationId,
				menuId,
				integrationId: channel.integrationId,
				status: 'error',
				error: message,
			})
			targets.push({
				type: 'channel',
				name: channel.displayName,
				integrationId: channel.integrationId,
				status: 'error',
				pushed: null,
				error: message,
			})
		}
	}

	// Remember the dialog selections for the next publish.
	await recordChannelSelections(
		organizationId,
		menuId,
		channels,
		new Set(selectedChannels.map((channel) => channel.integrationId)),
	)

	// 2. Clear the dirty flag when the storefront was updated, and log the
	// publish event.
	const errored = targets.filter((target) => target.status === 'error').length
	const status: PublishResult['status'] =
		targets.length === 0 || errored === 0
			? 'succeeded'
			: errored === targets.length
				? 'failed'
				: 'partial'

	if (includeStorefront) {
		await db
			.update(OrganizationMenu)
			.set({ hasUnpublishedChanges: false })
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organizationId),
				),
			)
	}

	await db.insert(OrganizationMenuPublish).values({
		organizationId,
		menuId,
		revision,
		actorId: userId,
		status,
		targets: JSON.stringify(targets),
	})

	return {
		menuId,
		revision,
		publishedAt: new Date(),
		status,
		targets,
	}
}
