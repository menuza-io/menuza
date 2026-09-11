import { parseWithZod } from '@conform-to/zod'
import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans } from '@lingui/macro'
import { parseFormData } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'

import {
	getLocaleHref,
	getLocalizedEditableValue,
	isReservedSiteLocaleSlug,
	type LocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	CUSTOM_SITE_FONT_ID,
	parseSiteThemeConfig,
	serializeSiteThemeConfig,
	siteFontExtension,
	sniffSiteFontFormat,
} from '@repo/common/site-theme'
import {
	and,
	asc,
	db,
	desc,
	eq,
	gte,
	sql,
	Organization,
	OrganizationSiteAsset,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon, type IconName } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from '@repo/ui/resizable'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Spinner } from '@repo/ui/spinner'
import { Switch } from '@repo/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import * as cookie from 'cookie'
import {
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useParams,
	useSearchParams,
} from 'react-router'
import { z } from 'zod'
import {
	useAIPanel,
	useAIPanelHotkey,
} from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import {
	deleteSiteIconActionIntent,
	uploadSiteIconActionIntent,
} from '#app/components/settings/cards/organization/site-icon-card.tsx'
import {
	SiteThemeSchema,
	deleteSiteFontActionIntent,
	siteThemeActionIntent,
	uploadSiteFontActionIntent,
} from '#app/components/settings/cards/organization/site-theme-card.tsx'
import { BrandingPanel } from '#app/components/website/branding-panel.tsx'
import { CreatePageDialog } from '#app/components/website/create-page-dialog.tsx'
import {
	LinkInspector,
	SiteLinkBuilderContext,
} from '#app/components/website/link-inspector.tsx'
import {
	LocaleContext,
	LocaleSwitcher,
	LocalizedInput,
	LocalizedTextarea,
} from '#app/components/website/locale-fields.tsx'
import {
	TranslateAllButton,
	TranslateProvider,
	useSectionTranslator,
} from '#app/components/website/translate-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	uploadSiteFont,
	uploadSiteIcon,
	uploadWebsiteAsset,
	uploadWebsiteSeoImage,
} from '#app/utils/storage.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import {
	ADDABLE_BLOCK_TYPES,
	BLOCK_TYPES,
	composePageSectionsWithChrome,
	getDefaultConfig,
	isLockedBlockType,
	isSiteChromeId,
	parseBlockConfig,
	pinLockedChromeOrder,
	SITE_FOOTER_ID,
	SITE_HEADER_ID,
	type BlockType,
} from '#app/utils/website/block-types.ts'
import { HOME_PAGE_SLUG } from '#app/utils/website/home-page.ts'
import { ensureSiteChrome } from '#app/utils/website/locked-chrome.server.ts'
import { BULK_UPDATE_SECTIONS_INTENT } from '#app/utils/website/translation.ts'

// --- Action Intents ---
const updateTitleIntent = 'update-title'
const updatePageSettingsIntent = 'update-page-settings'
const uploadPageImageIntent = 'upload-page-image'
const uploadBlockAssetIntent = 'upload-block-asset'
const addSectionIntent = 'add-section'
const updateSectionIntent = 'update-section'
const bulkUpdateSectionsIntent = BULK_UPDATE_SECTIONS_INTENT
const removeSectionIntent = 'remove-section'
const moveSectionIntent = 'move-section'
const reorderSectionsIntent = 'reorder-sections'
const publishIntent = 'publish'
const unpublishIntent = 'unpublish'

function extensionForImageMime(mimeType: string): string {
	switch (mimeType) {
		case 'image/png':
			return 'png'
		case 'image/webp':
			return 'webp'
		case 'image/gif':
			return 'gif'
		case 'image/jpeg':
		case 'image/jpg':
		default:
			return 'jpg'
	}
}

function sanitizeHtmlImageUrl(value: string): string | null {
	const trimmed = value.trim()
	if (!trimmed) return null
	if (trimmed.startsWith('/')) return trimmed
	if (trimmed.startsWith('data:image/')) return trimmed
	try {
		const url = new URL(trimmed)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
		return url.toString()
	} catch {
		return null
	}
}

function guessImageMimeType(filename: string): string {
	const extension = filename.split('.').pop()?.toLowerCase()
	switch (extension) {
		case 'png':
			return 'image/png'
		case 'webp':
			return 'image/webp'
		case 'gif':
			return 'image/gif'
		case 'svg':
			return 'image/svg+xml'
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg'
		default:
			return ''
	}
}

