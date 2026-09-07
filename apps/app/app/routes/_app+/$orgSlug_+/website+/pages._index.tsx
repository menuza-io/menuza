import { parseWithZod } from '@conform-to/zod'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	isReservedSiteLocaleSlug,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	db,
	desc,
	eq,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { cn } from '@repo/ui'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { formatDistanceToNow } from 'date-fns'
import { useCallback, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { CreatePageDialog } from '#app/components/website/create-page-dialog.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import {
	PAGE_TEMPLATES,
	getDefaultConfig,
	type BlockType,
	type PageTemplate,
} from '#app/utils/website/block-types.ts'
import { HOME_PAGE_SLUG } from '#app/utils/website/home-page.ts'
import { ensureSiteChrome } from '#app/utils/website/locked-chrome.server.ts'

// --- Action Intents ---
const createPageIntent = 'create-page'
const publishPageIntent = 'publish-page'
const unpublishPageIntent = 'unpublish-page'
const deletePageIntent = 'delete-page'

// --- Schemas ---
const CreatePageSchema = z.object({
	intent: z.literal(createPageIntent),
	template: z.enum(['blank', 'article', 'showcase']),
	title: z.string().min(1, 'Title is required').max(200),
	slug: z
		.string()
		.min(1, 'URL slug is required')
		.max(200)
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			'URL must contain only lowercase letters, numbers, and hyphens',
		)
		.refine((val) => !isReservedSiteLocaleSlug(val), {
			message: 'URL slug cannot be a language code (e.g. en, ar, id)',
		}),
})

const PageActionSchema = z.object({
	intent: z.enum([publishPageIntent, unpublishPageIntent, deletePageIntent]),
	pageId: z.string().min(1),
})

// --- Loader ---
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const url = new URL(request.url)
	const search = url.searchParams.get('search')?.trim() || ''

	const pages = await db.query.WebsitePage.findMany({
		columns: {
			id: true,
			title: true,
			slug: true,
			status: true,
			template: true,
			isHomePage: true,
			createdAt: true,
			updatedAt: true,
		},
		with: {
			user: { columns: { name: true, username: true } },
		},
		where: (page, { and, eq, like }) =>
			and(
				eq(page.organizationId, organization.id),
				search ? like(page.title, `%${search}%`) : undefined,
			),
		orderBy: (page, { asc, desc }) => [
			asc(page.position),
			desc(page.createdAt),
		],
	})

	return {
		organization,
		defaultLocale,
		pages: pages.map((page) => ({
			...page,
			title:
				pickLocalized(page.title, defaultLocale, defaultLocale) || page.title,
			createdAt: page.createdAt.toISOString(),
			updatedAt: page.updatedAt.toISOString(),
			createdByName: page.user?.name || page.user?.username || '',
		})),
		search,
	}
}

