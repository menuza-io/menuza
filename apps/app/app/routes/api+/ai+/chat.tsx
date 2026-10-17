import {
	handleChat,
	type PageEditorPromptContext,
	type WebsitePageListItem,
} from '@repo/ai/route-handlers'
import { createChatStream, buildNoteChatSystemPrompt } from '@repo/ai/server'
import { requireUserId } from '@repo/auth'
import { markStepCompleted } from '@repo/common/onboarding'
import { brand } from '@repo/config/brand'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	buildNavigationSystemPrompt,
	getNavigableAppRoutes,
} from '#app/utils/ai/app-nav-routes.ts'
import { getLaunchStatus } from '#app/utils/env.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import { addableBlockTypes } from '#app/utils/website/block-types.ts'

type PageSectionRow = {
	id: string
	type: string
	position: number
	config?: string
}

async function loadWebsitePages(
	organizationId: string,
): Promise<WebsitePageListItem[]> {
	const pages = await db
		.select({
			id: WebsitePage.id,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organizationId))
		.orderBy(
			desc(WebsitePage.isHomePage),
			asc(WebsitePage.position),
			asc(WebsitePage.createdAt),
		)

	if (pages.length === 0) return []

	const sections = await db
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			position: WebsitePageSection.position,
			pageId: WebsitePageSection.pageId,
		})
		.from(WebsitePageSection)
		.where(
			inArray(
				WebsitePageSection.pageId,
				pages.map((page) => page.id),
			),
		)

	const sectionsByPage = new Map<string, PageSectionRow[]>()
	for (const section of sections) {
		const list = sectionsByPage.get(section.pageId) ?? []
		list.push({
			id: section.id,
			type: section.type,
			position: section.position,
		})
		sectionsByPage.set(section.pageId, list)
	}

	return pages.map((page) => ({
		...page,
		sections: (sectionsByPage.get(page.id) ?? []).sort(
			(a, b) => a.position - b.position,
		),
	}))
}

async function loadPageContext(
	pageId: string,
	organizationId: string,
): Promise<PageEditorPromptContext['currentPage']> {
	const [page] = await db
		.select({
			id: WebsitePage.id,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.id, pageId),
				eq(WebsitePage.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!page) return null

	const sections = await db
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			config: WebsitePageSection.config,
			position: WebsitePageSection.position,
		})
		.from(WebsitePageSection)
		.where(eq(WebsitePageSection.pageId, page.id))

	sections.sort((a, b) => a.position - b.position)

	return {
		...page,
		sections,
	}
}

const getPageEditorTools = (
	organizationId: string,
	options: { reservationsOnline: boolean },
) => {
	const addableSectionTypes = addableBlockTypes(options).map(
		(block) => block.type,
	)
	return {
		getPageContext: {
			description:
				'Inspect a website page by ID. Returns title, slug, and every section with its ID, type, position, and JSON config. Call this before editing a page whose full section configs are not already in the prompt.',
			inputSchema: z.object({
				pageId: z
					.string()
					.describe(
						'The ID of the page to inspect from the website pages list',
					),
			}),
			execute: async ({ pageId }: { pageId: string }) => {
				const page = await loadPageContext(pageId, organizationId)
				if (!page) {
					return { error: 'Page not found in this organization' }
				}
				return page
			},
		},
		navigateToPage: {
			description:
				'Open a page in the website page editor. Always call this first when the user wants to change a page they are not currently viewing, then call addSection, updateSection, or removeSection. Do not use this to open app screens such as settings — use navigateToAppPage for those.',
			inputSchema: z.object({
				pageId: z.string().describe('The ID of the page to open in the editor'),
			}),
		},
		createPage: {
			description:
				'Create a new website page and open it in the page editor. Use this when the user asks to add, create, or make a new page. Choose a clear title and a valid lowercase hyphenated slug.',
			inputSchema: z.object({
				title: z
					.string()
					.min(1)
					.max(200)
					.describe('The human-readable title for the new page'),
				slug: z
					.string()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
					.max(200)
					.describe(
						'The URL slug for the new page, using lowercase letters, numbers, and hyphens',
					),
				template: z
					.enum(['blank', 'article', 'showcase'])
					.describe(
						'The starting template: blank for a custom page, article for long-form content, or showcase for a visual page',
					),
			}),
		},
		addSection: {
			description: `Add a new section (block) to a website page. Always provide a complete, useful JSON config with real content; never use placeholder text such as "Question 1" or "Answer 1". For FAQ sections, include several specific question-and-answer pairs relevant to the user's topic. Valid types: ${addableSectionTypes.join(', ')}.`,
			inputSchema: z.object({
				pageId: z.string().describe('The ID of the page to add the section to'),
				type: z
					.string()
					.describe('The type of section to add, e.g., hero, features, faq'),
				position: z
					.number()
					.describe(
						'The 0-based body position to insert the section at. Use 0 to insert at the top.',
					),
				config: z
					.string()
					.describe(
						'Complete JSON string for the section configuration. For FAQ sections, include 3-6 helpful, SEO/AEO-friendly question-and-answer pairs with no placeholders.',
					),
			}),
		},
		updateSection: {
			description:
				'Update the JSON configuration of an existing section. Use this when the user asks to modify the content of a specific section.',
			inputSchema: z.object({
				pageId: z.string().describe('The ID of the page that owns the section'),
				sectionId: z.string().describe('The ID of the section to update'),
				config: z
					.string()
					.describe(
						'The complete JSON string of the new section configuration',
					),
			}),
		},
		removeSection: {
			description: 'Remove an existing section from a page',
			inputSchema: z.object({
				pageId: z.string().describe('The ID of the page that owns the section'),
				sectionId: z.string().describe('The ID of the section to remove'),
			}),
		},
	} as Record<string, any>
}