const BLOCK_ASSET_MIME_TYPES = new Set([
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/svg+xml',
	'video/mp4',
	'video/webm',
	'video/quicktime',
	'application/pdf',
	'application/zip',
	'application/json',
	'text/plain',
	'text/csv',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const BLOCK_ASSET_EXTENSIONS = new Set([
	'jpg',
	'jpeg',
	'png',
	'webp',
	'gif',
	'svg',
	'mp4',
	'webm',
	'mov',
	'pdf',
	'zip',
	'json',
	'txt',
	'csv',
	'doc',
	'docx',
	'xls',
	'xlsx',
	'ppt',
	'pptx',
])

function guessAssetMimeType(filename: string, mimeType?: string): string {
	if (mimeType && mimeType !== 'application/octet-stream') return mimeType
	const extension = filename.split('.').pop()?.toLowerCase()
	switch (extension) {
		case 'svg':
			return 'image/svg+xml'
		case 'pdf':
			return 'application/pdf'
		case 'zip':
			return 'application/zip'
		case 'json':
			return 'application/json'
		case 'txt':
			return 'text/plain'
		case 'csv':
			return 'text/csv'
		case 'doc':
			return 'application/msword'
		case 'docx':
			return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		case 'xls':
			return 'application/vnd.ms-excel'
		case 'xlsx':
			return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		case 'ppt':
			return 'application/vnd.ms-powerpoint'
		case 'pptx':
			return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
		case 'mp4':
			return 'video/mp4'
		case 'webm':
			return 'video/webm'
		case 'mov':
			return 'video/quicktime'
		default:
			return guessImageMimeType(filename)
	}
}

function extensionForAsset(mimeType: string, filename: string): string {
	switch (mimeType) {
		case 'image/png':
			return 'png'
		case 'image/webp':
			return 'webp'
		case 'image/gif':
			return 'gif'
		case 'image/svg+xml':
			return 'svg'
		case 'video/mp4':
			return 'mp4'
		case 'video/webm':
			return 'webm'
		case 'video/quicktime':
			return 'mov'
		case 'application/pdf':
			return 'pdf'
		case 'application/zip':
			return 'zip'
		case 'application/json':
			return 'json'
		case 'text/plain':
			return 'txt'
		case 'text/csv':
			return 'csv'
		case 'application/msword':
			return 'doc'
		case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
			return 'docx'
		case 'application/vnd.ms-excel':
			return 'xls'
		case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
			return 'xlsx'
		case 'application/vnd.ms-powerpoint':
			return 'ppt'
		case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
			return 'pptx'
		case 'image/jpeg':
		case 'image/jpg':
			return 'jpg'
		default: {
			const fromName = filename.split('.').pop()?.toLowerCase()
			if (fromName && BLOCK_ASSET_EXTENSIONS.has(fromName)) return fromName
			return 'bin'
		}
	}
}

function isAllowedBlockAsset(filename: string, mimeType: string): boolean {
	if (BLOCK_ASSET_MIME_TYPES.has(mimeType)) return true
	const extension = filename.split('.').pop()?.toLowerCase()
	return Boolean(extension && BLOCK_ASSET_EXTENSIONS.has(extension))
}

const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function sanitizePageSlugInput(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-/, '')
}

function finalizePageSlug(value: string) {
	return sanitizePageSlugInput(value).replace(/-$/, '')
}

function isRootPageSlug(value: string) {
	return value === '' || value === 'home'
}

function isValidPageSlug(value: string, { allowEmpty = false } = {}) {
	if (value === '') return allowEmpty
	return PAGE_SLUG_PATTERN.test(value) && !isReservedSiteLocaleSlug(value)
}

function displayPageSlug(page: { slug: string; isHomePage: boolean }) {
	if (page.isHomePage && isRootPageSlug(page.slug)) return ''
	return page.slug
}

// --- Schemas ---
const UpdateTitleSchema = z.object({
	intent: z.literal(updateTitleIntent),
	title: z.string().min(1).max(200),
})

const UpdatePageSettingsSchema = z.object({
	intent: z.literal(updatePageSettingsIntent),
	slug: z
		.string()
		.max(200)
		.refine(
			(value) => value === '' || PAGE_SLUG_PATTERN.test(value),
			'URL must contain only lowercase letters, numbers, and hyphens',
		)
		.refine(
			(value) => value === '' || !isReservedSiteLocaleSlug(value),
			'URL slug cannot be a language code (e.g. en, ar, id)',
		)
		.optional(),
	seoTitle: z.string().max(400).optional(),
	seoDescription: z.string().max(2000).optional(),
	seoImageUrl: z
		.string()
		.max(2000)
		.refine(
			(value) => value === '' || sanitizeHtmlImageUrl(value) !== null,
			'Image URL must use http, https, or a relative path',
		)
		.optional(),
	seoNoIndex: z
		.union([z.boolean(), z.literal('true'), z.literal('false')])
		.transform((value) => value === true || value === 'true'),
})

const AddSectionSchema = z.object({
	intent: z.literal(addSectionIntent),
	type: z.string().min(1),
	position: z.coerce.number(),
	config: z.string().min(1).optional(),
})

const UpdateSectionSchema = z.object({
	intent: z.literal(updateSectionIntent),
	sectionId: z.string().min(1),
	config: z.string().min(1),
})

const BulkUpdateSectionsSchema = z.object({
	intent: z.literal(bulkUpdateSectionsIntent),
	sections: z.string().min(1),
})

const RemoveSectionSchema = z.object({
	intent: z.literal(removeSectionIntent),
	sectionId: z.string().min(1),
})

const MoveSectionSchema = z.object({
	intent: z.literal(moveSectionIntent),
	sectionId: z.string().min(1),
	direction: z.enum(['up', 'down']),
})

const ReorderSectionsSchema = z.object({
	intent: z.literal(reorderSectionsIntent),
	orderedIds: z.string().min(1),
})

// --- Loader ---
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
		customDomain: true,
		siteLocales: true,
		siteDefaultLocale: true,
		siteTheme: true,
		siteIconKey: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	await ensureSiteChrome(organization.id)

	const [chrome, page, sitePages] = await Promise.all([
		db
			.select({
				siteHeaderConfig: Organization.siteHeaderConfig,
				siteFooterConfig: Organization.siteFooterConfig,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
			.limit(1)
			.then((rows) => rows[0]),
		db.query.WebsitePage.findFirst({
			columns: {
				id: true,
				title: true,
				slug: true,
				status: true,
				isHomePage: true,
				seoTitle: true,
				seoDescription: true,
				seoImageUrl: true,
				seoNoIndex: true,
			},
			with: {
				sections: {
					columns: {
						id: true,
						type: true,
						config: true,
						position: true,
					},
					orderBy: (section, { asc }) => [asc(section.position)],
				},
			},
			where: (page, { and, eq }) =>
				and(
					eq(page.id, params.pageId!),
					eq(page.organizationId, organization.id),
				),
		}),
		db
			.select({
				id: WebsitePage.id,
				title: WebsitePage.title,
				slug: WebsitePage.slug,
				isHomePage: WebsitePage.isHomePage,
			})
			.from(WebsitePage)
			.where(eq(WebsitePage.organizationId, organization.id))
			.orderBy(
				desc(WebsitePage.isHomePage),
				asc(WebsitePage.position),
				asc(WebsitePage.createdAt),
			),
	])

	if (!page) {
		throw new Response('Page not found', { status: 404 })
	}

	const cookieHeader = request.headers.get('Cookie')
	const cookies = cookieHeader ? cookie.parse(cookieHeader) : {}

	let themeConfig = parseSiteThemeConfig(organization.siteTheme)
	if (cookies.epic_preview_theme) {
		try {
			themeConfig = JSON.parse(
				decodeURIComponent(cookies.epic_preview_theme),
			) as ReturnType<typeof parseSiteThemeConfig>
		} catch {}
	}

	const headerConfig =
		chrome?.siteHeaderConfig ?? JSON.stringify(getDefaultConfig('header'))
	const footerConfig =
		chrome?.siteFooterConfig ?? JSON.stringify(getDefaultConfig('footer'))
	let websiteForms: Array<{ id: string; name: string; status: string }> = []
	try {
		const { fetchTenant } = await getOperatorTenantClient(
			request,
			organization.slug,
		)
		const response = await fetchTenant('/operator/forms', {
			signal: AbortSignal.timeout(3000),
		})
		if (response.ok) {
			const payload = (await response.json()) as {
				forms?: Array<{ id: string; name: string; status: string }>
			}
			websiteForms = payload.forms ?? []
		}
	} catch {
		// The page editor remains usable while the regional data plane is offline.
	}

	return {
		organization,
		websiteForms,
		themeConfig,
		sitePages,
		page: {
			...page,
			sections: composePageSectionsWithChrome(
				(() => {
					if (cookies.epic_preview_sections) {
						try {
							return JSON.parse(
								decodeURIComponent(cookies.epic_preview_sections),
							) as typeof page.sections
						} catch {}
					}
					return page.sections
				})(),
				headerConfig,
				footerConfig,
			),
		},
	}
}

// --- Action ---
export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)

	const [page] = await db
		.select({
			id: WebsitePage.id,
			isHomePage: WebsitePage.isHomePage,
			slug: WebsitePage.slug,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.id, params.pageId!),
				eq(WebsitePage.organizationId, organization.id),
			),
		)
		.limit(1)

	if (!page) {
		return Response.json(
			{ status: 'error', error: 'Page not found' },
			{ status: 404 },
		)
	}

	const contentType = request.headers.get('content-type')
	if (contentType?.includes('multipart/form-data')) {
		const formData = await parseFormData(request, {
			maxFileSize: 1024 * 1024 * 50, // 50MB (allowing videos)
		})
		const intent = formData.get('intent')

		if (intent === uploadPageImageIntent) {
			const imageFile = formData.get('imageFile') as File | null
			if (!imageFile || !(imageFile instanceof File) || !imageFile.size) {
				return Response.json(
					{ status: 'error', error: 'A valid image file is required.' },
					{ status: 400 },
				)
			}

			const allowedTypes = [
				'image/jpeg',
				'image/jpg',
				'image/png',
				'image/webp',
				'image/gif',
			]
			const mimeType = imageFile.type || guessImageMimeType(imageFile.name)
			if (!allowedTypes.includes(mimeType)) {
				return Response.json(
					{
						status: 'error',
						error: 'Use a JPG, PNG, WebP, or GIF image',
					},
					{ status: 400 },
				)
			}

			try {
				// Use a safe filename — storage rejects common names like macOS
				// screenshots (narrow spaces, parentheses, etc.).
				const safeFile = new File(
					[imageFile],
					`page-image.${extensionForImageMime(mimeType)}`,
					{ type: mimeType, lastModified: Date.now() },
				)
				const objectKey = await uploadWebsiteSeoImage(
					organization.id,
					page.id,
					safeFile,
				)
				const seoImageUrl = `/resources/images?objectKey=${encodeURIComponent(objectKey)}`
				await db
					.update(WebsitePage)
					.set({ seoImageUrl })
					.where(eq(WebsitePage.id, page.id))
				await purgeOrganizationSiteCache(
					organization.id,
					organization.slug,
					organization.customDomain,
				)
				return Response.json({ status: 'success', seoImageUrl })
			} catch (error) {
				return Response.json(
					{
						status: 'error',
						error:
							error instanceof Error ? error.message : 'Failed to upload image',
					},
					{ status: 500 },
				)
			}
		}

		if (intent === uploadBlockAssetIntent) {
			const assetFile = formData.get('assetFile') as File | null
			if (!assetFile || !(assetFile instanceof File) || !assetFile.size) {
				return Response.json(
					{ status: 'error', error: 'A valid file is required.' },
					{ status: 400 },
				)
			}

			const mimeType = guessAssetMimeType(assetFile.name, assetFile.type)

			if (!isAllowedBlockAsset(assetFile.name, mimeType)) {
				return Response.json(
					{
						status: 'error',
						error:
							'Unsupported file type. Use an image, video, PDF, SVG, or common document.',
					},
					{ status: 400 },
				)
			}

			try {
				const ext = extensionForAsset(mimeType, assetFile.name)

				const safeFile = new File([assetFile], `asset.${ext}`, {
					type: mimeType || 'application/octet-stream',
					lastModified: Date.now(),
				})
				const objectKey = await uploadWebsiteAsset(
					organization.id,
					page.id,
					safeFile,
				)

				// Same URL structure as images
				const assetUrl = `/resources/images?objectKey=${encodeURIComponent(objectKey)}`

				return Response.json({ status: 'success', assetUrl })
			} catch (error) {
				return Response.json(
					{
						status: 'error',
						error:
							error instanceof Error ? error.message : 'Failed to upload asset',
					},
					{ status: 500 },
				)
			}
		}

		if (intent === uploadSiteIconActionIntent) {
			const iconFile = formData.get('iconFile') as File | null
			if (!iconFile || !(iconFile instanceof File) || iconFile.size <= 0) {
				return Response.json(
					{ status: 'error', error: 'No file provided' },
					{ status: 400 },
				)
			}
			if (iconFile.type !== 'image/png') {
				return Response.json(
					{ status: 'error', error: 'Only PNG images are accepted' },
					{ status: 400 },
				)
			}
			if (iconFile.size > 1024 * 1024 * 5) {
				return Response.json(
					{ status: 'error', error: 'Image size must be less than 5MB' },
					{ status: 400 },
				)
			}

			try {
				const siteIconKey = await uploadSiteIcon(organization.id, iconFile)
				await db
					.update(Organization)
					.set({ siteIconKey })
					.where(eq(Organization.id, organization.id))
				await invalidateUserOrganizationsCache(userId)
				await purgeOrganizationSiteCache(
					organization.id,
					organization.slug,
					organization.customDomain,
				)
				return Response.json({ status: 'success' })
			} catch (error) {
				return Response.json(
					{
						status: 'error',
						error:
							error instanceof Error
								? error.message
								: 'Failed to upload site icon',
					},
					{ status: 500 },
				)
			}
		}

		if (intent === uploadSiteFontActionIntent) {
			const role = formData.get('role')
			if (role !== 'heading' && role !== 'body') {
				return Response.json(
					{ status: 'error', error: 'Invalid font role' },
					{ status: 400 },
				)
			}
			const fontFile = formData.get('fontFile') as File | null
			if (!fontFile || !(fontFile instanceof File) || fontFile.size <= 0) {
				return Response.json(
					{ status: 'error', error: 'No file provided' },
					{ status: 400 },
				)
			}
			if (fontFile.size > 1024 * 1024 * 2) {
				return Response.json(
					{ status: 'error', error: 'Font size must be less than 2MB' },
					{ status: 400 },
				)
			}

			try {
				const bytes = new Uint8Array(await fontFile.arrayBuffer())
				const format = sniffSiteFontFormat(bytes)
				if (!format) {
					return Response.json(
						{
							status: 'error',
							error: 'Use a WOFF2, WOFF, TTF, or OTF file',
						},
						{ status: 400 },
					)
				}
				const safeFile = new File(
					[bytes],
					`${role}.${siteFontExtension(format)}`,
					{ type: fontFile.type, lastModified: Date.now() },
				)
				const objectKey = await uploadSiteFont(organization.id, role, safeFile)
				const [org] = await db
					.select({ siteTheme: Organization.siteTheme })
					.from(Organization)
					.where(eq(Organization.id, organization.id))
					.limit(1)
				const current = parseSiteThemeConfig(org?.siteTheme)
				const customFont = {
					objectKey,
					filename: fontFile.name.replace(/^.*[\\/]/, '').slice(0, 180),
					format,
				}
				await db
					.update(Organization)
					.set({
						siteTheme: serializeSiteThemeConfig({
							...current,
							headingFont:
								role === 'heading' ? CUSTOM_SITE_FONT_ID : current.headingFont,
							bodyFont:
								role === 'body' ? CUSTOM_SITE_FONT_ID : current.bodyFont,
							headingCustomFont:
								role === 'heading' ? customFont : current.headingCustomFont,
							bodyCustomFont:
								role === 'body' ? customFont : current.bodyCustomFont,
						}),
					})
					.where(eq(Organization.id, organization.id))
				await invalidateUserOrganizationsCache(userId)
				await purgeOrganizationSiteCache(
					organization.id,
					organization.slug,
					organization.customDomain,
				)
				return Response.json({ status: 'success' })
			} catch (error) {
				return Response.json(
					{
						status: 'error',
						error:
							error instanceof Error ? error.message : 'Failed to upload font',
					},
					{ status: 500 },
				)
			}
		}

		return Response.json(
			{ status: 'error', error: `Invalid multipart intent: ${intent}` },
			{ status: 400 },
		)
	}

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === updateTitleIntent) {
		const submission = parseWithZod(formData, { schema: UpdateTitleSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}
		await db
			.update(WebsitePage)
			.set({ title: submission.value.title })
			.where(eq(WebsitePage.id, page.id))
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === updatePageSettingsIntent) {
		const submission = parseWithZod(formData, {
			schema: UpdatePageSettingsSchema,
		})
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const { slug, seoTitle, seoDescription, seoImageUrl, seoNoIndex } =
			submission.value

		let nextSlug: string | undefined
		if (page.isHomePage) {
			if (slug !== undefined) {
				const requestedSlug = slug === '' ? HOME_PAGE_SLUG : slug

				if (requestedSlug !== HOME_PAGE_SLUG) {
					return Response.json({
						status: 'error',
						result: submission.reply({
							fieldErrors: {
								slug: ['The home page URL cannot be changed'],
							},
						}),
					})
				}
			}

			if (page.slug !== HOME_PAGE_SLUG) {
				nextSlug = HOME_PAGE_SLUG
			}
		} else if (slug !== undefined) {
			const requestedSlug = slug

			if (requestedSlug === '') {
				return Response.json({
					status: 'error',
					result: submission.reply({
						fieldErrors: {
							slug: ['URL slug is required'],
						},
					}),
				})
			}

			if (requestedSlug !== page.slug) {
				const [existing] = await db
					.select({
						id: WebsitePage.id,
						isHomePage: WebsitePage.isHomePage,
						slug: WebsitePage.slug,
					})
					.from(WebsitePage)
					.where(
						and(
							eq(WebsitePage.organizationId, organization.id),
							eq(WebsitePage.slug, requestedSlug),
						),
					)
					.limit(1)
				if (existing && existing.id !== page.id) {
					return Response.json({
						status: 'error',
						result: submission.reply({
							fieldErrors: {
								slug: ['Page URL already exists in this organization'],
							},
						}),
					})
				}
				nextSlug = requestedSlug
			}
		}

		await db
			.update(WebsitePage)
			.set({
				...(nextSlug !== undefined ? { slug: nextSlug } : {}),
				seoTitle: seoTitle?.trim() ? seoTitle : null,
				seoDescription: seoDescription?.trim() ? seoDescription : null,
				seoImageUrl: seoImageUrl?.trim() ? seoImageUrl.trim() : null,
				seoNoIndex,
			})
			.where(eq(WebsitePage.id, page.id))
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === addSectionIntent) {
		const submission = parseWithZod(formData, { schema: AddSectionSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const { type, position, config } = submission.value

		if (isLockedBlockType(type)) {
			return Response.json(
				{ status: 'error', error: 'Header and footer cannot be added' },
				{ status: 400 },
			)
		}
		if (!(type in BLOCK_TYPES)) {
			return Response.json(
				{ status: 'error', error: 'Unknown section type' },
				{ status: 400 },
			)
		}

		let sectionConfig = getDefaultConfig(type as BlockType)
		if (config) {
			try {
				const parsedConfig: unknown = JSON.parse(config)
				if (
					!parsedConfig ||
					typeof parsedConfig !== 'object' ||
					Array.isArray(parsedConfig)
				) {
					throw new Error('Section config must be a JSON object')
				}
				sectionConfig = {
					...sectionConfig,
					...(parsedConfig as Record<string, unknown>),
				}
			} catch {
				return Response.json(
					{ status: 'error', error: 'Invalid JSON section config' },
					{ status: 400 },
				)
			}
		}

		const existing = await db
			.select({
				type: WebsitePageSection.type,
				position: WebsitePageSection.position,
			})
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, page.id))
			.orderBy(asc(WebsitePageSection.position))
		const body = existing.filter((section) => !isLockedBlockType(section.type))
		const bodyPosition = Math.max(0, Math.min(position - 1, body.length))

		await db
			.update(WebsitePageSection)
			.set({ position: sql`${WebsitePageSection.position} + 1` })
			.where(
				and(
					eq(WebsitePageSection.pageId, page.id),
					gte(WebsitePageSection.position, bodyPosition),
				),
			)

		await db.insert(WebsitePageSection).values({
			pageId: page.id,
			type,
			position: bodyPosition,
			config: JSON.stringify(sectionConfig),
		})
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === updateSectionIntent) {
		const submission = parseWithZod(formData, { schema: UpdateSectionSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const { sectionId, config } = submission.value

		// Validate JSON
		try {
			JSON.parse(config)
		} catch {
			return Response.json(
				{ status: 'error', error: 'Invalid JSON config' },
				{ status: 400 },
			)
		}

		if (sectionId === SITE_HEADER_ID) {
			await db
				.update(Organization)
				.set({ siteHeaderConfig: config })
				.where(eq(Organization.id, organization.id))
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		}
		if (sectionId === SITE_FOOTER_ID) {
			await db
				.update(Organization)
				.set({ siteFooterConfig: config })
				.where(eq(Organization.id, organization.id))
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		}

		await db
			.update(WebsitePageSection)
			.set({ config })
			.where(
				and(
					eq(WebsitePageSection.id, sectionId),
					eq(WebsitePageSection.pageId, page.id),
				),
			)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === bulkUpdateSectionsIntent) {
		const submission = parseWithZod(formData, {
			schema: BulkUpdateSectionsSchema,
		})
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		try {
			const parsedUpdates = z
				.array(
					z.object({
						id: z.string().min(1).max(200),
						config: z.string().min(2).max(500_000),
					}),
				)
				.max(80)
				.safeParse(JSON.parse(submission.value.sections))

			if (!parsedUpdates.success) {
				return Response.json(
					{ status: 'error', error: 'Invalid section updates' },
					{ status: 400 },
				)
			}

			await db.transaction(async (tx) => {
				for (const update of parsedUpdates.data) {
					JSON.parse(update.config)

					if (update.id === SITE_HEADER_ID) {
						await tx
							.update(Organization)
							.set({ siteHeaderConfig: update.config })
							.where(eq(Organization.id, organization.id))
					} else if (update.id === SITE_FOOTER_ID) {
						await tx
							.update(Organization)
							.set({ siteFooterConfig: update.config })
							.where(eq(Organization.id, organization.id))
					} else {
						await tx
							.update(WebsitePageSection)
							.set({ config: update.config })
							.where(
								and(
									eq(WebsitePageSection.id, update.id),
									eq(WebsitePageSection.pageId, page.id),
								),
							)
					}
				}
			})
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		} catch {
			return Response.json(
				{ status: 'error', error: 'Invalid JSON config or update failed' },
				{ status: 400 },
			)
		}
	}

	if (intent === removeSectionIntent) {
		const submission = parseWithZod(formData, { schema: RemoveSectionSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const [target] = await db
			.select({ type: WebsitePageSection.type })
			.from(WebsitePageSection)
			.where(
				and(
					eq(WebsitePageSection.id, submission.value.sectionId),
					eq(WebsitePageSection.pageId, page.id),
				),
			)
			.limit(1)
		if (!target) {
			return Response.json(
				{ status: 'error', error: 'Section not found' },
				{ status: 404 },
			)
		}
		if (isLockedBlockType(target.type)) {
			return Response.json(
				{ status: 'error', error: 'Header and footer cannot be removed' },
				{ status: 400 },
			)
		}

		await db
			.delete(WebsitePageSection)
			.where(
				and(
					eq(WebsitePageSection.id, submission.value.sectionId),
					eq(WebsitePageSection.pageId, page.id),
				),
			)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === moveSectionIntent) {
		const submission = parseWithZod(formData, { schema: MoveSectionSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const { sectionId, direction } = submission.value

		const sections = await db
			.select({
				id: WebsitePageSection.id,
				type: WebsitePageSection.type,
				position: WebsitePageSection.position,
			})
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, page.id))
			.orderBy(asc(WebsitePageSection.position))

		const idx = sections.findIndex((s) => s.id === sectionId)
		if (idx === -1) {
			return Response.json(
				{ status: 'error', error: 'Section not found' },
				{ status: 404 },
			)
		}

		if (isLockedBlockType(sections[idx]?.type ?? '')) {
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		}

		const swapIdx = direction === 'up' ? idx - 1 : idx + 1
		if (swapIdx < 0 || swapIdx >= sections.length) {
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' }) // No-op at boundaries
		}
		if (isLockedBlockType(sections[swapIdx]?.type ?? '')) {
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		}

		const currentSection = sections[idx]
		const swapSection = sections[swapIdx]

		if (currentSection && swapSection) {
			// Swap positions
			await db.transaction(async (tx) => {
				await tx
					.update(WebsitePageSection)
					.set({ position: swapSection.position })
					.where(eq(WebsitePageSection.id, currentSection.id))
				await tx
					.update(WebsitePageSection)
					.set({ position: currentSection.position })
					.where(eq(WebsitePageSection.id, swapSection.id))
			})
		}

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === reorderSectionsIntent) {
		const submission = parseWithZod(formData, {
			schema: ReorderSectionsSchema,
		})
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		let orderedIds: string[]
		try {
			orderedIds = JSON.parse(submission.value.orderedIds) as string[]
		} catch {
			return Response.json(
				{ status: 'error', error: 'Invalid section order' },
				{ status: 400 },
			)
		}

		if (
			!Array.isArray(orderedIds) ||
			orderedIds.some((id) => typeof id !== 'string')
		) {
			return Response.json(
				{ status: 'error', error: 'Invalid section order' },
				{ status: 400 },
			)
		}

		const sections = await db
			.select({ id: WebsitePageSection.id, type: WebsitePageSection.type })
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, page.id))
		const bodySections = sections.filter(
			(section) => !isLockedBlockType(section.type),
		)
		const existingIds = new Set(bodySections.map((section) => section.id))
		const typesById = new Map(
			bodySections.map((section) => [section.id, section.type]),
		)
		typesById.set(SITE_HEADER_ID, 'header')
		typesById.set(SITE_FOOTER_ID, 'footer')
		const pinnedIds = pinLockedChromeOrder(orderedIds, typesById)
		const bodyIds = pinnedIds.filter((id) => !isSiteChromeId(id))

		if (
			bodyIds.length !== existingIds.size ||
			bodyIds.some((id) => !existingIds.has(id)) ||
			new Set(bodyIds).size !== bodyIds.length
		) {
			return Response.json(
				{ status: 'error', error: 'Invalid section order' },
				{ status: 400 },
			)
		}

		await db.transaction(async (tx) => {
			for (const [index, id] of bodyIds.entries()) {
				await tx
					.update(WebsitePageSection)
					.set({ position: index })
					.where(eq(WebsitePageSection.id, id))
			}
		})

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === publishIntent) {
		const themeData = formData.get('theme') as string | null
		const sections = await db
			.select({
				id: WebsitePageSection.id,
				type: WebsitePageSection.type,
				position: WebsitePageSection.position,
				config: WebsitePageSection.config,
			})
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, page.id))
			.orderBy(asc(WebsitePageSection.position))
		const publishedSections = sections.filter(
			(section) => !isLockedBlockType(section.type),
		)

		await db.transaction(async (tx) => {
			await tx
				.update(WebsitePage)
				.set({
					status: 'published',
					publishedData: JSON.stringify(publishedSections),
				})
				.where(eq(WebsitePage.id, page.id))

			if (themeData) {
				try {
					const theme = JSON.parse(themeData) as ReturnType<
						typeof parseSiteThemeConfig
					>
					const [org] = await tx
						.select({ siteTheme: Organization.siteTheme })
						.from(Organization)
						.where(eq(Organization.id, organization.id))
						.limit(1)
					const current = parseSiteThemeConfig(org?.siteTheme)
					await tx
						.update(Organization)
						.set({
							siteTheme: serializeSiteThemeConfig({
								...current,
								...theme,
							}),
						})
						.where(eq(Organization.id, organization.id))
				} catch {}
			}
		})
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === unpublishIntent) {
		if (page.isHomePage) {
			return Response.json({
				status: 'error',
				error: 'Cannot unpublish the home page',
			})
		}
		await db
			.update(WebsitePage)
			.set({ status: 'draft' })
			.where(eq(WebsitePage.id, page.id))
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}

	if (intent === siteThemeActionIntent) {
		const submission = parseWithZod(formData, { schema: SiteThemeSchema })
		if (submission.status !== 'success') {
			return Response.json({ status: 'error', result: submission.reply() })
		}

		const { baseColor, theme, radius, mode, headingFont, bodyFont, cssVars } =
			submission.value

		try {
			const [org] = await db
				.select({ siteTheme: Organization.siteTheme })
				.from(Organization)
				.where(eq(Organization.id, organization.id))
				.limit(1)
			const current = parseSiteThemeConfig(org?.siteTheme)
			await db
				.update(Organization)
				.set({
					siteTheme: serializeSiteThemeConfig({
						baseColor,
						theme,
						radius,
						mode,
						headingFont:
							headingFont === CUSTOM_SITE_FONT_ID && !current.headingCustomFont
								? current.headingFont
								: headingFont,
						bodyFont:
							bodyFont === CUSTOM_SITE_FONT_ID && !current.bodyCustomFont
								? current.bodyFont
								: bodyFont,
						headingCustomFont: current.headingCustomFont,
						bodyCustomFont: current.bodyCustomFont,
						cssVars:
							cssVars && Object.keys(cssVars).length > 0 ? cssVars : null,
					}),
				})
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		} catch {
			return Response.json(
				{ status: 'error', error: 'Failed to update theme' },
				{ status: 500 },
			)
		}
	}

	if (intent === deleteSiteIconActionIntent) {
		const orgId = formData.get('organizationId')
		if (orgId !== organization.id) {
			return Response.json(
				{ status: 'error', error: 'Organization mismatch' },
				{ status: 400 },
			)
		}

		try {
			await db
				.delete(OrganizationSiteAsset)
				.where(eq(OrganizationSiteAsset.organizationId, organization.id))
			await db
				.update(Organization)
				.set({ siteIconKey: null })
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		} catch {
			return Response.json(
				{ status: 'error', error: 'Failed to delete site icon' },
				{ status: 500 },
			)
		}
	}

	if (intent === deleteSiteFontActionIntent) {
		const orgId = formData.get('organizationId')
		const role = formData.get('role')
		if (orgId !== organization.id) {
			return Response.json(
				{ status: 'error', error: 'Organization mismatch' },
				{ status: 400 },
			)
		}
		if (role !== 'heading' && role !== 'body') {
			return Response.json(
				{ status: 'error', error: 'Invalid font role' },
				{ status: 400 },
			)
		}

		try {
			const [org] = await db
				.select({ siteTheme: Organization.siteTheme })
				.from(Organization)
				.where(eq(Organization.id, organization.id))
				.limit(1)
			const current = parseSiteThemeConfig(org?.siteTheme)
			await db
				.update(Organization)
				.set({
					siteTheme: serializeSiteThemeConfig({
						...current,
						headingFont: role === 'heading' ? 'inter' : current.headingFont,
						bodyFont: role === 'body' ? 'inter' : current.bodyFont,
						headingCustomFont:
							role === 'heading' ? null : current.headingCustomFont,
						bodyCustomFont: role === 'body' ? null : current.bodyCustomFont,
					}),
				})
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
			return Response.json({ status: 'success' })
		} catch {
			return Response.json(
				{ status: 'error', error: 'Failed to delete font' },
				{ status: 500 },
			)
		}
	}

	return Response.json(
		{ status: 'error', error: 'Invalid intent' },
		{ status: 400 },
	)
}