// --- Action ---
export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === createPageIntent) {
		const submission = parseWithZod(formData, { schema: CreatePageSchema })

		if (submission.status !== 'success') {
			return Response.json({
				status: 'error' as const,
				result: submission.reply(),
			})
		}

		const { template, title, slug } = submission.value

		// Check for duplicate slug
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
					eq(WebsitePage.slug, slug),
				),
			)
			.limit(1)

		if (existing) {
			return Response.json({
				status: 'error' as const,
				result: submission.reply({
					fieldErrors: {
						slug: ['Page URL already exists in this organization'],
					},
				}),
			})
		}

		// Get the last position
		const [lastPage] = await db
			.select({ position: WebsitePage.position })
			.from(WebsitePage)
			.where(eq(WebsitePage.organizationId, organization.id))
			.orderBy(desc(WebsitePage.position))
			.limit(1)
		const nextPosition = (lastPage?.position ?? 0) + 1

		await ensureSiteChrome(organization.id)

		// Create page with template sections
		const templateDef = PAGE_TEMPLATES[template as PageTemplate]
		const [page] = await db.transaction(async (tx) => {
			const [createdPage] = await tx
				.insert(WebsitePage)
				.values({
					organizationId: organization.id,
					title,
					slug,
					template,
					position: nextPosition,
					createdById: userId,
				})
				.returning({ id: WebsitePage.id })
			if (createdPage && templateDef?.sections.length) {
				await tx.insert(WebsitePageSection).values(
					templateDef.sections.map((section) => ({
						pageId: createdPage.id,
						type: section.type,
						position: section.position,
						config: JSON.stringify(getDefaultConfig(section.type as BlockType)),
					})),
				)
			}
			return [createdPage]
		})
		if (!page) throw new Error('Failed to create page')

		return Response.json({
			status: 'success' as const,
			pageId: page.id,
		})
	}

	if (
		intent === publishPageIntent ||
		intent === unpublishPageIntent ||
		intent === deletePageIntent
	) {
		const submission = parseWithZod(formData, { schema: PageActionSchema })

		if (submission.status !== 'success') {
			return Response.json({
				status: 'error' as const,
				result: submission.reply(),
			})
		}

		const { pageId } = submission.value

		const [page] = await db
			.select({
				id: WebsitePage.id,
				isHomePage: WebsitePage.isHomePage,
				slug: WebsitePage.slug,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.id, pageId),
					eq(WebsitePage.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!page) {
			return Response.json(
				{ status: 'error' as const, error: 'Page not found' },
				{ status: 404 },
			)
		}

		if (intent === publishPageIntent) {
			await db
				.update(WebsitePage)
				.set({ status: 'published' })
				.where(eq(WebsitePage.id, pageId))
			return Response.json({ status: 'success' as const })
		}

		if (intent === unpublishPageIntent) {
			if (page.isHomePage || page.slug === HOME_PAGE_SLUG) {
				return Response.json({
					status: 'error' as const,
					error: 'Cannot unpublish the home page',
				})
			}
			await db
				.update(WebsitePage)
				.set({ status: 'draft' })
				.where(eq(WebsitePage.id, pageId))
			return Response.json({ status: 'success' as const })
		}

		if (intent === deletePageIntent) {
			if (page.isHomePage || page.slug === HOME_PAGE_SLUG) {
				return Response.json({
					status: 'error' as const,
					error: 'Cannot delete the home page',
				})
			}
			await db.delete(WebsitePage).where(eq(WebsitePage.id, pageId))
			return Response.json({ status: 'success' as const })
		}
	}

	return Response.json(
		{ status: 'error' as const, error: `Invalid intent: ${intent}` },
		{ status: 400 },
	)
}

