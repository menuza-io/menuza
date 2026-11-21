import { randomInt } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
	SHORT_LINK_CODE_ALPHABET,
	SHORT_LINK_CODE_LENGTH,
	isMessageId,
	shortLinkLocation,
	siteTargetPathSchema,
	utmSlug,
} from '@repo/common/short-links'
import {
	marketingMessages,
	shortLinkClicksDaily,
	shortLinks,
	type ShortLink,
	type ShortLinkKind,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'

/**
 * Short links (#159): `<site>/l/<code>` for texts, printed QR codes and links an
 * operator makes. A click is counted per link per day and nothing else: no
 * address, no user agent, no person. Targets are paths on the organization's
 * own site; an external URL cannot be created, and a stored row that is not a
 * site path redirects nowhere.
 */

/** Links an operator may make by hand (`kind: 'link'`). */
export const MAX_MANUAL_SHORT_LINKS = 1000
const DAY_MS = 24 * 60 * 60 * 1000

export class ShortLinkError extends Error {
	constructor(
		readonly code:
			'invalid_target' | 'too_many_links' | 'not_found' | 'code_unavailable',
	) {
		super(code)
	}
}

export function generateShortLinkCode(): string {
	let code = ''
	for (let i = 0; i < SHORT_LINK_CODE_LENGTH; i++) {
		code += SHORT_LINK_CODE_ALPHABET[randomInt(SHORT_LINK_CODE_ALPHABET.length)]
	}
	return code
}

export type NewShortLink = {
	kind: ShortLinkKind
	/** What made it (a print design, a campaign, a journey step); opaque. */
	ref?: string | null
	label?: string | null
	targetPath: string
	utmSource?: string | null
	utmMedium?: string | null
	utmCampaign?: string | null
	utmContent?: string | null
	campaignId?: string | null
	stepId?: string | null
}

function clean(value: string | null | undefined, max: number) {
	const text = value?.trim().slice(0, max)
	return text ? text : null
}

/**
 * Makes a link, or returns the one that already exists for `(kind, ref,
 * targetPath)`: a print's QR and every message of a broadcast share one link
 * per target, however many times it is asked for. A link without a `ref` is
 * always new.
 */
export async function ensureShortLink(
	db: TenantDatabase,
	input: NewShortLink,
): Promise<ShortLink> {
	const target = siteTargetPathSchema.safeParse(input.targetPath)
	if (!target.success) throw new ShortLinkError('invalid_target')
	const ref = clean(input.ref, 200)

	const existing = async () =>
		ref
			? db
					.select()
					.from(shortLinks)
					.where(
						and(
							eq(shortLinks.kind, input.kind),
							eq(shortLinks.ref, ref),
							eq(shortLinks.targetPath, target.data),
						),
					)
					.get()
			: undefined

	const found = await existing()
	if (found) return found

	if (input.kind === 'link') {
		const [row] = await db
			.select({ n: sql<number>`count(*)` })
			.from(shortLinks)
			.where(eq(shortLinks.kind, 'link'))
		if (Number(row?.n ?? 0) >= MAX_MANUAL_SHORT_LINKS) {
			throw new ShortLinkError('too_many_links')
		}
	}

	for (let attempt = 0; attempt < 6; attempt++) {
		const inserted = await db
			.insert(shortLinks)
			.values({
				code: generateShortLinkCode(),
				kind: input.kind,
				ref,
				label: clean(input.label, 120),
				targetPath: target.data,
				utmSource: clean(input.utmSource, 100),
				utmMedium: clean(input.utmMedium, 100),
				utmCampaign: clean(input.utmCampaign, 100),
				utmContent: clean(input.utmContent, 100),
				campaignId: clean(input.campaignId, 100),
				stepId: clean(input.stepId, 100),
			})
			// A taken code (or a racing twin for the same ref) inserts nothing.
			.onConflictDoNothing()
			.returning()
		if (inserted[0]) return inserted[0]
		const twin = await existing()
		if (twin) return twin
	}
	throw new ShortLinkError('code_unavailable')
}

export type ShortLinkResolution =
	| { status: 'ok'; location: string; linkId: string }
	| { status: 'disabled' }
	| { status: 'not_found' }

/** `YYYY-MM-DD` in UTC. */
export function clickDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Looks a code up, counts the click and says where it goes. `count: false`
 * (a bot, or a visitor over the limit, as Sites decided; neither is stored)
 * resolves without counting. `messageId` marks that recipient's text as
 * clicked, only while it belongs to the same campaign as the link.
 */
export async function resolveShortLink(
	db: TenantDatabase,
	code: string,
	options: { messageId?: string | null; count?: boolean; now?: number } = {},
): Promise<ShortLinkResolution> {
	const now = options.now ?? Date.now()
	const link = await db
		.select()
		.from(shortLinks)
		.where(eq(shortLinks.code, code))
		.get()
	if (!link) return { status: 'not_found' }
	if (link.disabledAt) return { status: 'disabled' }
	const location = shortLinkLocation({
		targetPath: link.targetPath,
		utmSource: link.utmSource,
		utmMedium: link.utmMedium,
		utmCampaign: link.utmCampaign,
		utmContent: link.utmContent,
		campaignId: link.campaignId,
		stepId: link.stepId,
		linkId: link.id,
	})
	// A row that is not a path on the site never redirects.
	if (!location) return { status: 'not_found' }

	if (options.count !== false) {
		// One atomic upsert: two clicks at once are two counts.
		await db
			.insert(shortLinkClicksDaily)
			.values({ linkId: link.id, day: clickDay(now), clicks: 1 })
			.onConflictDoUpdate({
				target: [shortLinkClicksDaily.linkId, shortLinkClicksDaily.day],
				set: { clicks: sql`${shortLinkClicksDaily.clicks} + 1` },
			})
			.run()
		if (isMessageId(options.messageId)) {
			await markMessageClicked(db, link, options.messageId, now)
		}
	}
	return { status: 'ok', location, linkId: link.id }
}

async function markMessageClicked(
	db: TenantDatabase,
	link: ShortLink,
	messageId: string,
	now: number,
) {
	const message = await db
		.select({
			id: marketingMessages.id,
			campaignId: marketingMessages.campaignId,
			channel: marketingMessages.channel,
			clickedAt: marketingMessages.clickedAt,
		})
		.from(marketingMessages)
		.where(eq(marketingMessages.id, messageId))
		.get()
	if (!message || message.channel !== 'sms') return
	// A message id belongs to its own link: a copied `?m=` on another link does nothing.
	if (
		link.campaignId &&
		message.campaignId &&
		link.campaignId !== message.campaignId
	) {
		return
	}
	await db
		.update(marketingMessages)
		.set({
			clickedAt: message.clickedAt ?? new Date(now),
			status: sql`CASE WHEN ${marketingMessages.status} IN ('Sent', 'Processing', 'Opened') THEN 'Clicked' ELSE ${marketingMessages.status} END`,
		})
		.where(eq(marketingMessages.id, messageId))
		.run()
}

export type ShortLinkView = {
	id: string
	code: string
	kind: ShortLinkKind
	ref: string | null
	label: string | null
	targetPath: string
	utmSource: string | null
	utmMedium: string | null
	utmCampaign: string | null
	utmContent: string | null
	disabled: boolean
	createdAt: number
	clicksThisMonth: number
	clicksTotal: number
	/** The last 30 days, oldest first, a zero where nobody clicked. */
	daily: Array<{ day: string; clicks: number }>
}

function monthStart(now: number) {
	return `${clickDay(now).slice(0, 7)}-01`
}

/** Links with their counts: this month, in total and per day for 30 days. */
export async function listShortLinks(
	db: TenantDatabase,
	options: { kind?: ShortLinkKind; ids?: readonly string[]; now?: number } = {},
): Promise<ShortLinkView[]> {
	const now = options.now ?? Date.now()
	const rows = options.ids
		? await queryInChunks([...options.ids], (chunk) =>
				db.select().from(shortLinks).where(inArray(shortLinks.id, chunk)),
			)
		: await db
				.select()
				.from(shortLinks)
				.where(options.kind ? eq(shortLinks.kind, options.kind) : undefined)
				.orderBy(desc(shortLinks.createdAt), asc(shortLinks.id))
				.limit(500)
	if (rows.length === 0) return []
	const ids = rows.map((row) => row.id)
	const month = monthStart(now)
	const clicks = await queryInChunks(ids, (chunk) =>
		db
			.select()
			.from(shortLinkClicksDaily)
			.where(inArray(shortLinkClicksDaily.linkId, chunk)),
	)
	const byLink = new Map<string, typeof clicks>()
	for (const click of clicks) {
		const list = byLink.get(click.linkId) ?? []
		list.push(click)
		byLink.set(click.linkId, list)
	}
	const days = Array.from({ length: 30 }, (_, i) =>
		clickDay(now - (29 - i) * DAY_MS),
	)
	return rows.map((row) => {
		const own = byLink.get(row.id) ?? []
		const perDay = new Map(own.map((click) => [click.day, click.clicks]))
		return {
			id: row.id,
			code: row.code,
			kind: row.kind,
			ref: row.ref,
			label: row.label,
			targetPath: row.targetPath,
			utmSource: row.utmSource,
			utmMedium: row.utmMedium,
			utmCampaign: row.utmCampaign,
			utmContent: row.utmContent,
			disabled: Boolean(row.disabledAt),
			createdAt: row.createdAt.getTime(),
			clicksThisMonth: own
				.filter((click) => click.day >= month)
				.reduce((sum, click) => sum + click.clicks, 0),
			clicksTotal: own.reduce((sum, click) => sum + click.clicks, 0),
			daily: days.map((day) => ({ day, clicks: perDay.get(day) ?? 0 })),
		}
	})
}

export async function setShortLinkState(
	db: TenantDatabase,
	id: string,
	patch: { disabled?: boolean; label?: string | null },
	now = Date.now(),
): Promise<boolean> {
	const set: Partial<typeof shortLinks.$inferInsert> = {}
	if (patch.disabled !== undefined) {
		set.disabledAt = patch.disabled ? new Date(now) : null
	}
	if (patch.label !== undefined) set.label = clean(patch.label, 120)
	if (Object.keys(set).length === 0) return true
	const rows = await db
		.update(shortLinks)
		.set(set)
		.where(eq(shortLinks.id, id))
		.returning({ id: shortLinks.id })
	return rows.length > 0
}

/** The name a campaign's links carry in `utm_campaign`. */
export function campaignUtm(
	name: string | null | undefined,
	fallbackId: string,
) {
	return utmSlug(name) ?? fallbackId.slice(0, 60)
}

/**
 * Whether a link id exists (an order's attribution keeps only ids that do). A
 * link disabled since the click still counts: the guest did follow it.
 */
export async function shortLinkExists(db: TenantDatabase, id: string) {
	const row = await db
		.select({ id: shortLinks.id })
		.from(shortLinks)
		.where(eq(shortLinks.id, id))
		.get()
	return Boolean(row)
}