// ==============================================
// UI Components
// ==============================================

// --- Add Section Dialog ---
function AddSectionDialog({
	position,
	onAdd,
	trigger = 'button',
}: {
	position: number
	onAdd: (type: BlockType, position: number) => void
	trigger?: 'button' | 'insert' | 'footer' | 'link'
}) {
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<BlockType>(
		ADDABLE_BLOCK_TYPES[0]?.type ?? 'hero',
	)

	const confirmAdd = (type: BlockType = selected) => {
		onAdd(type, position)
		setOpen(false)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) setSelected(ADDABLE_BLOCK_TYPES[0]?.type ?? 'hero')
			}}
		>
			{trigger === 'insert' ? (
				<button
					type="button"
					className="group/insert relative -my-0.5 flex h-3.5 w-full items-center justify-center"
					onClick={() => setOpen(true)}
					aria-label="Insert section here"
				>
					<span className="bg-border absolute inset-x-3 h-px origin-center scale-x-0 opacity-0 transition duration-150 ease-out group-hover/insert:scale-x-100 group-hover/insert:opacity-100 group-focus-visible/insert:scale-x-100 group-focus-visible/insert:opacity-100" />
					<span className="border-border bg-background text-muted-foreground relative z-10 flex size-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition duration-150 ease-out group-hover/insert:opacity-100 group-focus-visible/insert:opacity-100">
						<Icon name="plus" className="size-3" />
					</span>
				</button>
			) : (
				<Button
					variant="outline"
					size="sm"
					className={cn(
						trigger === 'footer' && 'w-full justify-center',
						trigger === 'button' && 'border-dashed',
					)}
					onClick={() => setOpen(true)}
				>
					<Icon name="plus" className="size-3.5" />
					<Trans>Add section</Trans>
				</Button>
			)}
			<DialogContent className="gap-5 sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add section</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Pick a block to insert into your page.</Trans>
					</DialogDescription>
				</DialogHeader>

				<div
					role="listbox"
					aria-label="Section types"
					className="grid grid-cols-2 gap-2 sm:grid-cols-4"
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault()
							confirmAdd()
						}
					}}
				>
					{ADDABLE_BLOCK_TYPES.map((block) => {
						const isSelected = selected === block.type
						return (
							<button
								key={block.type}
								type="button"
								role="option"
								aria-selected={isSelected}
								onClick={() => setSelected(block.type)}
								onDoubleClick={() => confirmAdd(block.type)}
								className={cn(
									'group/tile border-border hover:bg-muted/50 focus-visible:ring-ring flex flex-col items-start gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2',
									isSelected
										? 'border-foreground/30 bg-muted'
										: 'bg-background',
								)}
							>
								<span
									className={cn(
										'flex size-9 items-center justify-center rounded-lg transition-colors',
										isSelected
											? 'bg-foreground text-background'
											: 'bg-muted text-muted-foreground group-hover/tile:text-foreground',
									)}
								>
									<Icon name={block.icon} className="size-4" />
								</span>
								<span className="min-w-0 space-y-1">
									<span className="block text-sm font-medium tracking-tight">
										{block.label}
									</span>
									<span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
										{block.description}
									</span>
								</span>
							</button>
						)
					})}
				</div>

				<DialogFooter className="gap-2 sm:items-center sm:justify-between">
					<p className="text-muted-foreground hidden text-xs sm:block">
						<Trans>Double-click a block to add it instantly</Trans>
					</p>
					<div className="flex gap-2">
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button onClick={() => confirmAdd()}>
							<Icon name="plus" className="size-4" />
							<span>
								<Trans>Add</Trans> {BLOCK_TYPES[selected].label}
							</span>
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// --- Section Preview Card ---
function SectionPreviewCard({
	section,
	isSelected,
	onSelect,
	onRemove,
	dragHandle,
	isDragging = false,
	locked = false,
}: {
	section: { id: string; type: string; config: string; position: number }
	isSelected: boolean
	onSelect: () => void
	onRemove: () => void
	dragHandle?: ReactNode
	isDragging?: boolean
	locked?: boolean
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const blockDef = BLOCK_TYPES[section.type as BlockType]
	const config = parseBlockConfig(section.config)
	const preview = previewText(
		section.type as BlockType,
		config,
		activeLocale,
		defaultLocale,
	)

	return (
		<div
			className={cn(
				'group relative cursor-pointer rounded-lg px-2 py-2 transition-colors duration-150',
				isSelected ? 'bg-muted' : 'hover:bg-muted/60 focus-within:bg-muted/60',
			)}
			onClick={onSelect}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					onSelect()
				}
			}}
		>
			<div className="flex items-start gap-2">
				<span className="border-border/70 bg-background text-muted-foreground relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border">
					{dragHandle}
					<Icon
						name={(blockDef?.icon ?? 'blocks') as IconName}
						className={cn(
							'size-3.5 transition-opacity duration-150',
							!locked && 'group-hover:opacity-0 peer-focus-visible:opacity-0',
							isDragging && 'opacity-0',
						)}
					/>
				</span>
				<div className="min-w-0 flex-1 pr-8">
					<div className="flex min-w-0 items-center gap-1.5">
						<div className="truncate text-sm font-medium">
							{blockDef?.label ?? section.type}
						</div>
						{locked ? (
							<Icon
								name="lock"
								className="text-muted-foreground size-3 shrink-0"
								aria-label="Same on every page"
							/>
						) : null}
					</div>
					{preview ? (
						<p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
							{preview}
						</p>
					) : null}
				</div>
			</div>

			{locked ? null : (
				<div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
					<Button
						variant="ghost"
						size="icon-xs"
						className="text-destructive hover:text-destructive"
						aria-label="Remove section"
						onClick={(e) => {
							e.stopPropagation()
							onRemove()
						}}
					>
						<Icon name="trash-2" className="size-3.5" />
					</Button>
				</div>
			)}
		</div>
	)
}

function SortableSectionCard({
	section,
	isSelected,
	onSelect,
	onRemove,
}: {
	section: { id: string; type: string; config: string; position: number }
	isSelected: boolean
	onSelect: () => void
	onRemove: () => void
}) {
	const locked = isLockedBlockType(section.type)
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: section.id, disabled: locked })

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(isDragging && 'z-10 opacity-80')}
		>
			<SectionPreviewCard
				section={section}
				isSelected={isSelected}
				onSelect={onSelect}
				onRemove={onRemove}
				isDragging={isDragging}
				locked={locked}
				dragHandle={
					locked ? undefined : (
						<button
							type="button"
							ref={setActivatorNodeRef}
							className={cn(
								'text-muted-foreground hover:text-foreground peer pointer-events-none absolute inset-0 z-10 flex cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity duration-150 active:cursor-grabbing',
								'group-hover:pointer-events-auto group-hover:opacity-100',
								'focus-visible:pointer-events-auto focus-visible:opacity-100',
								isDragging && 'pointer-events-auto opacity-100',
							)}
							aria-label="Drag to reorder"
							{...attributes}
							{...listeners}
						>
							<Icon name="grip-vertical" className="size-3.5" />
						</button>
					)
				}
			/>
		</div>
	)
}

function SectionsList({
	sections,
	selectedSectionId,
	onSelect,
	onRemove,
	onReorder,
	onAdd,
}: {
	sections: Array<{
		id: string
		type: string
		config: string
		position: number
	}>
	selectedSectionId: string | null
	onSelect: (sectionId: string) => void
	onRemove: (sectionId: string) => void
	onReorder: (orderedIds: string[]) => void
	onAdd: (type: BlockType, position: number) => void
}) {
	const dndId = useId()
	const [items, setItems] = useState(sections)
	const [isDragging, setIsDragging] = useState(false)

	useEffect(() => {
		setItems(sections)
	}, [sections])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setIsDragging(false)
		if (!over || active.id === over.id) return

		const oldIndex = items.findIndex((section) => section.id === active.id)
		const newIndex = items.findIndex((section) => section.id === over.id)
		if (oldIndex < 0 || newIndex < 0) return
		if (
			isLockedBlockType(items[oldIndex]?.type ?? '') ||
			isLockedBlockType(items[newIndex]?.type ?? '')
		) {
			return
		}

		const moved = arrayMove(items, oldIndex, newIndex)
		const typesById = new Map(
			moved.map((section) => [section.id, section.type]),
		)
		const pinnedIds = pinLockedChromeOrder(
			moved.map((section) => section.id),
			typesById,
		)
		const next = pinnedIds.map((id, index) => {
			const section = moved.find((item) => item.id === id)!
			return { ...section, position: index }
		})
		setItems(next)
		onReorder(next.map((section) => section.id))
	}

	return (
		<div className="mt-2 px-2 pb-2">
			<DndContext
				id={dndId}
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis]}
				onDragStart={() => setIsDragging(true)}
				onDragCancel={() => setIsDragging(false)}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={items.map((section) => section.id)}
					strategy={verticalListSortingStrategy}
				>
					{items.map((section, idx) => (
						<div key={section.id}>
							{idx === 0 && !isLockedBlockType(section.type) ? (
								<div
									className={cn(isDragging && 'pointer-events-none')}
									aria-hidden={isDragging || undefined}
								>
									<AddSectionDialog
										position={section.position}
										onAdd={onAdd}
										trigger="insert"
									/>
								</div>
							) : null}
							<SortableSectionCard
								section={section}
								isSelected={selectedSectionId === section.id}
								onSelect={() => onSelect(section.id)}
								onRemove={() => onRemove(section.id)}
							/>
							{section.type !== 'footer' ? (
								<div
									className={cn(isDragging && 'pointer-events-none')}
									aria-hidden={isDragging || undefined}
								>
									<AddSectionDialog
										position={section.position + 1}
										onAdd={onAdd}
										trigger="insert"
									/>
								</div>
							) : null}
						</div>
					))}
				</SortableContext>
			</DndContext>
		</div>
	)
}

function previewText(
	type: BlockType,
	config: Record<string, unknown>,
	locale: string,
	defaultLocale: string,
): string {
	const loc = (value: unknown) =>
		pickLocalized(typeof value === 'string' ? value : '', locale, defaultLocale)

	switch (type) {
		case 'hero':
			return loc(config.heading) || 'Hero section'
		case 'header':
			return 'Same on every page'
		case 'footer':
			return 'Same on every page'
		case 'content':
			return (
				loc(config.title) || loc(config.body)?.slice(0, 80) || 'Content section'
			)
		case 'faq': {
			const items = config.items as Array<{ question: string }> | undefined
			return items?.length
				? `${items.length} question${items.length > 1 ? 's' : ''}`
				: 'FAQ section'
		}
		case 'features': {
			const features = config.items as Array<{ title: string }> | undefined
			return features?.length
				? `${features.length} feature${features.length > 1 ? 's' : ''}`
				: 'Features section'
		}
		case 'gallery': {
			const images = config.images as unknown[] | undefined
			return images?.length
				? `${images.length} item${images.length > 1 ? 's' : ''}`
				: 'Gallery section'
		}
		case 'cards': {
			const cards = config.items as unknown[] | undefined
			return cards?.length
				? `${cards.length} card${cards.length > 1 ? 's' : ''}`
				: 'Cards section'
		}
		case 'testimonials': {
			const quotes = config.items as unknown[] | undefined
			return quotes?.length
				? `${quotes.length} review${quotes.length > 1 ? 's' : ''}`
				: 'Testimonials'
		}
		case 'video':
			return loc(config.videoUrl) || loc(config.title) || 'Video section'
		case 'form':
			return loc(config.formName) || 'Choose a form'
		case 'cta':
			return loc(config.heading) || 'Call to action'
		default:
			return 'Section'
	}
}

// --- Section Editor Panel ---
function SectionEditorPanel({
	section,
	onBack,
	onSave,
	onUploadAsset,
	isUploadingAsset,
	uploadedAssetUrl,
	uploadError,
	onOpenBranding,
	siteIconKey,
}: {
	section: { id: string; type: string; config: string }
	onBack: () => void
	onSave: (sectionId: string, config: string) => void
	onUploadAsset?: (file: File) => void
	isUploadingAsset?: boolean
	uploadedAssetUrl?: string | null
	uploadError?: string | null
	onOpenBranding?: () => void
	siteIconKey?: string | null
}) {
	const blockDef = BLOCK_TYPES[section.type as BlockType]
	const [config, setConfig] = useState(() => parseBlockConfig(section.config))

	// Reset config when section changes
	useEffect(() => {
		setConfig(parseBlockConfig(section.config))
	}, [section.id, section.config])

	const updateField = useCallback(
		(key: string, value: unknown) => {
			setConfig((prev) => {
				const next = { ...prev, [key]: value }
				// Auto-save on change
				onSave(section.id, JSON.stringify(next))
				return next
			})
		},
		[section.id, onSave],
	)

	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const { requestTranslate, isTranslating } = useSectionTranslator()

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onBack}
					aria-label="Back to sections"
				>
					<Icon name="chevron-left" className="size-4" />
				</Button>
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon
						name={(blockDef?.icon ?? 'blocks') as IconName}
						className="size-3.5"
					/>
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{blockDef?.label ?? section.type}
				</span>
				{activeLocale !== defaultLocale && (
					<Button
						variant="ghost"
						size="xs"
						className="text-brand hover:bg-brand/10 hover:text-brand"
						onClick={() =>
							requestTranslate([{ id: section.id, type: section.type, config }])
						}
						disabled={isTranslating}
						title={`Translate section to ${activeLocale}`}
					>
						{isTranslating ? (
							<Spinner className="mr-1 size-3.5" />
						) : (
							<Icon name="languages" className="mr-1 size-3.5" />
						)}
						<Trans>Translate</Trans>
					</Button>
				)}
				<LocaleSwitcher />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="p-4">
					{renderBlockEditor({
						type: section.type as BlockType,
						config,
						updateField,
						listKey: section.id,
						onUploadAsset,
						isUploadingAsset,
						uploadedAssetUrl,
						uploadError,
						onOpenBranding,
						siteIconKey,
					})}
				</div>
			</ScrollArea>
		</div>
	)
}

const META_TITLE_SOFT_LIMIT = 60
const META_DESCRIPTION_SOFT_LIMIT = 160