const getNavigationTools = () =>
	({
		navigateToAppPage: {
			description:
				'Open an app screen such as organization settings, notes, marketing, billing, or the user profile. Pass the route id from the app navigation list. Use this when the user says "go to settings", "open members", "take me to billing", and similar. Do not use this to edit a website CMS page — use navigateToPage with a page ID for that.',
			inputSchema: z.object({
				routeId: z
					.string()
					.describe(
						'The id of the destination from the app navigation list, e.g. org-settings, notes, marketing-campaigns, account-profile',
					),
			}),
		},
	}) as Record<string, any>

const formatPageList = (pages: WebsitePageListItem[]) => {
	if (pages.length === 0) {
		return 'No website pages exist yet.'
	}

	return pages
		.map((page) => {
			const home = page.isHomePage ? ', home page' : ''
			const sections =
				page.sections.length === 0
					? '    (no sections)'
					: page.sections
							.map(
								(section) =>
									`    - Position: ${section.position}, ID: ${section.id}, Type: ${section.type}`,
							)
							.join('\n')
			return `- ID: ${page.id}, Title: ${page.title}, Slug: ${page.slug}${home}\n${sections}`
		})
		.join('\n')
}

const formatCurrentPage = (
	page: NonNullable<PageEditorPromptContext['currentPage']>,
) => {
	const sections =
		page.sections.length === 0
			? '(no sections)'
			: page.sections
					.map(
						(section, idx) =>
							`- Position: ${idx}, ID: ${section.id}, Type: ${section.type}, Config: ${section.config}`,
					)
					.join('\n')

	return `Title: ${page.title}
Slug: ${page.slug}
ID: ${page.id}

Current Sections (ordered by position):
${sections}`
}

const buildPageEditorSystemPrompt = (
	basePrompt: string,
	pageContext: PageEditorPromptContext,
) => `${basePrompt}

You are assisting the user in designing and editing their website pages.
You can edit ANY page in the organization, not only the page currently open.

When the user names a page (for example "home", "homepage", "about", "about us"), match it to the list below by title, slug, or the home-page flag.

Website pages:
${formatPageList(pageContext.pages)}

Currently viewing: ${
	pageContext.currentPage
		? `${pageContext.currentPage.title} (ID: ${pageContext.currentPage.id})`
		: 'the user is not in the page editor'
}

Workflow for every page change:
1. Identify the target page ID from the list (or by asking if it is ambiguous).
2. If you need that page's section configs and they are not already listed under "Currently viewing", call getPageContext with that page ID.
3. When the user asks for a new page, call createPage with a clear title, a valid lowercase hyphenated slug, and the most appropriate template. The tool opens the new page editor and returns its page ID.
4. For an existing page, call navigateToPage with that page ID so the page editor opens before addSection, updateSection, or removeSection. createPage already opens the new page editor.
5. For addSection, always provide a complete JSON config with real, topic-specific content. Never leave default placeholder values. For FAQ sections, create 3-6 concise questions and answers that directly address the user's topic and use natural language suitable for search engines and answer engines.
6. Call addSection, updateSection, or removeSection and always pass the same pageId.
7. When modifying an existing section, use the exact section ID from getPageContext or the current page state.

${
	pageContext.currentPage
		? `Current Page State:\n${formatCurrentPage(pageContext.currentPage)}`
		: ''
}
`

// Allow streaming responses up to 30 seconds
export const maxDuration = 30

export const action = async (args: ActionFunctionArgs) => {
	// The page-editor tools are built synchronously, after hasWebsiteAccess has
	// run for the same organization, so the flag is read there.
	const reservationsOnlineByOrg = new Map<string, boolean>()
	return handleChat(args, {
		requireUserId,
		requireOrgMembership: (request, organizationId) =>
			requireUserWithOrganizationPermission(
				request,
				organizationId,
				ORG_PERMISSIONS.READ_NOTE_OWN,
			),
		createChatStream,
		buildNoteChatSystemPrompt,
		buildPageEditorSystemPrompt,
		brandSystemPrompt: brand.ai.systemPrompt,
		getPageEditorTools: ({ organizationId }) =>
			getPageEditorTools(organizationId, {
				reservationsOnline:
					reservationsOnlineByOrg.get(organizationId) ?? false,
			}),
		getNavigationTools,
		getNavigableRoutes: () => {
			const launchStatus = getLaunchStatus()
			return getNavigableAppRoutes({
				includeBilling:
					launchStatus !== 'PUBLIC_BETA' && launchStatus !== 'CLOSED_BETA',
			})
		},
		buildNavigationSystemPrompt,
		getPageContext: loadPageContext,
		getWebsitePages: loadWebsitePages,
		resolveOrganizationFromSlug: async (request, orgSlug) => {
			return requireUserOrganization(request, orgSlug, {
				id: true,
			})
		},
		hasWebsiteAccess: async (request, organizationId) => {
			try {
				await requireUserWithOrganizationPermission(
					request,
					organizationId,
					ORG_PERMISSIONS.READ_WEBSITE_ANY,
				)
				const reservations = await getReservationsFeatureState(organizationId)
				reservationsOnlineByOrg.set(
					organizationId,
					reservations.enabled && reservations.online,
				)
				return true
			} catch {
				return false
			}
		},
		markStepCompleted,
	})
}
