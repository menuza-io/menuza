import {
	customFontsOf,
	FONT_LICENCE_VERSION,
	fontLicenceDecision,
	sha256Hex,
	type FontRole,
} from '@repo/common/font-licence'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	isNull,
	FontLicenceAcceptance,
	Organization,
	User,
} from '@repo/database'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { updateSiteTheme, updateSiteThemeDraft } from './site-theme.server.ts'

/**
 * Font licence confirmation (#286): the upload is refused until the member
 * ticks the agreement (`font_agreement_required`), the acceptance is recorded
 * per upload with who, when and which file (name and hash), Design shows the
 * uploader, and a font can be removed so the site falls back at once.
 */

export async function acceptedFontLicenceVersions(
	organizationId: string,
	userId: string,
) {
	const rows = await db
		.select({ version: FontLicenceAcceptance.agreementVersion })
		.from(FontLicenceAcceptance)
		.where(
			and(
				eq(FontLicenceAcceptance.organizationId, organizationId),
				eq(FontLicenceAcceptance.userId, userId),
			),
		)
	return [...new Set(rows.map((row) => row.version))]
}

/** `font_agreement_required` unless this member accepted, or ticks, the current text. */
export async function checkFontLicence(input: {
	organizationId: string
	userId: string
	ticked: unknown
	tickedVersion: unknown
}) {
	return fontLicenceDecision({
		acceptedVersions: await acceptedFontLicenceVersions(
			input.organizationId,
			input.userId,
		),
		ticked: input.ticked,
		tickedVersion: input.tickedVersion,
	})
}

export async function recordFontLicence(input: {
	organizationId: string
	userId: string
	role: FontRole
	fileName: string
	fileHash: string
	objectKey: string
}) {
	await db.insert(FontLicenceAcceptance).values({
		organizationId: input.organizationId,
		userId: input.userId,
		agreementVersion: FONT_LICENCE_VERSION,
		role: input.role,
		fileName: input.fileName.slice(0, 180),
		fileHash: input.fileHash,
		objectKey: input.objectKey,
	})
}

/** The hash of a stored font, or null when the object cannot be read. */
async function hashStoredFont(organizationId: string, objectKey: string) {
	try {
		const { url, headers } = await getSignedGetRequestInfoAsync(
			objectKey,
			organizationId,
		)
		const response = await fetch(url, { headers })
		if (!response.ok) return null
		return await sha256Hex(new Uint8Array(await response.arrayBuffer()))
	} catch {
		return null
	}
}

/**
 * A font that was uploaded before the agreement existed: its uploader is
 * asked to confirm at the next visit to Design (#286). Records the
 * confirmation for the file that is in the theme now.
 */
export async function confirmExistingFontLicence(input: {
	organizationId: string
	userId: string
	role: FontRole
	themeJson: string | null
}) {
	const font = customFontsOf(input.themeJson).find(
		(candidate) => candidate.role === input.role,
	)
	if (!font) return { ok: false as const }
	const fileHash =
		(await hashStoredFont(input.organizationId, font.objectKey)) ??
		'unavailable'
	await recordFontLicence({
		organizationId: input.organizationId,
		userId: input.userId,
		role: input.role,
		fileName: font.filename,
		fileHash,
		objectKey: font.objectKey,
	})
	return { ok: true as const }
}

export type FontLicenceStatus = {
	version: number
	/** The signed-in member already accepted this version. */
	accepted: boolean
	fonts: Partial<
		Record<
			FontRole,
			{
				fileName: string
				/** Who uploaded it; null for a font from before the agreement. */
				uploader: string | null
				uploadedAt: string | null
				/** No acceptance on record: someone must confirm the licence. */
				needsConfirmation: boolean
			}
		>
	>
}

/** What Website, Design shows: per custom font, its uploader and date. */
export async function fontLicenceStatus(input: {
	organizationId: string
	userId: string
	/** The theme the editor shows (draft, else live). */
	themeJson: string | null
}): Promise<FontLicenceStatus> {
	const fonts = customFontsOf(input.themeJson)
	const accepted = (
		await acceptedFontLicenceVersions(input.organizationId, input.userId)
	).includes(FONT_LICENCE_VERSION)
	const status: FontLicenceStatus = {
		version: FONT_LICENCE_VERSION,
		accepted,
		fonts: {},
	}
	if (fonts.length === 0) return status
	const rows = await db
		.select({
			objectKey: FontLicenceAcceptance.objectKey,
			acceptedAt: FontLicenceAcceptance.acceptedAt,
			userId: FontLicenceAcceptance.userId,
			name: User.name,
			username: User.username,
		})
		.from(FontLicenceAcceptance)
		.leftJoin(User, eq(User.id, FontLicenceAcceptance.userId))
		.where(
			and(
				eq(FontLicenceAcceptance.organizationId, input.organizationId),
				inArray(
					FontLicenceAcceptance.objectKey,
					fonts.map((font) => font.objectKey),
				),
				isNull(FontLicenceAcceptance.removedAt),
			),
		)
		.orderBy(desc(FontLicenceAcceptance.acceptedAt))
	for (const font of fonts) {
		const row = rows.find((candidate) => candidate.objectKey === font.objectKey)
		status.fonts[font.role] = {
			fileName: font.filename,
			uploader: row ? (row.name ?? row.username ?? null) : null,
			uploadedAt: row ? row.acceptedAt.toISOString() : null,
			needsConfirmation: !row,
		}
	}
	return status
}

/**
 * Takes a custom font off the site (owner "Remove font", #286): both the live
 * and the draft theme go back to the theme font, so the site falls back at
 * once without a publish (fonts are loaded by reference). The acceptance rows
 * of that file are kept and marked removed.
 */
export async function removeSiteFont(input: {
	organizationId: string
	role: FontRole
	userId: string
	reason?: string
}) {
	const [org] = await db
		.select({
			siteTheme: Organization.siteTheme,
			draftSiteTheme: Organization.draftSiteTheme,
		})
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!org) return
	const keys = new Set(
		[...customFontsOf(org.siteTheme), ...customFontsOf(org.draftSiteTheme)]
			.filter((font) => font.role === input.role)
			.map((font) => font.objectKey),
	)
	const clear = (
		current: Parameters<Parameters<typeof updateSiteTheme>[1]>[0],
	) => ({
		...current,
		[input.role === 'heading' ? 'headingFont' : 'bodyFont']: 'inter' as const,
		[input.role === 'heading' ? 'headingCustomFont' : 'bodyCustomFont']: null,
	})
	// Live first, so a request between the two writes never reads the font.
	await updateSiteTheme(input.organizationId, clear)
	await updateSiteThemeDraft(input.organizationId, clear)
	if (keys.size > 0) {
		await db
			.update(FontLicenceAcceptance)
			.set({
				removedAt: new Date(),
				removedBy: 'owner',
				removedByUserId: input.userId,
				removedReason: input.reason ?? null,
			})
			.where(
				and(
					eq(FontLicenceAcceptance.organizationId, input.organizationId),
					inArray(FontLicenceAcceptance.objectKey, [...keys]),
					isNull(FontLicenceAcceptance.removedAt),
				),
			)
	}
}