function PageSettingsPanel({
	page,
	previewHost,
	onSave,
	onUploadImage,
	isUploadingImage,
	uploadedImageUrl,
	uploadError,
	slugError,
}: {
	page: {
		title: string
		slug: string
		isHomePage: boolean
		seoTitle: string | null
		seoDescription: string | null
		seoImageUrl: string | null
		seoNoIndex: boolean
	}
	previewHost: string
	onSave: (settings: {
		slug: string
		seoTitle: string
		seoDescription: string
		seoImageUrl: string
		seoNoIndex: boolean
	}) => void
	onUploadImage: (file: File) => void
	isUploadingImage: boolean
	uploadedImageUrl?: string | null
	uploadError?: string | null
	slugError?: string | null
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const [slug, setSlug] = useState(() => displayPageSlug(page))
	const [seoTitle, setSeoTitle] = useState(page.seoTitle ?? '')
	const [seoDescription, setSeoDescription] = useState(
		page.seoDescription ?? '',
	)
	const [seoImageUrl, setSeoImageUrl] = useState(page.seoImageUrl ?? '')
	const [seoNoIndex, setSeoNoIndex] = useState(page.seoNoIndex)
	const [showUrlInput, setShowUrlInput] = useState(false)
	const [dismissedSlugError, setDismissedSlugError] = useState(false)

	useEffect(() => {
		setSlug(page.isHomePage && isRootPageSlug(page.slug) ? '' : page.slug)
	}, [page.slug, page.isHomePage])

	useEffect(() => {
		setDismissedSlugError(false)
	}, [slugError])

	useEffect(() => {
		setSeoTitle(page.seoTitle ?? '')
		setSeoDescription(page.seoDescription ?? '')
		setSeoImageUrl(page.seoImageUrl ?? '')
		setSeoNoIndex(page.seoNoIndex)
		if (page.seoImageUrl) setShowUrlInput(false)
	}, [page.seoTitle, page.seoDescription, page.seoImageUrl, page.seoNoIndex])

	useEffect(() => {
		if (!uploadedImageUrl) return
		setSeoImageUrl(uploadedImageUrl)
		setShowUrlInput(false)
	}, [uploadedImageUrl])

	const persist = useCallback(
		(next: {
			slug?: string
			seoTitle?: string
			seoDescription?: string
			seoImageUrl?: string
			seoNoIndex?: boolean
		}) => {
			const nextSlug = next.slug
			onSave({
				slug:
					nextSlug !== undefined &&
					isValidPageSlug(nextSlug, { allowEmpty: page.isHomePage })
						? nextSlug
						: page.isHomePage && isRootPageSlug(page.slug)
							? ''
							: page.slug,
				seoTitle: next.seoTitle ?? seoTitle,
				seoDescription: next.seoDescription ?? seoDescription,
				seoImageUrl: next.seoImageUrl ?? seoImageUrl,
				seoNoIndex: next.seoNoIndex ?? seoNoIndex,
			})
		},
		[
			onSave,
			page.isHomePage,
			page.slug,
			seoTitle,
			seoDescription,
			seoImageUrl,
			seoNoIndex,
		],
	)

	const commitSlug = useCallback(
		(value: string) => {
			const next = finalizePageSlug(value)
			if (page.isHomePage) {
				const homeSlug = isRootPageSlug(next) ? '' : next
				setSlug(homeSlug)
				if (homeSlug && !PAGE_SLUG_PATTERN.test(homeSlug)) return
				if (homeSlug !== page.slug) persist({ slug: homeSlug })
				return
			}
			if (!next) {
				setSlug(page.slug)
				return
			}
			setSlug(next)
			if (!PAGE_SLUG_PATTERN.test(next)) {
				return
			}
			if (next !== page.slug) persist({ slug: next })
		},
		[page.isHomePage, page.slug, persist],
	)

	const displayTitle =
		pickLocalized(seoTitle, activeLocale, defaultLocale) ||
		pickLocalized(page.title, activeLocale, defaultLocale) ||
		page.title ||
		'Page title'
	const displayDescription =
		pickLocalized(seoDescription, activeLocale, defaultLocale) ||
		'Add a meta description to improve how this page appears in search results.'
	const titleLength = getLocalizedEditableValue(
		seoTitle,
		activeLocale,
		defaultLocale,
	).length
	const descriptionLength = getLocalizedEditableValue(
		seoDescription,
		activeLocale,
		defaultLocale,
	).length
	const previewSlug =
		finalizePageSlug(slug) || (page.isHomePage ? '' : page.slug)
	const pathLabel =
		page.isHomePage && isRootPageSlug(previewSlug || slug)
			? '/'
			: `/${previewSlug}`
	const hostLabel = previewHost.split('/')[0] || 'yoursite.com'
	const safeSeoImageUrl = sanitizeHtmlImageUrl(seoImageUrl)
	const hasImage = Boolean(safeSeoImageUrl)
	const localSlugError = page.isHomePage
		? slug && !PAGE_SLUG_PATTERN.test(finalizePageSlug(slug))
			? 'URL must contain only lowercase letters, numbers, and hyphens'
			: null
		: !slug
			? 'URL slug is required'
			: !PAGE_SLUG_PATTERN.test(finalizePageSlug(slug))
				? 'URL must contain only lowercase letters, numbers, and hyphens'
				: null
	const displayedSlugError =
		localSlugError || (dismissedSlugError ? null : slugError) || null

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name="file-text" className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					<Trans>Page Settings</Trans>
				</span>
				<LocaleSwitcher />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-5 p-4">
					<div className="space-y-1.5">
						<Label
							htmlFor="page-slug"
							className="text-muted-foreground text-xs font-medium"
						>
							<Trans>Page URL</Trans>
						</Label>
						<InputGroup>
							<InputGroupAddon>
								<InputGroupText>/</InputGroupText>
							</InputGroupAddon>
							<InputGroupInput
								id="page-slug"
								value={slug}
								aria-invalid={Boolean(displayedSlugError)}
								autoCapitalize="none"
								autoCorrect="off"
								autoComplete="off"
								spellCheck={false}
								placeholder={page.isHomePage ? '' : 'about-us'}
								onChange={(e) => {
									setSlug(sanitizePageSlugInput(e.target.value))
									setDismissedSlugError(true)
								}}
								onBlur={() => commitSlug(slug)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										e.currentTarget.blur()
									}
								}}
							/>
						</InputGroup>
						{displayedSlugError ? (
							<p className="text-destructive text-xs" role="alert">
								{displayedSlugError}
							</p>
						) : (
							<p className="text-muted-foreground text-[11px] leading-relaxed">
								{page.isHomePage ? (
									<Trans>
										Leave empty to keep this page at the root of your site.
									</Trans>
								) : (
									<Trans>
										Changing this URL will break existing links to the page.
									</Trans>
								)}
							</p>
						)}
					</div>

					<div className="border-border bg-muted/30 space-y-2 rounded-xl border p-3">
						<p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
							<Trans>Search preview</Trans>
						</p>
						<div className="space-y-1">
							<p className="dark:text-muted-foreground truncate text-xs text-[#202124]">
								{hostLabel}
								<span className="text-muted-foreground"> {pathLabel}</span>
							</p>
							<p className="line-clamp-2 text-base leading-snug text-[#1a0dab] dark:text-blue-400">
								{displayTitle}
							</p>
							<p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
								{displayDescription}
							</p>
						</div>
					</div>

					<div className="space-y-1.5">
						<div className="flex items-center justify-between gap-2">
							<Label className="text-muted-foreground text-xs font-medium">
								<Trans>SEO title</Trans>
							</Label>
							<span
								className={cn(
									'text-[11px] tabular-nums',
									titleLength > META_TITLE_SOFT_LIMIT
										? 'text-destructive'
										: 'text-muted-foreground',
								)}
							>
								{titleLength}/{META_TITLE_SOFT_LIMIT}
							</span>
						</div>
						<LocalizedInput
							value={seoTitle}
							onChange={(value) => {
								setSeoTitle(value)
								persist({
									seoTitle: value,
									seoDescription,
									seoImageUrl,
									seoNoIndex,
								})
							}}
							placeholder={
								pickLocalized(page.title, activeLocale, defaultLocale) ||
								'Page title'
							}
						/>
						<p className="text-muted-foreground text-[11px] leading-relaxed">
							<Trans>
								Shown in browser tabs and search results. Falls back to the page
								title when empty.
							</Trans>
						</p>
					</div>

					<div className="space-y-1.5">
						<div className="flex items-center justify-between gap-2">
							<Label className="text-muted-foreground text-xs font-medium">
								<Trans>Meta description</Trans>
							</Label>
							<span
								className={cn(
									'text-[11px] tabular-nums',
									descriptionLength > META_DESCRIPTION_SOFT_LIMIT
										? 'text-destructive'
										: 'text-muted-foreground',
								)}
							>
								{descriptionLength}/{META_DESCRIPTION_SOFT_LIMIT}
							</span>
						</div>
						<LocalizedTextarea
							value={seoDescription}
							onChange={(value) => {
								setSeoDescription(value)
								persist({
									seoTitle,
									seoDescription: value,
									seoImageUrl,
									seoNoIndex,
								})
							}}
							placeholder="A short summary of this page for search engines"
							rows={4}
						/>
						<p className="text-muted-foreground text-[11px] leading-relaxed">
							<Trans>
								Aim for one or two sentences that make someone click.
							</Trans>
						</p>
					</div>

					<div className="space-y-2">
						<div className="space-y-1">
							<Label className="text-sm font-medium">
								<Trans>Open Graph image</Trans>
							</Label>
							<p className="text-muted-foreground text-[11px] leading-relaxed">
								<Trans>
									Use an image that's at least 1200px by 630px (1.91:1) for the
									best results.
								</Trans>
							</p>
						</div>

						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
							className="sr-only"
							onChange={(e) => {
								const file = e.currentTarget.files?.[0]
								if (file) onUploadImage(file)
								e.currentTarget.value = ''
							}}
						/>

						{hasImage ? (
							<div className="border-border space-y-2 overflow-hidden rounded-xl border">
								{safeSeoImageUrl ? (
									<img
										src={safeSeoImageUrl}
										alt=""
										className="bg-muted aspect-[1.91/1] w-full object-cover"
									/>
								) : null}
								<div className="flex flex-wrap gap-2 px-2 pb-2">
									<Button
										variant="outline"
										size="sm"
										disabled={isUploadingImage}
										onClick={() => fileInputRef.current?.click()}
									>
										{isUploadingImage ? (
											<Spinner />
										) : (
											<Icon name="image" className="size-3.5" />
										)}
										<Trans>Replace</Trans>
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setShowUrlInput((open) => !open)}
									>
										<Icon name="link-2" className="size-3.5" />
										<Trans>URL</Trans>
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="text-destructive hover:text-destructive"
										onClick={() => {
											setSeoImageUrl('')
											setShowUrlInput(false)
											persist({
												seoTitle,
												seoDescription,
												seoImageUrl: '',
												seoNoIndex,
											})
										}}
									>
										<Icon name="trash-2" className="size-3.5" />
										<Trans>Remove</Trans>
									</Button>
								</div>
							</div>
						) : (
							<div className="flex flex-wrap items-center gap-3">
								<Button
									variant="outline"
									size="sm"
									disabled={isUploadingImage}
									onClick={() => fileInputRef.current?.click()}
								>
									{isUploadingImage ? (
										<Spinner />
									) : (
										<Icon name="image" className="size-3.5" />
									)}
									<Trans>Select image</Trans>
								</Button>
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
									onClick={() => setShowUrlInput(true)}
								>
									<Icon name="link-2" className="size-3.5" />
									<Trans>Add URL</Trans>
								</button>
							</div>
						)}

						{showUrlInput || (!hasImage && showUrlInput) ? (
							<div className="space-y-1.5">
								<Input
									value={seoImageUrl}
									onChange={(e) => {
										const value = e.target.value
										setSeoImageUrl(value)
										persist({
											seoTitle,
											seoDescription,
											seoImageUrl: value,
											seoNoIndex,
										})
									}}
									placeholder="https://…"
									autoFocus={!hasImage}
								/>
							</div>
						) : null}

						{uploadError ? (
							<p className="text-destructive text-xs" role="alert">
								{uploadError}
							</p>
						) : null}
					</div>

					<div className="border-border flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
						<div className="min-w-0 space-y-0.5">
							<Label htmlFor="page-noindex" className="cursor-pointer text-sm">
								<Trans>Hide from search engines</Trans>
							</Label>
							<p className="text-muted-foreground text-[11px] leading-relaxed">
								<Trans>
									Adds a noindex tag so this page stays off Google and Bing.
								</Trans>
							</p>
						</div>
						<Switch
							id="page-noindex"
							size="sm"
							checked={seoNoIndex}
							onCheckedChange={(checked) => {
								setSeoNoIndex(checked)
								persist({
									seoTitle,
									seoDescription,
									seoImageUrl,
									seoNoIndex: checked,
								})
							}}
						/>
					</div>
				</div>
			</ScrollArea>
		</div>
	)
}

// --- Block Editors ---
function renderBlockEditor(props: {
	type: BlockType
	config: Record<string, unknown>
	updateField: (key: string, value: unknown) => void
	listKey: string
	onUploadAsset?: (file: File) => void
	isUploadingAsset?: boolean
	uploadedAssetUrl?: string | null
	uploadError?: string | null
	onOpenBranding?: () => void
	siteIconKey?: string | null
}) {
	const {
		type,
		config,
		updateField,
		listKey,
		onOpenBranding,
		siteIconKey,
		...editorProps
	} = props
	switch (type) {
		case 'header':
			return (
				<HeaderEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
					onOpenBranding={onOpenBranding}
					siteIconKey={siteIconKey}
				/>
			)
		case 'hero':
			return (
				<HeroEditor
					config={config}
					updateField={updateField}
					{...editorProps}
				/>
			)
		case 'content':
			return (
				<ContentEditor
					config={config}
					updateField={updateField}
					{...editorProps}
				/>
			)
		case 'faq':
			return (
				<FaqEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
				/>
			)
		case 'features':
			return (
				<FeaturesEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
				/>
			)
		case 'gallery':
			return (
				<GalleryEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
					{...editorProps}
				/>
			)
		case 'cards':
			return (
				<CardsEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
				/>
			)
		case 'testimonials':
			return (
				<TestimonialsEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
				/>
			)
		case 'video':
			return <VideoEditor config={config} updateField={updateField} />
		case 'form':
			return <FormBlockEditor config={config} updateField={updateField} />
		case 'cta':
			return (
				<CtaEditor config={config} updateField={updateField} {...editorProps} />
			)
		case 'footer':
			return (
				<FooterEditor
					config={config}
					updateField={updateField}
					listKey={listKey}
				/>
			)
		default:
			return (
				<p className="text-muted-foreground text-sm">
					<Trans>No editor available for this block type.</Trans>
				</p>
			)
	}
}

interface EditorProps {
	config: Record<string, unknown>
	updateField: (key: string, value: unknown) => void
	onUploadAsset?: (file: File) => void
	isUploadingAsset?: boolean
	uploadedAssetUrl?: string | null
	uploadError?: string | null
}

interface ListEditorProps extends EditorProps {
	listKey: string
}

function createItemIds(count: number) {
	return Array.from({ length: count }, () => crypto.randomUUID())
}

function formatItemIndex(index: number) {
	return String(index + 1).padStart(2, '0')
}

function SortableItemList<T>({
	listKey,
	items,
	onChange,
	getTitle,
	renderFields,
	addLabel,
	deleteLabel,
	emptyTitle = 'Untitled',
	createItem,
}: {
	listKey: string
	items: T[]
	onChange: (items: T[]) => void
	getTitle: (item: T) => string
	renderFields: (
		item: T,
		index: number,
		update: (patch: Partial<T>) => void,
	) => ReactNode
	addLabel: ReactNode
	deleteLabel: ReactNode
	emptyTitle?: string
	createItem: () => T
}) {
	const dndId = useId()
	const [{ ids, expandedId }, setListState] = useState(() => {
		const nextIds = createItemIds(items.length)
		return { ids: nextIds, expandedId: nextIds[0] ?? null }
	})
	const prevListKey = useRef(listKey)

	if (prevListKey.current !== listKey) {
		prevListKey.current = listKey
		const nextIds = createItemIds(items.length)
		setListState({ ids: nextIds, expandedId: nextIds[0] ?? null })
	}

	useEffect(() => {
		setListState((prev) => {
			if (prev.ids.length === items.length) return prev
			if (prev.ids.length < items.length) {
				const nextIds = [
					...prev.ids,
					...createItemIds(items.length - prev.ids.length),
				]
				return {
					ids: nextIds,
					expandedId: prev.expandedId ?? nextIds[nextIds.length - 1] ?? null,
				}
			}
			const nextIds = prev.ids.slice(0, items.length)
			return {
				ids: nextIds,
				expandedId:
					prev.expandedId && nextIds.includes(prev.expandedId)
						? prev.expandedId
						: (nextIds[0] ?? null),
			}
		})
	}, [items.length])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		if (!over || active.id === over.id) return

		const oldIndex = ids.indexOf(String(active.id))
		const newIndex = ids.indexOf(String(over.id))
		if (oldIndex < 0 || newIndex < 0) return

		setListState((prev) => ({
			...prev,
			ids: arrayMove(prev.ids, oldIndex, newIndex),
		}))
		onChange(arrayMove(items, oldIndex, newIndex))
	}

	const handleAdd = () => {
		const newId = crypto.randomUUID()
		setListState((prev) => ({
			ids: [...prev.ids, newId],
			expandedId: newId,
		}))
		onChange([...items, createItem()])
	}

	const handleRemove = (index: number) => {
		const removedId = ids[index]
		setListState((prev) => {
			const nextIds = prev.ids.filter((_, i) => i !== index)
			return {
				ids: nextIds,
				expandedId:
					prev.expandedId === removedId
						? (nextIds[Math.min(index, nextIds.length - 1)] ?? null)
						: prev.expandedId,
			}
		})
		onChange(items.filter((_, i) => i !== index))
	}

	const handleUpdate = (index: number, patch: Partial<T>) => {
		const next = [...items]
		next[index] = { ...next[index], ...patch } as T
		onChange(next)
	}

	return (
		<div className="space-y-2 pl-7">
			<DndContext
				id={dndId}
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis]}
				onDragEnd={handleDragEnd}
			>
				<SortableContext items={ids} strategy={verticalListSortingStrategy}>
					{items.map((item, index) => {
						const id = ids[index]
						if (!id) return null
						const expanded = expandedId === id
						return (
							<SortableAccordionRow
								key={id}
								id={id}
								index={index}
								expanded={expanded}
								title={getTitle(item)}
								emptyTitle={emptyTitle}
								deleteLabel={deleteLabel}
								onToggle={() =>
									setListState((prev) => ({
										...prev,
										expandedId: prev.expandedId === id ? null : id,
									}))
								}
								onRemove={() => handleRemove(index)}
								onUpdate={(patch) => handleUpdate(index, patch)}
								item={item}
								renderFields={renderFields}
							/>
						)
					})}
				</SortableContext>
			</DndContext>

			<button
				type="button"
				onClick={handleAdd}
				className="border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm transition-colors"
			>
				<Icon name="plus" className="size-3.5" />
				{addLabel}
			</button>
		</div>
	)
}

function SortableAccordionRow<T>({
	id,
	index,
	item,
	expanded,
	title,
	emptyTitle,
	deleteLabel,
	onToggle,
	onRemove,
	onUpdate,
	renderFields,
}: {
	id: string
	index: number
	item: T
	expanded: boolean
	title: string
	emptyTitle: string
	deleteLabel: ReactNode
	onToggle: () => void
	onRemove: () => void
	onUpdate: (patch: Partial<T>) => void
	renderFields: (
		item: T,
		index: number,
		update: (patch: Partial<T>) => void,
	) => ReactNode
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id })

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn('group/row relative', isDragging && 'z-10')}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				className={cn(
					'text-muted-foreground hover:text-foreground absolute top-2.5 -left-7 flex size-6 cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity active:cursor-grabbing',
					'group-hover/row:opacity-100 focus-visible:opacity-100',
					(expanded || isDragging) && 'opacity-100',
				)}
				aria-label="Drag to reorder"
				{...attributes}
				{...listeners}
			>
				<Icon name="grip-vertical" className="size-3.5" />
			</button>

			<div
				className={cn(
					'border-border bg-background rounded-lg border transition-colors',
					expanded && 'border-foreground/20',
					isDragging && 'bg-muted/40 shadow-sm',
				)}
			>
				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
					onClick={onToggle}
					aria-expanded={expanded}
				>
					<span className="text-muted-foreground w-5 shrink-0 text-xs font-medium tabular-nums">
						{formatItemIndex(index)}
					</span>
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-sm font-medium',
							!title && 'text-muted-foreground',
						)}
					>
						{title || emptyTitle}
					</span>
					<Icon
						name={expanded ? 'chevron-down' : 'chevron-right'}
						className="text-muted-foreground size-4 shrink-0"
					/>
				</button>

				{expanded ? (
					<div className="border-border space-y-3 border-t px-3 pt-3 pb-3">
						{renderFields(item, index, onUpdate)}
						<Button
							variant="ghost"
							size="sm"
							className="text-destructive hover:text-destructive -ml-2 h-8 px-2"
							onClick={onRemove}
						>
							<Icon name="trash-2" className="size-3.5" />
							{deleteLabel}
						</Button>
					</div>
				) : null}
			</div>
		</div>
	)
}