// --- Page Row Component ---
function PageRow({
	page,
}: {
	page: {
		id: string
		title: string
		slug: string
		status: string
		isHomePage: boolean
		createdByName: string
		updatedAt: string
	}
}) {
	const { _ } = useLingui()
	const publishFetcher = useFetcher()
	const deleteFetcher = useFetcher()
	const busy = publishFetcher.state !== 'idle' || deleteFetcher.state !== 'idle'
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

	const optimisticStatus =
		publishFetcher.formData?.get('intent') === publishPageIntent
			? 'published'
			: publishFetcher.formData?.get('intent') === unpublishPageIntent
				? 'draft'
				: page.status

	const pageTitle = page.title

	return (
		<TableRow className={cn(busy && 'opacity-60')}>
			<TableCell>
				<Link
					to={`${page.id}`}
					className="hover:text-primary text-sm font-medium"
				>
					{page.title}
					{page.isHomePage && (
						<Badge variant="outline" className="ml-2 text-xs">
							<Trans>Home</Trans>
						</Badge>
					)}
				</Link>
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
				{page.createdByName}
			</TableCell>
			<TableCell>
				<Badge variant="outline">
					<span
						aria-hidden="true"
						className={cn(
							'size-1.5 rounded-full',
							optimisticStatus === 'published'
								? 'bg-emerald-500'
								: 'bg-muted-foreground/64',
						)}
					/>
					{optimisticStatus === 'published' ? (
						<Trans>Published</Trans>
					) : (
						<Trans>Draft</Trans>
					)}
				</Badge>
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
				{formatDistanceToNow(new Date(page.updatedAt), { addSuffix: true })}
			</TableCell>
			<TableCell className="text-right">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={_(t`Page actions`)}
							>
								<Icon name="ellipsis" className="size-4" />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							render={
								<Link to={`${page.id}`}>
									<Icon name="pencil" className="mr-2 size-4" />
									<Trans>Edit</Trans>
								</Link>
							}
						/>

						{optimisticStatus === 'draft' ? (
							<DropdownMenuItem
								onClick={() => {
									void publishFetcher.submit(
										{
											intent: publishPageIntent,
											pageId: page.id,
										},
										{ method: 'POST' },
									)
								}}
							>
								<Icon name="check-circle" className="mr-2 size-4" />
								<Trans>Publish</Trans>
							</DropdownMenuItem>
						) : !page.isHomePage ? (
							<DropdownMenuItem
								onClick={() => {
									void publishFetcher.submit(
										{
											intent: unpublishPageIntent,
											pageId: page.id,
										},
										{ method: 'POST' },
									)
								}}
							>
								<Icon name="circle" className="mr-2 size-4" />
								<Trans>Unpublish</Trans>
							</DropdownMenuItem>
						) : null}

						{!page.isHomePage && (
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() => setDeleteDialogOpen(true)}
							>
								<Icon name="trash-2" className="mr-2 size-4" />
								<Trans>Delete</Trans>
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>

				{!page.isHomePage && (
					<AlertDialog
						open={deleteDialogOpen}
						onOpenChange={setDeleteDialogOpen}
					>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									<Trans>Delete page?</Trans>
								</AlertDialogTitle>
								<AlertDialogDescription>
									<Trans>
										This action cannot be undone. Are you sure you want to
										delete "{pageTitle}"?
									</Trans>
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>
									<Trans>Cancel</Trans>
								</AlertDialogCancel>
								<AlertDialogAction
									onClick={() => {
										void deleteFetcher.submit(
											{
												intent: deletePageIntent,
												pageId: page.id,
											},
											{ method: 'POST' },
										)
										setDeleteDialogOpen(false)
									}}
								>
									<Trans>Delete</Trans>
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				)}
			</TableCell>
		</TableRow>
	)
}

// --- Main Page Component ---
export default function WebsitePagesRoute() {
	const { pages, search } = useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()
	const { _ } = useLingui()
	const [createOpen, setCreateOpen] = useState(false)

	const handleSearch = useCallback(
		(value: string) => {
			const newParams = new URLSearchParams(searchParams)
			if (value) {
				newParams.set('search', value)
			} else {
				newParams.delete('search')
			}
			setSearchParams(newParams)
		},
		[searchParams, setSearchParams],
	)

	const pageCount = pages.length

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Pages</Trans>}
				description={
					<Trans>
						Create and manage pages for your organization's website.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<CreatePageDialog
						open={createOpen}
						onOpenChange={setCreateOpen}
						trigger={
							<Button size="sm" className="shrink-0">
								<Icon name="plus" className="size-4" />
								<Trans>New Page</Trans>
							</Button>
						}
					/>
				}
			/>

			{pages.length === 0 && !search ? (
				<EmptyState
					title={_(t`No pages yet`)}
					description={_(
						t`Create your first page to start building your website.`,
					)}
					icons={['file-text', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<div className="relative max-w-sm flex-1">
							<Icon
								name="search"
								className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
							/>
							<Input
								type="search"
								placeholder={_(t`Search pages...`)}
								defaultValue={search}
								onChange={(e) => handleSearch(e.target.value)}
								className="pl-9"
							/>
						</div>
					</div>

					{pages.length === 0 && search ? (
						<EmptyState
							title={_(t`No pages match that search`)}
							description={_(
								t`Try a different search term or clear the search.`,
							)}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Page</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Created By</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Updated</Trans>
										</TableHead>
										<TableHead className="w-16">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pages.map((page) => (
										<PageRow key={page.id} page={page} />
									))}
								</TableBody>
								<TableFooter>
									<TableRow>
										<TableCell colSpan={4}>
											{pageCount === 1 ? (
												<Trans>1 page</Trans>
											) : (
												<Trans>{pageCount} pages</Trans>
											)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
						</Frame>
					)}
				</div>
			)}
		</div>
	)
}
