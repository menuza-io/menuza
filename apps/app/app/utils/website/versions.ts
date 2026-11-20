/**
 * Pure helpers for website versions (#85): how a page's sections are compared,
 * hashed and summarised. Nothing here touches the database, so the badge, the
 * history list and the restore check all agree on what "changed" means.
 */

/** At most this many versions are kept per page and per site chrome or theme. */
export const MAX_WEBSITE_VERSIONS = 50

/** Versions of a deleted page are kept this long, then purged. */
export const DELETED_PAGE_VERSION_DAYS = 30

export type WebsiteVersionKind = 'page' | 'chrome' | 'theme'

/** The part of a section that decides whether the page changed. */
export type SectionLike = { type: string; config: string }

/** Sections as the public site serves them (`WebsitePage.publishedData`). */
export type SnapshotSection = SectionLike & {
	id?: string
	position?: number
}

export type ChromeSnapshot = { header: string | null; footer: string | null }

/** Counts of what a publish changed against the version before it. */
export type VersionSummary = {
	added: number
	removed: number
	changed: number
	total: number
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, inner]) => [key, sortKeys(inner)]),
		)
	}
	return value
}

/** A config string with its keys in a fixed order, so equal content is equal text. */
export function canonicalJson(raw: string | null | undefined): string {
	if (raw === null || raw === undefined) return ''
	try {
		return JSON.stringify(sortKeys(JSON.parse(raw)))
	} catch {
		return raw
	}
}

function entryOf(section: SectionLike) {
	return `${section.type}\u0000${canonicalJson(section.config)}`
}

/**
 * The text a page's body sections hash from: their types and configs in
 * order. Ids and positions are left out on purpose, so a draft rebuilt from a
 * version (new row ids) still equals the content it came from.
 */
export function canonicalSections(sections: readonly SectionLike[]): string {
	return JSON.stringify(
		sections.map((section) => [section.type, canonicalJson(section.config)]),
	)
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export function hashSections(sections: readonly SectionLike[]) {
	return sha256Hex(canonicalSections(sections))
}

export function hashChrome(chrome: ChromeSnapshot) {
	return sha256Hex(
		JSON.stringify([
			canonicalJson(chrome.header),
			canonicalJson(chrome.footer),
		]),
	)
}

export function hashTheme(theme: string | null | undefined) {
	return sha256Hex(canonicalJson(theme))
}

/** Parses a stored snapshot of sections; a damaged one counts as empty. */
export function parseSnapshotSections(
	raw: string | null | undefined,
): SnapshotSection[] {
	if (!raw) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.flatMap((item): SnapshotSection[] => {
			if (!item || typeof item !== 'object') return []
			const { id, type, position, config } = item as Record<string, unknown>
			if (typeof type !== 'string') return []
			return [
				{
					id: typeof id === 'string' ? id : undefined,
					type,
					position: typeof position === 'number' ? position : undefined,
					config: typeof config === 'string' ? config : '{}',
				},
			]
		})
	} catch {
		return []
	}
}

export function parseChromeSnapshot(
	raw: string | null | undefined,
): ChromeSnapshot {
	if (!raw) return { header: null, footer: null }
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		return {
			header: typeof parsed.header === 'string' ? parsed.header : null,
			footer: typeof parsed.footer === 'string' ? parsed.footer : null,
		}
	} catch {
		return { header: null, footer: null }
	}
}

/**
 * What changed between two lists of sections: sections only in `next` are
 * added, only in `previous` removed, and a removed and an added section of the
 * same type pair up as one changed section.
 */
export function summarizeSectionChange(
	previous: readonly SectionLike[],
	next: readonly SectionLike[],
): VersionSummary {
	const remaining = new Map<string, number>()
	for (const section of previous) {
		const entry = entryOf(section)
		remaining.set(entry, (remaining.get(entry) ?? 0) + 1)
	}
	const addedTypes: string[] = []
	for (const section of next) {
		const entry = entryOf(section)
		const count = remaining.get(entry) ?? 0
		if (count > 0) remaining.set(entry, count - 1)
		else addedTypes.push(section.type)
	}
	const removedTypes: string[] = []
	for (const [entry, count] of remaining) {
		for (let i = 0; i < count; i++) removedTypes.push(entry.split('\u0000')[0]!)
	}
	let changed = 0
	for (const type of [...addedTypes]) {
		const at = removedTypes.indexOf(type)
		if (at >= 0) {
			removedTypes.splice(at, 1)
			addedTypes.splice(addedTypes.indexOf(type), 1)
			changed++
		}
	}
	return {
		added: addedTypes.length,
		removed: removedTypes.length,
		changed,
		total: next.length,
	}
}

export function parseVersionSummary(
	raw: string | null | undefined,
): VersionSummary | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const num = (value: unknown) =>
			typeof value === 'number' && Number.isFinite(value) ? value : 0
		return {
			added: num(parsed.added),
			removed: num(parsed.removed),
			changed: num(parsed.changed),
			total: num(parsed.total),
		}
	} catch {
		return null
	}
}

export type PageDraftState = {
	/** The page has no published snapshot at all (nothing to compare with). */
	neverPublished: boolean
	/** The page is public and its draft differs from what is public. */
	hasUnpublishedChanges: boolean
	draftHash: string
	liveHash: string | null
}

/**
 * Compares a page's working sections (its draft) with the snapshot the public
 * site serves. A page that is not public shows no badge: it is a draft.
 */
export async function pageDraftState(input: {
	status: string
	publishedData: string | null
	draftSections: readonly SectionLike[]
}): Promise<PageDraftState> {
	const draftHash = await hashSections(input.draftSections)
	if (input.publishedData === null) {
		return {
			neverPublished: true,
			hasUnpublishedChanges: false,
			draftHash,
			liveHash: null,
		}
	}
	const liveHash = await hashSections(
		parseSnapshotSections(input.publishedData),
	)
	return {
		neverPublished: false,
		hasUnpublishedChanges:
			input.status === 'published' && draftHash !== liveHash,
		draftHash,
		liveHash,
	}
}

/** The draft of a site-wide value, or the live value while there is none. */
export function draftOrLive(
	draft: string | null | undefined,
	live: string | null | undefined,
): string | null {
	return draft ?? live ?? null
}

/**
 * Whether the site design (header, footer, theme) has unpublished changes:
 * a draft column that is set and differs from the live one.
 */
export function siteDesignChanges(org: {
	siteHeaderConfig: string | null
	siteFooterConfig: string | null
	siteTheme: string | null
	draftHeaderConfig: string | null
	draftFooterConfig: string | null
	draftSiteTheme: string | null
}) {
	const differs = (draft: string | null, live: string | null) =>
		draft !== null && canonicalJson(draft) !== canonicalJson(live)
	const header = differs(org.draftHeaderConfig, org.siteHeaderConfig)
	const footer = differs(org.draftFooterConfig, org.siteFooterConfig)
	const theme = differs(org.draftSiteTheme, org.siteTheme)
	return {
		header,
		footer,
		chrome: header || footer,
		theme,
		any: header || footer || theme,
	}
}