function HeaderEditor({
	config,
	updateField,
	listKey,
	onOpenBranding,
	siteIconKey,
}: ListEditorProps & {
	onOpenBranding?: () => void
	siteIconKey?: string | null
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const navLinks =
		(config.navLinks as Array<{ label: string; url: unknown }>) ?? []
	const logoSrc = siteIconKey
		? `/resources/images?objectKey=${encodeURIComponent(siteIconKey)}`
		: null

	return (
		<div className="space-y-5">
			{onOpenBranding ? (
				<button
					type="button"
					onClick={onOpenBranding}
					className="border-border hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
				>
					<span className="border-border bg-muted flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border">
						{logoSrc ? (
							<img src={logoSrc} alt="" className="size-full object-contain" />
						) : (
							<Icon
								name="paintbrush"
								className="text-muted-foreground size-4"
							/>
						)}
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-medium">
							<Trans>Logo & colors</Trans>
						</span>
						<span className="text-muted-foreground mt-0.5 block text-[11px] leading-relaxed">
							<Trans>Shared across every page</Trans>
						</span>
					</span>
					<Icon
						name="chevron-right"
						className="text-muted-foreground size-4 shrink-0"
					/>
				</button>
			) : (
				<p className="text-muted-foreground text-xs leading-relaxed">
					<Trans>The header is shared across every page.</Trans>
				</p>
			)}
			<FieldSwitch
				label="Show organization name"
				checked={(config.showName as boolean) ?? true}
				onChange={(v) => updateField('showName', v)}
			/>
			<FieldSwitch
				label="Sticky header"
				checked={(config.sticky as boolean) ?? true}
				onChange={(v) => updateField('sticky', v)}
			/>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Navigation links</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:nav`}
					items={navLinks}
					onChange={(next) => updateField('navLinks', next)}
					createItem={() => ({ label: '', url: '' })}
					getTitle={(item) =>
						pickLocalized(item.label, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled link"
					addLabel={<Trans>Add link</Trans>}
					deleteLabel={<Trans>Delete link</Trans>}
					renderFields={(item, _index, update) => (
						<LinkInspector
							value={item.url}
							text={item.label}
							onChange={(link) => update({ url: link })}
							onTextChange={(label) => update({ label })}
							showText
							TextInput={LocalizedInput}
							textPlaceholder="About"
						/>
					)}
				/>
			</div>
			<FieldSwitch
				label="Show call to action"
				checked={(config.showCta as boolean) ?? true}
				onChange={(v) => updateField('showCta', v)}
			/>
			<LinkInspector
				value={config.ctaUrl}
				text={(config.ctaLabel as string) ?? ''}
				onChange={(link) => updateField('ctaUrl', link)}
				onTextChange={(v) => updateField('ctaLabel', v)}
				showText
				TextInput={LocalizedInput}
				textPlaceholder="Get in touch"
			/>
		</div>
	)
}

function HeroEditor({ config, updateField, ...editorProps }: EditorProps) {
	const assetType = (config.assetType as string) ?? 'none'
	const links =
		(config.links as Array<{
			url: unknown
			link: { label: string }
			variant?: 'primary' | 'secondary'
		}>) ?? []

	const updateHeroLink = (
		index: number,
		patch: {
			url?: unknown
			label?: string
			variant?: 'primary' | 'secondary'
		},
	) => {
		const next = [...links]
		const current = next[index] ?? { url: '', link: { label: '' } }
		next[index] = {
			url: patch.url !== undefined ? patch.url : current.url,
			link: {
				label:
					patch.label !== undefined ? patch.label : (current.link?.label ?? ''),
			},
			variant:
				patch.variant ??
				current.variant ??
				(index === 0 ? 'primary' : 'secondary'),
		}
		updateField('links', next)
	}

	const minHeight = (config.minHeight as number) ?? 560

	return (
		<div className="space-y-6">
			<EditorSection title={<Trans>Content</Trans>}>
				<FieldInput
					label="Heading"
					value={(config.heading as string) ?? ''}
					onChange={(v) => updateField('heading', v)}
					placeholder="Welcome to our site"
				/>
				<FieldInput
					label="Subheading"
					value={(config.subheading as string) ?? ''}
					onChange={(v) => updateField('subheading', v)}
					placeholder="A brief description of what we do"
				/>
			</EditorSection>

			<EditorSection title={<Trans>Buttons</Trans>}>
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs font-medium">
						<Trans>Primary button</Trans>
					</p>
					<LinkInspector
						value={links[0]?.url}
						text={links[0]?.link?.label ?? ''}
						onChange={(link) => updateHeroLink(0, { url: link })}
						onTextChange={(label) => updateHeroLink(0, { label })}
						showText
						TextInput={LocalizedInput}
						textPlaceholder="Get Started"
						buttonStyle={links[0]?.variant ?? 'primary'}
						onButtonStyleChange={(variant) => updateHeroLink(0, { variant })}
					/>
				</div>
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs font-medium">
						<Trans>Secondary button</Trans>
					</p>
					<LinkInspector
						value={links[1]?.url}
						text={links[1]?.link?.label ?? ''}
						onChange={(link) => updateHeroLink(1, { url: link })}
						onTextChange={(label) => updateHeroLink(1, { label })}
						showText
						TextInput={LocalizedInput}
						textPlaceholder="Learn more (optional)"
						buttonStyle={links[1]?.variant ?? 'secondary'}
						onButtonStyleChange={(variant) => updateHeroLink(1, { variant })}
					/>
				</div>
			</EditorSection>

			<EditorSection title={<Trans>Layout</Trans>}>
				<FieldChoice
					label={<Trans>Background</Trans>}
					value={assetType}
					onChange={(v) => {
						updateField('assetType', v)
						if (v !== 'none') updateField('assetPosition', 'background')
					}}
					options={[
						{ value: 'none', label: <Trans>None</Trans> },
						{ value: 'image', label: <Trans>Photo</Trans> },
						{ value: 'video', label: <Trans>Video</Trans> },
					]}
				/>
				<FieldChoice
					label={<Trans>Text position</Trans>}
					value={(config.textPosition as string) ?? 'left'}
					onChange={(v) => updateField('textPosition', v)}
					options={[
						{
							value: 'left',
							label: <Trans>Left</Trans>,
							preview: <AlignSketch align="left" />,
						},
						{
							value: 'center',
							label: <Trans>Center</Trans>,
							preview: <AlignSketch align="center" />,
						},
					]}
				/>
				{assetType !== 'none' ? (
					<FieldChoice
						label={<Trans>Photo overlay</Trans>}
						value={(config.overlay as string) ?? 'dark'}
						onChange={(v) => updateField('overlay', v)}
						options={[
							{
								value: 'none',
								label: <Trans>None</Trans>,
								preview: <OverlaySketch overlay="none" />,
							},
							{
								value: 'dark',
								label: <Trans>Dark</Trans>,
								preview: <OverlaySketch overlay="dark" />,
							},
							{
								value: 'gradient',
								label: <Trans>Fade up</Trans>,
								preview: <OverlaySketch overlay="gradient" />,
							},
						]}
					/>
				) : null}
				<FieldChoice
					label={<Trans>Section height</Trans>}
					value={String(nearestHeroHeight(minHeight))}
					onChange={(v) => updateField('minHeight', Number(v))}
					options={HERO_HEIGHTS.map((option) => ({
						value: String(option.value),
						label: option.label,
						preview: <HeightSketch size={option.key} />,
					}))}
				/>
			</EditorSection>

			{assetType !== 'none' ? (
				<EditorSection title={<Trans>Media</Trans>}>
					{assetType === 'image' ? (
						<>
							<FieldAssetUpload
								label="Upload photo"
								accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
								onUpload={editorProps.onUploadAsset}
								isUploading={editorProps.isUploadingAsset}
								uploadedUrl={editorProps.uploadedAssetUrl}
								uploadError={editorProps.uploadError}
								onUrlReady={(url) => updateField('imageUrl', url)}
							/>
							<FieldInput
								label="Photo URL"
								value={(config.imageUrl as string) ?? ''}
								onChange={(v) => updateField('imageUrl', v)}
								placeholder="https://…"
							/>
						</>
					) : null}
					{assetType === 'video' ? (
						<>
							<FieldAssetUpload
								label="Upload video"
								accept="video/mp4,video/webm,video/quicktime"
								onUpload={editorProps.onUploadAsset}
								isUploading={editorProps.isUploadingAsset}
								uploadedUrl={editorProps.uploadedAssetUrl}
								uploadError={editorProps.uploadError}
								onUrlReady={(url) => updateField('videoSrc', url)}
							/>
							<FieldInput
								label="Video URL"
								value={(config.videoSrc as string) ?? ''}
								onChange={(v) => updateField('videoSrc', v)}
								placeholder="https://…/video.mp4"
							/>
							<FieldSwitch
								label="Autoplay"
								checked={(config.videoAutoPlay as boolean) ?? true}
								onChange={(v) => {
									updateField('videoAutoPlay', v)
									if (v) updateField('videoMuted', true)
								}}
							/>
							<FieldSwitch
								label="Loop"
								checked={(config.videoLoop as boolean) ?? true}
								onChange={(v) => updateField('videoLoop', v)}
							/>
							<FieldSwitch
								label="Muted"
								checked={(config.videoMuted as boolean) ?? true}
								onChange={(v) => updateField('videoMuted', v)}
							/>
							{((config.videoAutoPlay as boolean) ?? true) ? (
								<p className="text-muted-foreground text-xs leading-relaxed">
									<Trans>Browsers only autoplay video when it is muted.</Trans>
								</p>
							) : null}
						</>
					) : null}
				</EditorSection>
			) : null}
		</div>
	)
}

function ContentEditor({ config, updateField, ...editorProps }: EditorProps) {
	const layout = (config.layout as string) || 'split'
	return (
		<div className="space-y-6">
			<EditorSection title={<Trans>Content</Trans>}>
				<FieldInput
					label="Title"
					value={(config.title as string) ?? ''}
					onChange={(v) => updateField('title', v)}
				/>
				<FieldInput
					label="Subtitle"
					value={(config.subtitle as string) ?? ''}
					onChange={(v) => updateField('subtitle', v)}
				/>
				<FieldTextarea
					label="Body"
					value={(config.body as string) ?? ''}
					onChange={(v) => updateField('body', v)}
					rows={8}
					allowHtml
				/>
			</EditorSection>

			<EditorSection title={<Trans>Layout</Trans>}>
				<FieldChoice
					label={<Trans>Arrangement</Trans>}
					value={layout}
					onChange={(v) => updateField('layout', v)}
					options={[
						{
							value: 'text',
							label: <Trans>Text only</Trans>,
							preview: <LayoutSketch variant="text" />,
						},
						{
							value: 'split',
							label: <Trans>Photo + text</Trans>,
							preview: <LayoutSketch variant="split" />,
						},
						{
							value: 'brand',
							label: <Trans>Logo panel</Trans>,
							preview: <LayoutSketch variant="brand" />,
						},
					]}
				/>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>

			{layout !== 'text' ? (
				<EditorSection title={<Trans>Photo</Trans>}>
					<FieldAssetUpload
						label="Upload photo"
						accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
						onUpload={editorProps.onUploadAsset}
						isUploading={editorProps.isUploadingAsset}
						uploadedUrl={editorProps.uploadedAssetUrl}
						uploadError={editorProps.uploadError}
						onUrlReady={(url) => updateField('imageUrl', url)}
					/>
					<FieldInput
						label="Photo URL"
						value={(config.imageUrl as string) ?? ''}
						onChange={(v) => updateField('imageUrl', v)}
					/>
					<FieldInput
						label="Alt text"
						value={(config.imageAlt as string) ?? ''}
						onChange={(v) => updateField('imageAlt', v)}
					/>
					<FieldChoice
						label={<Trans>Photo side</Trans>}
						value={(config.imagePosition as string) ?? 'left'}
						onChange={(v) => updateField('imagePosition', v)}
						options={[
							{
								value: 'left',
								label: <Trans>Left</Trans>,
								preview: <LayoutSketch variant="split" />,
							},
							{
								value: 'right',
								label: <Trans>Right</Trans>,
								preview: (
									<SketchFrame className="gap-1">
										<TextLines dense />
										<span className="bg-foreground/20 h-full flex-1 rounded-sm" />
									</SketchFrame>
								),
							},
						]}
					/>
					<FieldChoice
						label={<Trans>Photo shape</Trans>}
						value={(config.imageShape as string) ?? 'rounded'}
						onChange={(v) => updateField('imageShape', v)}
						options={[
							{
								value: 'rounded',
								label: <Trans>Rounded</Trans>,
								preview: <ShapeSketch shape="rounded" />,
							},
							{
								value: 'circle',
								label: <Trans>Circle</Trans>,
								preview: <ShapeSketch shape="circle" />,
							},
							{
								value: 'square',
								label: <Trans>Square</Trans>,
								preview: <ShapeSketch shape="square" />,
							},
						]}
					/>
				</EditorSection>
			) : null}

			<EditorSection title={<Trans>Button</Trans>}>
				<LinkInspector
					value={config.ctaUrl}
					text={(config.ctaLabel as string) ?? ''}
					onChange={(link) => updateField('ctaUrl', link)}
					onTextChange={(v) => updateField('ctaLabel', v)}
					showText
					TextInput={LocalizedInput}
				/>
			</EditorSection>
		</div>
	)
}

function FaqEditor({ config, updateField, listKey }: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const items =
		(config.items as Array<{ question: string; answer: string }>) ?? []

	return (
		<div className="space-y-4">
			<FieldInput
				label="Title"
				value={(config.title as string) ?? ''}
				onChange={(v) => updateField('title', v)}
			/>
			<FieldInput
				label="Subtitle"
				value={(config.subtitle as string) ?? ''}
				onChange={(v) => updateField('subtitle', v)}
			/>
			<EditorSection title={<Trans>Style</Trans>}>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Questions</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:faq`}
					items={items}
					onChange={(next) => updateField('items', next)}
					createItem={() => ({ question: '', answer: '' })}
					getTitle={(item) =>
						pickLocalized(item.question, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled question"
					addLabel={<Trans>Add question</Trans>}
					deleteLabel={<Trans>Delete question</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Question</Trans>
								</Label>
								<LocalizedInput
									value={item.question}
									onChange={(val) => update({ question: val })}
									placeholder="Question"
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Answer</Trans>
								</Label>
								<LocalizedTextarea
									value={item.answer}
									onChange={(val) => update({ answer: val })}
									placeholder="Answer"
									rows={3}
								/>
							</div>
						</>
					)}
				/>
			</div>
		</div>
	)
}

function FeaturesEditor({ config, updateField, listKey }: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const items =
		(config.items as Array<{ title: string; description: string }>) ?? []

	return (
		<div className="space-y-4">
			<FieldInput
				label="Title"
				value={(config.title as string) ?? ''}
				onChange={(v) => updateField('title', v)}
			/>
			<FieldInput
				label="Subtitle"
				value={(config.subtitle as string) ?? ''}
				onChange={(v) => updateField('subtitle', v)}
			/>
			<EditorSection title={<Trans>Style</Trans>}>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Features</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:features`}
					items={items}
					onChange={(next) => updateField('items', next)}
					createItem={() => ({ title: '', description: '' })}
					getTitle={(item) =>
						pickLocalized(item.title, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled feature"
					addLabel={<Trans>Add feature</Trans>}
					deleteLabel={<Trans>Delete feature</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Title</Trans>
								</Label>
								<LocalizedInput
									value={item.title}
									onChange={(val) => update({ title: val })}
									placeholder="Feature title"
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Description</Trans>
								</Label>
								<LocalizedTextarea
									value={item.description}
									onChange={(val) => update({ description: val })}
									placeholder="Description"
									rows={3}
								/>
							</div>
						</>
					)}
				/>
			</div>
		</div>
	)
}

function isGalleryVideoUrl(src: string) {
	let value = src
	try {
		value = decodeURIComponent(src)
	} catch {
		value = src
	}
	return /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(value)
}

function GalleryEditor({
	config,
	updateField,
	listKey,
	...editorProps
}: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const images =
		(config.images as Array<{
			url: string
			alt: string
			caption: string
			type?: string
		}>) ?? []

	return (
		<div className="space-y-6">
			<EditorSection title={<Trans>Content</Trans>}>
				<FieldInput
					label="Title"
					value={(config.title as string) ?? ''}
					onChange={(v) => updateField('title', v)}
				/>
				<FieldInput
					label="Subtitle"
					value={(config.subtitle as string) ?? ''}
					onChange={(v) => updateField('subtitle', v)}
				/>
			</EditorSection>

			<EditorSection title={<Trans>Layout</Trans>}>
				<FieldChoice
					label={<Trans>Columns</Trans>}
					value={String(config.columns ?? 3)}
					onChange={(v) => updateField('columns', Number(v))}
					options={[
						{
							value: '2',
							label: <Trans>Two</Trans>,
							preview: <ColumnsSketch count={2} />,
						},
						{
							value: '3',
							label: <Trans>Three</Trans>,
							preview: <ColumnsSketch count={3} />,
						},
						{
							value: '4',
							label: <Trans>Four</Trans>,
							preview: <ColumnsSketch count={4} />,
						},
					]}
				/>
				<FieldChoice
					label={<Trans>Photo shape</Trans>}
					value={(config.imageShape as string) ?? 'rounded'}
					onChange={(v) => updateField('imageShape', v)}
					options={[
						{
							value: 'rounded',
							label: <Trans>Rounded</Trans>,
							preview: <ShapeSketch shape="rounded" />,
						},
						{
							value: 'circle',
							label: <Trans>Circle</Trans>,
							preview: <ShapeSketch shape="circle" />,
						},
						{
							value: 'square',
							label: <Trans>Square</Trans>,
							preview: <ShapeSketch shape="square" />,
						},
					]}
				/>
				<FieldChoice
					label={<Trans>Spacing</Trans>}
					value={(config.gap as string) ?? 'md'}
					onChange={(v) => updateField('gap', v)}
					options={[
						{
							value: 'none',
							label: <Trans>None</Trans>,
							preview: <GapSketch gap="none" />,
						},
						{
							value: 'sm',
							label: <Trans>Tight</Trans>,
							preview: <GapSketch gap="sm" />,
						},
						{
							value: 'md',
							label: <Trans>Regular</Trans>,
							preview: <GapSketch gap="md" />,
						},
						{
							value: 'lg',
							label: <Trans>Loose</Trans>,
							preview: <GapSketch gap="lg" />,
						},
					]}
				/>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>

			<EditorSection title={<Trans>Photos and videos</Trans>}>
				<SortableItemList
					listKey={`${listKey}:gallery`}
					items={images}
					onChange={(next) => updateField('images', next)}
					createItem={() => ({
						url: '',
						alt: '',
						caption: '',
						type: 'image',
					})}
					getTitle={(item) =>
						pickLocalized(item.alt, activeLocale, defaultLocale) ||
						pickLocalized(item.caption, activeLocale, defaultLocale) ||
						pickLocalized(item.url, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled media"
					addLabel={<Trans>Add photo or video</Trans>}
					deleteLabel={<Trans>Delete item</Trans>}
					renderFields={(item, _index, update) => {
						const mediaType =
							item.type === 'video' || isGalleryVideoUrl(item.url)
								? 'video'
								: 'image'
						return (
							<>
								<FieldAssetUpload
									label="Upload"
									accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
									onUpload={(file) => {
										update({
											type: file.type.startsWith('video/') ? 'video' : 'image',
										})
										editorProps.onUploadAsset?.(file)
									}}
									isUploading={editorProps.isUploadingAsset}
									uploadedUrl={editorProps.uploadedAssetUrl}
									uploadError={editorProps.uploadError}
									onUrlReady={(url) =>
										update({
											url,
											type: isGalleryVideoUrl(url) ? 'video' : 'image',
										})
									}
								/>
								<div className="space-y-1.5">
									<Label className="text-muted-foreground text-xs font-medium">
										<Trans>Media URL</Trans>
									</Label>
									<LocalizedInput
										value={item.url}
										onChange={(val) =>
											update({
												url: val,
												type: isGalleryVideoUrl(val) ? 'video' : 'image',
											})
										}
										placeholder="https://… or /resources/…"
									/>
								</div>
								<FieldChoice
									label={<Trans>Type</Trans>}
									value={mediaType}
									onChange={(val) => update({ type: val })}
									options={[
										{ value: 'image', label: <Trans>Photo</Trans> },
										{ value: 'video', label: <Trans>Video</Trans> },
									]}
								/>
								{item.url ? (
									<div className="border-border bg-muted overflow-hidden rounded-md border">
										{mediaType === 'video' ? (
											<video
												src={item.url}
												className="aspect-square w-full object-cover"
												muted
												playsInline
												controls
											/>
										) : (
											<img
												src={item.url}
												alt=""
												className="aspect-square w-full object-cover"
											/>
										)}
									</div>
								) : null}
								<div className="space-y-1.5">
									<Label className="text-muted-foreground text-xs font-medium">
										<Trans>Alt text</Trans>
									</Label>
									<LocalizedInput
										value={item.alt}
										onChange={(val) => update({ alt: val })}
										placeholder="Alt text"
									/>
								</div>
								<div className="space-y-1.5">
									<Label className="text-muted-foreground text-xs font-medium">
										<Trans>Caption</Trans>
									</Label>
									<LocalizedInput
										value={item.caption}
										onChange={(val) => update({ caption: val })}
										placeholder="Caption (optional)"
									/>
								</div>
							</>
						)
					}}
				/>
			</EditorSection>
		</div>
	)
}

function CardsEditor({ config, updateField, listKey }: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const items =
		(config.items as Array<{
			title: string
			description: string
			imageUrl: string
			linkUrl: unknown
			ctaLabel?: string
		}>) ?? []

	return (
		<div className="space-y-4">
			<FieldInput
				label="Title"
				value={(config.title as string) ?? ''}
				onChange={(v) => updateField('title', v)}
			/>
			<EditorSection title={<Trans>Style</Trans>}>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Cards</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:cards`}
					items={items}
					onChange={(next) => updateField('items', next)}
					createItem={() => ({
						title: '',
						description: '',
						imageUrl: '',
						linkUrl: '',
					})}
					getTitle={(item) =>
						pickLocalized(item.title, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled card"
					addLabel={<Trans>Add card</Trans>}
					deleteLabel={<Trans>Delete card</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Title</Trans>
								</Label>
								<LocalizedInput
									value={item.title}
									onChange={(val) => update({ title: val })}
									placeholder="Card title"
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Description</Trans>
								</Label>
								<LocalizedTextarea
									value={item.description}
									onChange={(val) => update({ description: val })}
									placeholder="Description"
									rows={3}
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Image URL</Trans>
								</Label>
								<LocalizedInput
									value={item.imageUrl}
									onChange={(val) => update({ imageUrl: val })}
									placeholder="Image URL"
								/>
							</div>
							<LinkInspector
								value={item.linkUrl}
								text={item.ctaLabel ?? ''}
								onChange={(link) => update({ linkUrl: link })}
								onTextChange={(ctaLabel) => update({ ctaLabel })}
								showText
								TextInput={LocalizedInput}
								textPlaceholder="Learn more"
							/>
						</>
					)}
				/>
			</div>
		</div>
	)
}

function FormBlockEditor({ config, updateField }: EditorProps) {
	const { websiteForms } = useLoaderData<typeof loader>()
	const formId = String(config.formId || '')
	const publishedForms = websiteForms.filter(
		(form) => form.status === 'published',
	)
	return (
		<div className="space-y-5">
			<EditorSection title={<Trans>Form</Trans>}>
				<div className="space-y-2">
					<Label htmlFor="block-form">
						<Trans>Connected form</Trans>
					</Label>
					<select
						id="block-form"
						value={formId}
						onChange={(event) => {
							const selected = publishedForms.find(
								(form) => form.id === event.target.value,
							)
							updateField('formId', event.target.value)
							updateField('formName', selected?.name ?? '')
						}}
						className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
					>
						<option value="">
							<Trans>Select a form</Trans>
						</option>
						{publishedForms.map((form) => (
							<option key={form.id} value={form.id}>
								{form.name}
							</option>
						))}
					</select>
					{publishedForms.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								Create and publish a form from Website → Forms first.
							</Trans>
						</p>
					) : null}
				</div>
			</EditorSection>
			<EditorSection title={<Trans>Display</Trans>}>
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="form-show-title">
						<Trans>Show form title</Trans>
					</Label>
					<Switch
						id="form-show-title"
						checked={config.showTitle !== false}
						onCheckedChange={(checked) => updateField('showTitle', checked)}
					/>
				</div>
			</EditorSection>
		</div>
	)
}

function VideoEditor({ config, updateField }: EditorProps) {
	return (
		<div className="space-y-4">
			<FieldInput
				label="Title"
				value={(config.title as string) ?? ''}
				onChange={(v) => updateField('title', v)}
			/>
			<FieldInput
				label="Video URL"
				value={(config.videoUrl as string) ?? ''}
				onChange={(v) => updateField('videoUrl', v)}
			/>
			<EditorSection title={<Trans>Style</Trans>}>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>
			<div className="border-border flex items-center justify-between rounded-lg border px-3 py-2.5">
				<Label htmlFor="autoplay" className="cursor-pointer text-sm">
					<Trans>Autoplay</Trans>
				</Label>
				<Switch
					id="autoplay"
					size="sm"
					checked={(config.autoplay as boolean) ?? false}
					onCheckedChange={(checked) => updateField('autoplay', checked)}
				/>
			</div>
		</div>
	)
}

function CtaEditor({ config, updateField, ...editorProps }: EditorProps) {
	const variant = (config.variant as string) ?? 'overlay'
	return (
		<div className="space-y-6">
			<EditorSection title={<Trans>Content</Trans>}>
				<FieldInput
					label="Heading"
					value={(config.heading as string) ?? ''}
					onChange={(v) => updateField('heading', v)}
				/>
				<FieldTextarea
					label="Description"
					value={(config.description as string) ?? ''}
					onChange={(v) => updateField('description', v)}
					rows={3}
				/>
			</EditorSection>

			<EditorSection title={<Trans>Style</Trans>}>
				<FieldChoice
					label={<Trans>Look</Trans>}
					value={variant}
					onChange={(v) => updateField('variant', v)}
					options={[
						{
							value: 'overlay',
							label: <Trans>Photo + card</Trans>,
							preview: <CtaStyleSketch variant="overlay" />,
						},
						{
							value: 'solid',
							label: <Trans>Solid banner</Trans>,
							preview: <CtaStyleSketch variant="solid" />,
						},
					]}
				/>
				<SectionBackgroundField
					value={(config.background as string) ?? 'none'}
					onChange={(v) => updateField('background', v)}
				/>
				{variant === 'overlay' ? (
					<>
						<FieldAssetUpload
							label="Background photo"
							accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
							onUpload={editorProps.onUploadAsset}
							isUploading={editorProps.isUploadingAsset}
							uploadedUrl={editorProps.uploadedAssetUrl}
							uploadError={editorProps.uploadError}
							onUrlReady={(url) => updateField('imageUrl', url)}
						/>
						<FieldInput
							label="Photo URL"
							value={(config.imageUrl as string) ?? ''}
							onChange={(v) => updateField('imageUrl', v)}
						/>
						<FieldChoice
							label={<Trans>Card position</Trans>}
							value={(config.cardPosition as string) ?? 'left'}
							onChange={(v) => updateField('cardPosition', v)}
							options={[
								{
									value: 'left',
									label: <Trans>Left</Trans>,
									preview: <CardPositionSketch position="left" />,
								},
								{
									value: 'center',
									label: <Trans>Center</Trans>,
									preview: <CardPositionSketch position="center" />,
								},
								{
									value: 'right',
									label: <Trans>Right</Trans>,
									preview: <CardPositionSketch position="right" />,
								},
							]}
						/>
					</>
				) : null}
			</EditorSection>

			<EditorSection title={<Trans>Buttons</Trans>}>
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs font-medium">
						<Trans>Primary button</Trans>
					</p>
					<LinkInspector
						value={config.primaryUrl}
						text={(config.primaryLabel as string) ?? ''}
						onChange={(link) => updateField('primaryUrl', link)}
						onTextChange={(v) => updateField('primaryLabel', v)}
						showText
						TextInput={LocalizedInput}
					/>
				</div>
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs font-medium">
						<Trans>Secondary button</Trans>
					</p>
					<LinkInspector
						value={config.secondaryUrl}
						text={(config.secondaryLabel as string) ?? ''}
						onChange={(link) => updateField('secondaryUrl', link)}
						onTextChange={(v) => updateField('secondaryLabel', v)}
						showText
						TextInput={LocalizedInput}
					/>
				</div>
			</EditorSection>
		</div>
	)
}

function TestimonialsEditor({ config, updateField, listKey }: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const items =
		(config.items as Array<{ quote: string; name: string; rating: number }>) ??
		[]

	return (
		<div className="space-y-4">
			<FieldInput
				label="Title"
				value={(config.title as string) ?? ''}
				onChange={(v) => updateField('title', v)}
			/>
			<FieldInput
				label="Subtitle"
				value={(config.subtitle as string) ?? ''}
				onChange={(v) => updateField('subtitle', v)}
			/>
			<EditorSection title={<Trans>Style</Trans>}>
				<SectionBackgroundField
					value={(config.background as string) ?? 'muted'}
					onChange={(v) => updateField('background', v)}
				/>
			</EditorSection>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Reviews</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:testimonials`}
					items={items}
					onChange={(next) => updateField('items', next)}
					createItem={() => ({ quote: '', name: '', rating: 5 })}
					getTitle={(item) =>
						pickLocalized(item.name, activeLocale, defaultLocale) ||
						pickLocalized(item.quote, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled review"
					addLabel={<Trans>Add review</Trans>}
					deleteLabel={<Trans>Delete review</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Quote</Trans>
								</Label>
								<LocalizedTextarea
									value={item.quote}
									onChange={(val) => update({ quote: val })}
									placeholder="What they said"
									rows={3}
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Name</Trans>
								</Label>
								<LocalizedInput
									value={item.name}
									onChange={(val) => update({ name: val })}
									placeholder="Alex Rivera"
								/>
							</div>
							<FieldStars
								label={<Trans>Rating</Trans>}
								value={item.rating ?? 5}
								onChange={(val) => update({ rating: val })}
							/>
						</>
					)}
				/>
			</div>
		</div>
	)
}

function FooterEditor({ config, updateField, listKey }: ListEditorProps) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const columns =
		(config.columns as Array<{
			title: string
			links: Array<{ label: string; url: unknown }>
		}>) ?? []
	const socials =
		(config.socials as Array<{ platform: string; url: unknown }>) ?? []

	return (
		<div className="space-y-5">
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					The footer is shared across every page. Leave copyright blank to use
					the organization name and current year.
				</Trans>
			</p>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Link columns</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:footer-columns`}
					items={columns}
					onChange={(next) => updateField('columns', next)}
					createItem={() => ({
						title: '',
						links: [{ label: '', url: '' }],
					})}
					getTitle={(item) =>
						pickLocalized(item.title, activeLocale, defaultLocale)
					}
					emptyTitle="Untitled column"
					addLabel={<Trans>Add column</Trans>}
					deleteLabel={<Trans>Delete column</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Title</Trans>
								</Label>
								<LocalizedInput
									value={item.title}
									onChange={(val) => update({ title: val })}
									placeholder="Explore"
								/>
							</div>
							{(item.links ?? []).map((link, linkIndex) => (
								<div
									key={linkIndex}
									className="border-border space-y-2 rounded-md border p-2"
								>
									<LinkInspector
										value={link.url}
										text={link.label}
										onChange={(nextLink) => {
											const next = [...(item.links ?? [])]
											next[linkIndex] = {
												...next[linkIndex]!,
												url: nextLink,
											}
											update({ links: next })
										}}
										onTextChange={(val) => {
											const next = [...(item.links ?? [])]
											next[linkIndex] = { ...next[linkIndex]!, label: val }
											update({ links: next })
										}}
										showText
										TextInput={LocalizedInput}
									/>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2"
										onClick={() =>
											update({
												links: (item.links ?? []).filter(
													(_, i) => i !== linkIndex,
												),
											})
										}
									>
										<Trans>Remove link</Trans>
									</Button>
								</div>
							))}
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									update({
										links: [...(item.links ?? []), { label: '', url: '' }],
									})
								}
							>
								<Trans>Add link</Trans>
							</Button>
							<br />
						</>
					)}
				/>
			</div>
			<FieldSwitch
				label="Show call to action"
				checked={(config.showCta as boolean) ?? true}
				onChange={(v) => updateField('showCta', v)}
			/>
			<LinkInspector
				value={config.ctaUrl}
				text={(config.ctaLabel as string) ?? ''}
				onChange={(link) => updateField('ctaUrl', link)}
				onTextChange={(v) => updateField('ctaLabel', v)}
				showText
				TextInput={LocalizedInput}
			/>
			<div className="space-y-2">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Social links</Trans>
				</Label>
				<SortableItemList
					listKey={`${listKey}:socials`}
					items={socials}
					onChange={(next) => updateField('socials', next)}
					createItem={() => ({
						platform: '',
						url: { type: 'url', url: '', openIn: 'blank' },
					})}
					getTitle={(item) => item.platform}
					emptyTitle="Untitled profile"
					addLabel={<Trans>Add social link</Trans>}
					deleteLabel={<Trans>Delete social link</Trans>}
					renderFields={(item, _index, update) => (
						<>
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs font-medium">
									<Trans>Platform</Trans>
								</Label>
								<Input
									value={item.platform}
									onChange={(e) => update({ platform: e.target.value })}
									placeholder="Instagram"
								/>
							</div>
							<LinkInspector
								value={item.url}
								onChange={(link) => update({ url: link })}
							/>
						</>
					)}
				/>
			</div>
			<FieldInput
				label="Copyright"
				value={(config.copyright as string) ?? ''}
				onChange={(v) => updateField('copyright', v)}
				placeholder="Leave blank for automatic copyright"
			/>
		</div>
	)
}

// --- Shared Field Components ---
function FieldInput({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-muted-foreground text-xs font-medium">
				{label}
			</Label>
			<LocalizedInput
				value={value}
				onChange={onChange}
				placeholder={placeholder}
			/>
		</div>
	)
}

function FieldTextarea({
	label,
	value,
	onChange,
	placeholder,
	rows = 3,
	allowHtml = false,
}: {
	label: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
	rows?: number
	allowHtml?: boolean
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-muted-foreground text-xs font-medium">
				{label}
			</Label>
			<LocalizedTextarea
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				rows={rows}
				allowHtml={allowHtml}
			/>
		</div>
	)
}

function EditorSection({
	title,
	children,
}: {
	title: ReactNode
	children: ReactNode
}) {
	return (
		<section className="space-y-3">
			<h3 className="text-sm font-medium">{title}</h3>
			<div className="space-y-3">{children}</div>
		</section>
	)
}

type ChoiceOption = {
	value: string
	label: ReactNode
	preview?: ReactNode
	ariaLabel?: string
}

function FieldChoice({
	label,
	value,
	onChange,
	options,
}: {
	label: ReactNode
	value: string
	onChange: (value: string) => void
	options: ChoiceOption[]
}) {
	const labelId = useId()
	const hasPreview = options.some((option) => Boolean(option.preview))
	const cols = options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'

	const moveSelection = (direction: 1 | -1) => {
		const index = options.findIndex((option) => option.value === value)
		const next = options[(index + direction + options.length) % options.length]
		if (next) onChange(next.value)
	}

	return (
		<div className="space-y-1.5">
			<div id={labelId} className="text-muted-foreground text-xs font-medium">
				{label}
			</div>
			<div
				role="radiogroup"
				aria-labelledby={labelId}
				className={
					hasPreview
						? cn('grid gap-1.5', cols)
						: 'bg-muted flex rounded-lg p-0.5'
				}
				onKeyDown={(event) => {
					if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
						event.preventDefault()
						moveSelection(1)
					}
					if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
						event.preventDefault()
						moveSelection(-1)
					}
				}}
			>
				{options.map((option) => {
					const selected = option.value === value
					return (
						<button
							key={option.value}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-label={option.ariaLabel}
							onClick={() => onChange(option.value)}
							className={
								hasPreview
									? cn(
											'border-border hover:bg-muted/50 focus-visible:ring-ring flex min-w-0 flex-col items-stretch gap-1.5 rounded-xl border p-2 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2',
											selected
												? 'border-foreground/30 bg-muted'
												: 'bg-background',
										)
									: cn(
											'text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-8 min-w-0 flex-1 items-center justify-center rounded-md px-2 py-1.5 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:ring-2',
											selected && 'bg-background text-foreground shadow-sm',
										)
							}
						>
							{option.preview}
							<span
								className={cn(
									hasPreview &&
										'text-center text-[11px] leading-tight font-medium',
									!hasPreview && 'truncate',
								)}
							>
								{option.label}
							</span>
						</button>
					)
				})}
			</div>
		</div>
	)
}

function SketchFrame({
	children,
	className,
}: {
	children: ReactNode
	className?: string
}) {
	return (
		<span
			aria-hidden
			className={cn(
				'border-border/80 bg-background flex h-9 w-full items-center overflow-hidden rounded-md border p-1',
				className,
			)}
		>
			{children}
		</span>
	)
}

function TextLines({
	align = 'start',
	dense = false,
}: {
	align?: 'start' | 'center'
	dense?: boolean
}) {
	return (
		<span
			className={cn(
				'flex min-w-0 flex-1 flex-col gap-0.5',
				align === 'center' && 'items-center',
			)}
		>
			<span
				className={cn(
					'bg-foreground/30 h-1 rounded-full',
					dense ? 'w-3/5' : 'w-[70%]',
				)}
			/>
			<span className="bg-foreground/15 h-1 w-full rounded-full" />
			{dense ? null : (
				<span className="bg-foreground/15 h-1 w-[55%] rounded-full" />
			)}
		</span>
	)
}

function LayoutSketch({ variant }: { variant: 'text' | 'split' | 'brand' }) {
	if (variant === 'text') {
		return (
			<SketchFrame>
				<TextLines />
			</SketchFrame>
		)
	}
	return (
		<SketchFrame className="gap-1">
			<span
				className={cn(
					'h-full flex-1 rounded-sm',
					variant === 'brand' ? 'bg-foreground/35' : 'bg-foreground/20',
				)}
			/>
			<TextLines dense />
		</SketchFrame>
	)
}

function AlignSketch({ align }: { align: 'left' | 'center' }) {
	return (
		<SketchFrame className="items-end">
			<TextLines align={align === 'center' ? 'center' : 'start'} dense />
		</SketchFrame>
	)
}

function OverlaySketch({ overlay }: { overlay: 'none' | 'dark' | 'gradient' }) {
	return (
		<span
			aria-hidden
			className="relative flex h-9 w-full overflow-hidden rounded-md"
		>
			<span className="absolute inset-0 bg-[linear-gradient(135deg,#94a3b8_0%,#64748b_100%)]" />
			{overlay === 'dark' ? (
				<span className="absolute inset-0 bg-black/55" />
			) : null}
			{overlay === 'gradient' ? (
				<span className="absolute inset-0 bg-linear-to-t from-black/70 to-transparent" />
			) : null}
			<span className="relative mt-auto mb-1 ml-1 h-1 w-1/3 rounded-full bg-white/80" />
		</span>
	)
}

function SurfaceSketch({
	surface,
}: {
	surface: 'none' | 'muted' | 'inverted'
}) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex h-9 w-full items-center justify-center rounded-md border',
				surface === 'none' && 'border-border bg-background',
				surface === 'muted' && 'bg-muted border-transparent',
				surface === 'inverted' && 'bg-foreground border-transparent',
			)}
		>
			<span
				className={cn(
					'h-1 w-1/2 rounded-full',
					surface === 'inverted' ? 'bg-background/70' : 'bg-foreground/30',
				)}
			/>
		</span>
	)
}

function SectionBackgroundField({
	value,
	onChange,
}: {
	value: string
	onChange: (value: string) => void
}) {
	return (
		<FieldChoice
			label={<Trans>Background</Trans>}
			value={value}
			onChange={onChange}
			options={[
				{
					value: 'none',
					label: <Trans>Plain</Trans>,
					preview: <SurfaceSketch surface="none" />,
				},
				{
					value: 'muted',
					label: <Trans>Muted</Trans>,
					preview: <SurfaceSketch surface="muted" />,
				},
				{
					value: 'inverted',
					label: <Trans>Inverted</Trans>,
					preview: <SurfaceSketch surface="inverted" />,
				},
			]}
		/>
	)
}

function ColumnsSketch({ count }: { count: 2 | 3 | 4 }) {
	return (
		<SketchFrame className="gap-0.5">
			{Array.from({ length: count }, (_, index) => (
				<span
					key={index}
					className="bg-foreground/20 h-full flex-1 rounded-sm"
				/>
			))}
		</SketchFrame>
	)
}

function ShapeSketch({ shape }: { shape: 'rounded' | 'circle' | 'square' }) {
	return (
		<span aria-hidden className="flex h-9 w-full items-center justify-center">
			<span
				className={cn(
					'bg-foreground/20 size-7',
					shape === 'circle' && 'rounded-full',
					shape === 'rounded' && 'rounded-md',
					shape === 'square' && 'rounded-none',
				)}
			/>
		</span>
	)
}

function GapSketch({ gap }: { gap: 'none' | 'sm' | 'md' | 'lg' }) {
	return (
		<SketchFrame
			className={
				gap === 'none'
					? 'gap-0 p-0'
					: gap === 'sm'
						? 'gap-0.5'
						: gap === 'md'
							? 'gap-1.5'
							: 'gap-2.5'
			}
		>
			<span className="bg-foreground/20 h-full flex-1 rounded-sm" />
			<span className="bg-foreground/20 h-full flex-1 rounded-sm" />
		</SketchFrame>
	)
}

function CardPositionSketch({
	position,
}: {
	position: 'left' | 'center' | 'right'
}) {
	return (
		<span
			aria-hidden
			className="relative flex h-9 w-full overflow-hidden rounded-md bg-[linear-gradient(135deg,#94a3b8,#64748b)] p-1"
		>
			<span
				className={cn(
					'bg-background/90 h-full w-[45%] rounded-sm',
					position === 'left' && 'mr-auto',
					position === 'center' && 'mx-auto',
					position === 'right' && 'ml-auto',
				)}
			/>
		</span>
	)
}

function CtaStyleSketch({ variant }: { variant: 'overlay' | 'solid' }) {
	if (variant === 'solid') {
		return (
			<span
				aria-hidden
				className="bg-foreground flex h-9 w-full flex-col items-center justify-center gap-0.5 rounded-md px-2"
			>
				<span className="h-1 w-2/3 rounded-full bg-white/80" />
				<span className="h-1 w-1/2 rounded-full bg-white/40" />
			</span>
		)
	}
	return <CardPositionSketch position="left" />
}

function HeightSketch({ size }: { size: 'short' | 'medium' | 'tall' }) {
	return (
		<span aria-hidden className="flex h-9 w-full items-end justify-center px-2">
			<span
				className={cn(
					'bg-foreground/20 w-full rounded-sm',
					size === 'short' && 'h-3',
					size === 'medium' && 'h-5',
					size === 'tall' && 'h-7',
				)}
			/>
		</span>
	)
}

const HERO_HEIGHTS = [
	{ value: 400, key: 'short' as const, label: <Trans>Short</Trans> },
	{ value: 560, key: 'medium' as const, label: <Trans>Medium</Trans> },
	{ value: 720, key: 'tall' as const, label: <Trans>Tall</Trans> },
]

function nearestHeroHeight(value: number) {
	return HERO_HEIGHTS.reduce((closest, option) =>
		Math.abs(option.value - value) < Math.abs(closest.value - value)
			? option
			: closest,
	).value
}

function FieldStars({
	label,
	value,
	onChange,
}: {
	label: ReactNode
	value: number
	onChange: (value: number) => void
}) {
	const labelId = useId()
	return (
		<div className="space-y-1.5">
			<div id={labelId} className="text-muted-foreground text-xs font-medium">
				{label}
			</div>
			<div
				role="radiogroup"
				aria-labelledby={labelId}
				className="flex items-center gap-0.5"
			>
				{[1, 2, 3, 4, 5].map((rating) => {
					const selected = rating === value
					const filled = rating <= value
					return (
						<button
							key={rating}
							type="button"
							role="radio"
							aria-checked={selected}
							aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
							onClick={() => onChange(rating)}
							className={cn(
								'focus-visible:ring-ring flex size-8 items-center justify-center rounded-md transition-colors duration-150 outline-none focus-visible:ring-2',
								filled
									? 'text-foreground'
									: 'text-muted-foreground/40 hover:text-muted-foreground',
							)}
						>
							<svg viewBox="0 0 24 24" className="size-4" aria-hidden>
								<path
									d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z"
									fill={filled ? 'currentColor' : 'none'}
									stroke="currentColor"
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth="2"
								/>
							</svg>
						</button>
					)
				})}
			</div>
		</div>
	)
}

function FieldSwitch({
	label,
	checked,
	onChange,
}: {
	label: string
	checked: boolean
	onChange: (value: boolean) => void
}) {
	const id = useId()
	return (
		<div className="flex items-center justify-between gap-3">
			<Label
				htmlFor={id}
				className="text-muted-foreground cursor-pointer text-xs font-medium"
			>
				{label}
			</Label>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</div>
	)
}

function FieldAssetUpload({
	label,
	accept,
	onUpload,
	isUploading,
	uploadedUrl,
	uploadError,
	onUrlReady,
}: {
	label: string
	accept: string
	onUpload?: (file: File) => void
	isUploading?: boolean
	uploadedUrl?: string | null
	uploadError?: string | null
	onUrlReady: (url: string) => void
}) {
	const fileInputRef = useRef<HTMLInputElement>(null)
	const isPendingRef = useRef(false)

	// When upload completes successfully, trigger the callback if we initiated it
	useEffect(() => {
		if (uploadedUrl && isPendingRef.current && !isUploading) {
			isPendingRef.current = false
			onUrlReady(uploadedUrl)
		}
	}, [uploadedUrl, isUploading, onUrlReady])

	return (
		<div className="space-y-1.5">
			<Label className="text-muted-foreground text-xs font-medium">
				{label}
			</Label>
			<div className="flex flex-col gap-2">
				<input
					ref={fileInputRef}
					type="file"
					accept={accept}
					className="sr-only"
					onChange={(e) => {
						const file = e.currentTarget.files?.[0]
						if (file && onUpload) {
							isPendingRef.current = true
							onUpload(file)
						}
						e.currentTarget.value = ''
					}}
				/>
				<Button
					variant="outline"
					size="sm"
					className="w-full justify-start"
					disabled={isUploading}
					onClick={() => fileInputRef.current?.click()}
				>
					{isUploading ? <Spinner className="mr-2" /> : null}
					<Trans>Upload file</Trans>
				</Button>
				{uploadError && (
					<p className="text-destructive text-xs" role="alert">
						{uploadError}
					</p>
				)}
			</div>
		</div>
	)
}

type InspectorId = 'sections' | 'branding' | 'page'

function InspectorTabs({
	value,
	onChange,
}: {
	value: InspectorId
	onChange: (next: InspectorId) => void
}) {
	const items = [
		{
			id: 'sections' as const,
			icon: 'blocks' as const,
			label: <Trans>Sections</Trans>,
			ariaLabel: 'Sections',
		},
		{
			id: 'branding' as const,
			icon: 'paintbrush' as const,
			label: <Trans>Branding</Trans>,
			ariaLabel: 'Branding',
		},
		{
			id: 'page' as const,
			icon: 'file-text' as const,
			label: <Trans>Page Settings</Trans>,
			ariaLabel: 'Page Settings',
		},
	]

	return (
		<nav aria-label="Builder panels" className="flex items-center">
			<div
				role="tablist"
				aria-orientation="horizontal"
				className="flex items-center gap-0.5"
			>
				{items.map((item) => {
					const selected = value === item.id
					return (
						<Tooltip key={item.id}>
							<TooltipTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										role="tab"
										aria-selected={selected}
										aria-label={item.ariaLabel}
										className={cn(
											'text-muted-foreground relative rounded-md transition-colors duration-150 ease-out',
											'hover:text-foreground hover:bg-muted',
											'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
											selected &&
												'text-foreground bg-muted hover:bg-muted hover:text-foreground',
										)}
										onClick={() => onChange(item.id)}
									>
										<Icon name={item.icon} className="size-4" />
									</Button>
								}
							/>
							<TooltipContent side="bottom">{item.label}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</nav>
	)
}

// ==============================================
// Main Builder Component
// ==============================================
export default function PageBuilderRoute() {
	const {
		organization,
		page,
		themeConfig: initialTheme,
		sitePages,
	} = useLoaderData<typeof loader>()
	const [themeConfig, setThemeConfig] = useState(initialTheme)

	useAIPanelHotkey()
	const {
		isOpen: isAIPanelOpen,
		isExpanded: isAIPanelExpanded,
		toggle: toggleAIPanel,
	} = useAIPanel()

	useEffect(() => {
		const handleThemeChange = (e: any) => setThemeConfig(e.detail)
		window.addEventListener('epic-preview-theme-change', handleThemeChange)
		return () =>
			window.removeEventListener('epic-preview-theme-change', handleThemeChange)
	}, [])
	const params = useParams()
	const sectionFetcher = useFetcher()
	const pageSettingsFetcher = useFetcher<{
		status: string
		result?: { error?: { slug?: string[] } }
		error?: string
	}>()
	const pageImageFetcher = useFetcher<{
		status: string
		seoImageUrl?: string
		error?: string
	}>()
	const blockAssetFetcher = useFetcher<{
		status: string
		assetUrl?: string
		error?: string
	}>()
	const publishFetcher = useFetcher<typeof action>()

	const { locales } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const [activeLocale, setActiveLocale] = useState<string>(defaultLocale)

	const linkPages = useMemo(
		() =>
			sitePages.map((item) => ({
				id: item.id,
				slug: item.slug,
				isHomePage: item.isHomePage,
				title:
					pickLocalized(
						item.title as LocalizedString | string | null,
						activeLocale,
						defaultLocale,
					) ||
					item.slug ||
					'Untitled page',
			})),
		[sitePages, activeLocale, defaultLocale],
	)

	const [previewUrl, setPreviewUrl] = useState('')
	const [iframeKey, setIframeKey] = useState(Date.now())

	useEffect(() => {
		if (typeof window !== 'undefined') {
			const origin = window.location.origin
			let siteOrigin = origin
			if (organization.customDomain) {
				siteOrigin = origin.replace(
					window.location.hostname,
					organization.customDomain,
				)
			} else {
				siteOrigin = origin.replace('app.', `${organization.slug}.`)
			}
			setPreviewUrl(
				`${siteOrigin}${getLocaleHref(
					page.isHomePage || page.slug === '' ? '/' : `/${page.slug}`,
					activeLocale,
					activeLocale,
					defaultLocale,
				)}?preview=true`,
			)
		}
	}, [
		organization.customDomain,
		organization.slug,
		page.isHomePage,
		page.slug,
		activeLocale,
		defaultLocale,
	])

	useEffect(() => {
		const frame = iframeRef.current
		if (frame?.contentWindow && previewUrl) {
			const targetOrigin = new URL(previewUrl).origin
			frame.contentWindow.postMessage(
				{
					type: 'epic-preview-update',
					sections: page.sections,
					theme: themeConfig,
				},
				targetOrigin,
			)
		}
	}, [page.sections, themeConfig, previewUrl])

	const [mode, setMode] = useState<'build' | 'preview'>('build')
	// Page builder split is desktop-first (matches `lg:` preview visibility).
	const [isLg, setIsLg] = useState(true)
	const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>(
		'desktop',
	)

	useEffect(() => {
		const mql = window.matchMedia('(min-width: 1024px)')
		const onChange = () => setIsLg(mql.matches)
		onChange()
		mql.addEventListener('change', onChange)
		return () => mql.removeEventListener('change', onChange)
	}, [])
	const previewFrameRef = useRef<HTMLDivElement>(null)
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const previewViewportRef = useRef(previewViewport)
	const [previewDesktopWidth, setPreviewDesktopWidth] = useState<number | null>(
		null,
	)

	previewViewportRef.current = previewViewport

	const measurePreviewDesktopWidth = useCallback(() => {
		const frame = previewFrameRef.current
		if (!frame) return
		const styles = getComputedStyle(frame)
		setPreviewDesktopWidth(
			frame.clientWidth -
				parseFloat(styles.paddingLeft) -
				parseFloat(styles.paddingRight),
		)
	}, [])

	useLayoutEffect(() => {
		if (previewViewportRef.current !== 'desktop') return
		measurePreviewDesktopWidth()
	}, [mode, previewUrl, measurePreviewDesktopWidth])

	useEffect(() => {
		const frame = previewFrameRef.current
		if (!frame) return

		const onResize = () => {
			// Freeze width while in mobile so padding changes don't retarget the morph.
			if (previewViewportRef.current !== 'desktop') return
			measurePreviewDesktopWidth()
		}

		const observer = new ResizeObserver(onResize)
		observer.observe(frame)
		return () => observer.disconnect()
	}, [mode, previewUrl, measurePreviewDesktopWidth])

	// After returning to desktop, remasure once the padding morph has settled.
	useEffect(() => {
		if (previewViewport !== 'desktop') return
		const timeoutId = window.setTimeout(measurePreviewDesktopWidth, 200)
		return () => window.clearTimeout(timeoutId)
	}, [previewViewport, measurePreviewDesktopWidth])

	const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
		null,
	)
	const [searchParams] = useSearchParams()
	const initialInspector: InspectorId =
		searchParams.get('panel') === 'branding' ? 'branding' : 'sections'
	const [inspector, setInspector] = useState<InspectorId>(initialInspector)
	const handlePreviewRefresh = useCallback(() => {
		setIframeKey(Date.now())
	}, [])
	const [createPageOpen, setCreatePageOpen] = useState(false)
	const selectedSection = useMemo(
		() => page.sections.find((s) => s.id === selectedSectionId) ?? null,
		[page.sections, selectedSectionId],
	)

	const handleUpdatePageSettings = useCallback(
		(settings: {
			slug: string
			seoTitle: string
			seoDescription: string
			seoImageUrl: string
			seoNoIndex: boolean
		}) => {
			void pageSettingsFetcher.submit(
				{
					intent: updatePageSettingsIntent,
					slug: settings.slug,
					seoTitle: settings.seoTitle,
					seoDescription: settings.seoDescription,
					seoImageUrl: settings.seoImageUrl,
					seoNoIndex: String(settings.seoNoIndex),
				},
				{ method: 'POST' },
			)
		},
		[pageSettingsFetcher],
	)

	const handleUploadPageImage = useCallback(
		(file: File) => {
			const mimeType = file.type || guessImageMimeType(file.name)
			const safeFile = new File(
				[file],
				`page-image.${extensionForImageMime(mimeType || 'image/jpeg')}`,
				{
					type: mimeType || 'image/jpeg',
					lastModified: Date.now(),
				},
			)
			const formData = new FormData()
			formData.append('intent', uploadPageImageIntent)
			formData.append('imageFile', safeFile)
			void pageImageFetcher.submit(formData, {
				method: 'POST',
				encType: 'multipart/form-data',
			})
		},
		[pageImageFetcher],
	)

	const handleUploadBlockAsset = useCallback(
		(file: File) => {
			const mimeType = guessAssetMimeType(file.name, file.type)
			const ext = extensionForAsset(mimeType, file.name)

			const safeFile = new File([file], `asset.${ext}`, {
				type: mimeType || 'application/octet-stream',
				lastModified: Date.now(),
			})
			const formData = new FormData()
			formData.append('intent', uploadBlockAssetIntent)
			formData.append('assetFile', safeFile)
			void blockAssetFetcher.submit(formData, {
				method: 'POST',
				encType: 'multipart/form-data',
			})
		},
		[blockAssetFetcher],
	)

	const handleAddSection = useCallback(
		(type: BlockType, position: number) => {
			void sectionFetcher.submit(
				{
					intent: addSectionIntent,
					type,
					position: String(position),
				},
				{ method: 'POST' },
			)
		},
		[sectionFetcher],
	)

	const handleUpdateSection = useCallback(
		(sectionId: string, config: string) => {
			if (typeof document !== 'undefined') {
				try {
					const nextSections = page.sections.map((s) =>
						s.id === sectionId ? { ...s, config } : s,
					)
					document.cookie = `epic_preview_sections=${encodeURIComponent(JSON.stringify(nextSections))}; path=/; max-age=86400; SameSite=Lax${getSharedCookieDomain()}`
				} catch {}
			}
			void sectionFetcher.submit(
				{ intent: updateSectionIntent, sectionId, config },
				{ method: 'POST' },
			)
		},
		[sectionFetcher, page.sections],
	)

	const handleRemoveSection = useCallback(
		(sectionId: string) => {
			if (selectedSectionId === sectionId) {
				setSelectedSectionId(null)
			}
			void sectionFetcher.submit(
				{ intent: removeSectionIntent, sectionId },
				{ method: 'POST' },
			)
		},
		[sectionFetcher, selectedSectionId],
	)

	const handleReorderSections = useCallback(
		(orderedIds: string[]) => {
			void sectionFetcher.submit(
				{
					intent: reorderSectionsIntent,
					orderedIds: JSON.stringify(orderedIds),
				},
				{ method: 'POST' },
			)
		},
		[sectionFetcher],
	)

	const handlePublish = useCallback(() => {
		let themeCookie = ''
		if (typeof document !== 'undefined') {
			themeCookie =
				(document.cookie.match(/(?:^|; )epic_preview_theme=([^;]*)/) ||
					[])[1] || ''
			document.cookie = `epic_preview_sections=; path=/; max-age=0; SameSite=Lax${getSharedCookieDomain()}`
			document.cookie = `epic_preview_theme=; path=/; max-age=0; SameSite=Lax${getSharedCookieDomain()}`
		}
		const formData = new FormData()
		formData.append('intent', publishIntent)
		if (themeCookie) {
			formData.append('theme', decodeURIComponent(themeCookie))
		}
		void publishFetcher.submit(formData, { method: 'POST' })
	}, [publishFetcher])

	const handleUnpublish = useCallback(() => {
		void publishFetcher.submit({ intent: unpublishIntent }, { method: 'POST' })
	}, [publishFetcher])

	const optimisticStatus =
		publishFetcher.formData?.get('intent') === publishIntent
			? 'published'
			: publishFetcher.formData?.get('intent') === unpublishIntent
				? 'draft'
				: page.status

	const displayTitle =
		pickLocalized(page.title, activeLocale, defaultLocale) ||
		pickLocalized(page.title, defaultLocale, defaultLocale) ||
		page.title

	const liveUrl = previewUrl.replace(/\?preview=true$/, '')
	const previewHost = useMemo(() => {
		if (!previewUrl) return ''
		try {
			const parsed = new URL(previewUrl)
			return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
		} catch {
			return previewUrl
		}
	}, [previewUrl])

	const isSplitLayout = mode === 'build' && isLg

	const sectionsSidebar = (
		<aside className="border-border bg-background flex h-full min-w-0 rounded-xl">
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="border-border flex h-11 shrink-0 items-center border-b px-3">
					<InspectorTabs
						value={inspector}
						onChange={(next) => {
							setInspector(next)
							if (next !== 'sections') setSelectedSectionId(null)
						}}
					/>
				</div>
				{inspector === 'page' ? (
					<PageSettingsPanel
						page={page}
						previewHost={previewHost || `${organization.slug}.site`}
						onSave={handleUpdatePageSettings}
						onUploadImage={handleUploadPageImage}
						isUploadingImage={pageImageFetcher.state !== 'idle'}
						uploadedImageUrl={
							pageImageFetcher.data?.status === 'success'
								? pageImageFetcher.data.seoImageUrl
								: null
						}
						uploadError={
							pageImageFetcher.data?.status === 'error'
								? pageImageFetcher.data.error
								: null
						}
						slugError={
							pageSettingsFetcher.data?.status === 'error'
								? (pageSettingsFetcher.data.result?.error?.slug?.[0] ?? null)
								: null
						}
					/>
				) : inspector === 'branding' ? (
					<BrandingPanel
						organization={{ ...organization, siteIconAssets: [] }}
						themeConfig={themeConfig}
						onPreviewRefresh={handlePreviewRefresh}
					/>
				) : selectedSection ? (
					<SectionEditorPanel
						section={selectedSection}
						onBack={() => setSelectedSectionId(null)}
						onSave={handleUpdateSection}
						onUploadAsset={handleUploadBlockAsset}
						isUploadingAsset={blockAssetFetcher.state !== 'idle'}
						uploadedAssetUrl={
							blockAssetFetcher.data?.status === 'success'
								? blockAssetFetcher.data.assetUrl
								: null
						}
						uploadError={
							blockAssetFetcher.data?.status === 'error'
								? blockAssetFetcher.data.error
								: null
						}
						onOpenBranding={() => setInspector('branding')}
						siteIconKey={organization.siteIconKey}
					/>
				) : (
					<>
						<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
							<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
								<Icon name="blocks" className="size-3.5" />
							</span>
							<span className="min-w-0 truncate text-sm font-medium">
								<Trans>Sections</Trans>
							</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{page.sections.length}
							</span>
							<div className="flex-1" />
							<TranslateAllButton sections={page.sections} />
							<LocaleSwitcher />
						</div>

						<ScrollArea className="min-h-0 flex-1">
							{page.sections.length === 0 ? (
								<div className="flex flex-col items-center justify-center px-4 py-10 text-center">
									<div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-lg">
										<Icon name="blocks" className="size-5" />
									</div>
									<p className="text-sm font-medium">
										<Trans>No sections yet</Trans>
									</p>
									<p className="text-muted-foreground mt-1 mb-4 max-w-[16rem] text-xs leading-relaxed">
										<Trans>
											Add a hero, gallery, or any block between the header and
											footer.
										</Trans>
									</p>
									<AddSectionDialog position={0} onAdd={handleAddSection} />
								</div>
							) : (
								<SectionsList
									sections={page.sections}
									selectedSectionId={selectedSectionId}
									onSelect={(sectionId) => {
										setInspector('sections')
										setSelectedSectionId(sectionId)
									}}
									onRemove={handleRemoveSection}
									onReorder={handleReorderSections}
									onAdd={handleAddSection}
								/>
							)}
						</ScrollArea>
					</>
				)}
			</div>
		</aside>
	)

	const previewViewportToggle = (
		<div className="bg-muted flex rounded-lg p-0.5">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							className={cn(
								'relative rounded-md transition-[transform,background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] after:absolute after:-inset-2.5 after:content-[""] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
								previewViewport === 'desktop' &&
									'bg-background text-foreground hover:bg-background shadow-sm',
							)}
							onClick={() => setPreviewViewport('desktop')}
							aria-label="Desktop preview"
							aria-pressed={previewViewport === 'desktop'}
						>
							<Icon name="laptop" className="size-3.5" />
						</Button>
					}
				/>
				<TooltipContent>
					<Trans>Desktop</Trans>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							className={cn(
								'relative rounded-md transition-[transform,background-color,box-shadow,color] duration-150 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] after:absolute after:-inset-2.5 after:content-[""] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
								previewViewport === 'mobile' &&
									'bg-background text-foreground hover:bg-background shadow-sm',
							)}
							onClick={() => setPreviewViewport('mobile')}
							aria-label="Mobile preview"
							aria-pressed={previewViewport === 'mobile'}
						>
							<Icon name="smartphone" className="size-3.5" />
						</Button>
					}
				/>
				<TooltipContent>
					<Trans>Mobile</Trans>
				</TooltipContent>
			</Tooltip>
		</div>
	)

	const previewMain = (
		<main className="bg-muted/30 relative flex h-full min-w-0 flex-col">
			{previewUrl ? (
				<div
					ref={previewFrameRef}
					className="relative min-h-0 flex-1 overflow-hidden p-2"
				>
					<div
						className={cn(
							'bg-background mx-auto h-full w-full overflow-hidden transition-[max-width,border-radius,box-shadow] duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)] motion-reduce:transition-none',
							previewViewport === 'mobile'
								? 'max-w-93.75 rounded-[2rem] border shadow-sm'
								: 'rounded-xl border shadow-sm',
						)}
						style={{
							maxWidth:
								previewViewport === 'mobile'
									? 375
									: (previewDesktopWidth ?? '100%'),
						}}
					>
						{page.sections.length === 0 ? (
							<div className="flex h-full flex-col items-center justify-center px-6 text-center">
								<div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-lg">
									<Icon name="blocks" className="size-5" />
								</div>
								<p className="text-sm font-medium">
									<Trans>Your page will appear here</Trans>
								</p>
								<p className="text-muted-foreground mt-1 max-w-xs text-xs leading-relaxed">
									<Trans>
										Add a section from the left to see a live preview.
									</Trans>
								</p>
							</div>
						) : (
							<iframe
								key={iframeKey}
								ref={iframeRef}
								src={previewUrl}
								className="h-full w-full border-0"
								title="Live Preview"
								allow="autoplay; fullscreen; picture-in-picture"
							/>
						)}
					</div>
				</div>
			) : (
				<div className="flex flex-1 items-center justify-center">
					<Spinner />
				</div>
			)}
		</main>
	)

	return (
		<LocaleContext.Provider
			value={{ activeLocale, defaultLocale, locales, setActiveLocale }}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={defaultLocale}
			>
				<SiteLinkBuilderContext.Provider
					value={{
						pages: linkPages,
						onUploadAsset: handleUploadBlockAsset,
						isUploadingAsset: blockAssetFetcher.state !== 'idle',
						uploadedAssetUrl:
							blockAssetFetcher.data?.status === 'success'
								? blockAssetFetcher.data.assetUrl
								: null,
						uploadError:
							blockAssetFetcher.data?.status === 'error'
								? blockAssetFetcher.data.error
								: null,
					}}
				>
					<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
						<header className="border-border bg-background flex h-12 shrink-0 items-center justify-between gap-2 border-b px-2 sm:gap-3 sm:px-3">
							<div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
								<Button
									variant="ghost"
									size="icon-xs"
									render={<Link to={`/${params.orgSlug}/website/pages`} />}
									aria-label="Back to pages"
								>
									<Icon name="arrow-left" className="size-4" />
								</Button>

								<div
									className="bg-border hidden h-5 w-px sm:block"
									aria-hidden
								/>

								<div className="min-w-0">
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="sm"
													className="max-w-52 min-w-0 gap-1 px-1.5 font-medium"
													aria-label="Page menu"
												>
													<span
														className={cn(
															'size-1.5 shrink-0 rounded-full',
															optimisticStatus === 'published'
																? 'bg-emerald-500'
																: 'bg-muted-foreground/40',
														)}
														aria-hidden
													/>
													<span className="truncate" title={displayTitle}>
														{displayTitle}
													</span>
													<span className="sr-only">
														{optimisticStatus === 'published' ? (
															<Trans>Published</Trans>
														) : (
															<Trans>Draft</Trans>
														)}
													</span>
													<Icon
														name="chevron-down"
														className="text-muted-foreground size-3.5 shrink-0"
													/>
												</Button>
											}
										/>
										<DropdownMenuContent align="start" className="w-56">
											<div className="max-h-75 overflow-y-auto">
												{linkPages.map((p) => (
													<DropdownMenuItem
														key={p.id}
														render={
															<Link
																to={`/${params.orgSlug}/website/pages/${p.id}`}
																className="flex w-full items-center"
															>
																<span className="flex-1 truncate">
																	{p.title}
																</span>
																{p.isHomePage && (
																	<Badge
																		variant="outline"
																		className="ml-2 h-4 shrink-0 px-1 text-[10px]"
																	>
																		<Trans>Home</Trans>
																	</Badge>
																)}
															</Link>
														}
													/>
												))}
											</div>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onSelect={() => setCreatePageOpen(true)}
											>
												<Icon name="plus" className="mr-2 size-4" />
												<Trans>Add new page</Trans>
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>

								{page.isHomePage ? (
									<Badge variant="outline" className="hidden sm:inline-flex">
										<Trans>Home</Trans>
									</Badge>
								) : null}
							</div>

							<div className="flex shrink-0 items-center gap-1 sm:gap-2">
								<div className="hidden lg:block">{previewViewportToggle}</div>

								<div
									className="bg-border hidden h-5 w-px lg:block"
									aria-hidden
								/>

								<div className="bg-muted flex rounded-lg p-0.5 lg:hidden">
									<Button
										variant="ghost"
										size="sm"
										className={cn(
											'rounded-md px-2.5',
											mode === 'build' &&
												'bg-background text-foreground hover:bg-background shadow-sm',
										)}
										onClick={() => setMode('build')}
									>
										<Icon name="blocks" className="size-3.5" />
										<span className="hidden sm:inline">
											<Trans>Build</Trans>
										</span>
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className={cn(
											'rounded-md px-2.5',
											mode === 'preview' &&
												'bg-background text-foreground hover:bg-background shadow-sm',
										)}
										onClick={() => setMode('preview')}
									>
										<Icon name="laptop" className="size-3.5" />
										<span className="hidden sm:inline">
											<Trans>Preview</Trans>
										</span>
									</Button>
								</div>

								<div className="hidden sm:block">
									<GlobalAIToggle />
								</div>

								<Button
									size="sm"
									onClick={handlePublish}
									disabled={publishFetcher.state !== 'idle'}
								>
									{publishFetcher.state !== 'idle' ? (
										<Spinner />
									) : optimisticStatus === 'draft' ? (
										<Trans>Publish</Trans>
									) : (
										<>
											<span className="sm:hidden">
												<Trans>Update</Trans>
											</span>
											<span className="hidden sm:inline">
												<Trans>Publish updates</Trans>
											</span>
										</>
									)}
								</Button>

								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-xs"
												aria-label="More actions"
											>
												<Icon name="ellipsis" className="size-4" />
											</Button>
										}
									/>
									<DropdownMenuContent align="end" className="min-w-44">
										<DropdownMenuItem
											className="sm:hidden"
											onClick={toggleAIPanel}
										>
											<Icon name="sparkles" className="size-4" />
											<Trans>Ask AI</Trans>
										</DropdownMenuItem>
										<DropdownMenuSeparator className="sm:hidden" />
										<DropdownMenuItem onClick={() => setIframeKey(Date.now())}>
											<Icon name="refresh-cw" className="size-4" />
											<Trans>Refresh preview</Trans>
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() => {
												if (previewUrl) window.open(previewUrl, '_blank')
											}}
										>
											<Icon name="external-link" className="size-4" />
											<Trans>Open preview</Trans>
										</DropdownMenuItem>
										{optimisticStatus === 'published' ? (
											<DropdownMenuItem
												onClick={() => {
													if (liveUrl) window.open(liveUrl, '_blank')
												}}
											>
												<Icon name="laptop" className="size-4" />
												<Trans>View live site</Trans>
											</DropdownMenuItem>
										) : null}
										{!page.isHomePage && optimisticStatus === 'published' ? (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													variant="destructive"
													onClick={handleUnpublish}
													disabled={publishFetcher.state !== 'idle'}
												>
													<Trans>Unpublish</Trans>
												</DropdownMenuItem>
											</>
										) : null}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</header>
						<CreatePageDialog
							open={createPageOpen}
							onOpenChange={setCreatePageOpen}
						/>

						<div
							className={cn(
								'relative flex min-h-0 flex-1',
								isAIPanelOpen && !isAIPanelExpanded && isLg && 'pr-107',
							)}
						>
							<div className="flex min-h-0 min-w-0 flex-1">
								{isSplitLayout ? (
									<ResizablePanelGroup
										direction="horizontal"
										autoSaveId="website-page-builder"
										className="bg-muted min-h-0 flex-1"
									>
										<ResizablePanel
											id="sections"
											order={1}
											defaultSize={28}
											minSize={20}
											maxSize={40}
											className="m-2 mr-0 min-w-0 rounded-lg"
										>
											{sectionsSidebar}
										</ResizablePanel>
										<ResizableHandle withHandle className="bg-transparent" />
										<ResizablePanel
											id="preview"
											order={2}
											defaultSize={72}
											minSize={40}
											className="min-w-0"
										>
											{previewMain}
										</ResizablePanel>
									</ResizablePanelGroup>
								) : (
									<div className="min-h-0 flex-1">
										{mode === 'build' ? sectionsSidebar : previewMain}
									</div>
								)}
							</div>
						</div>
					</div>
				</SiteLinkBuilderContext.Provider>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}

function getSharedCookieDomain() {
	if (typeof window === 'undefined') return ''
	const host = window.location.hostname
	if (host === 'localhost' || host === '127.0.0.1') return ''
	if (host.endsWith('.localhost')) return '; domain=.localhost'
	const parts = host.split('.')
	if (parts.length >= 3 && (parts[0] === 'app' || parts[0] === 'admin')) {
		return '; domain=.' + parts.slice(1).join('.')
	}
	return ''
}
