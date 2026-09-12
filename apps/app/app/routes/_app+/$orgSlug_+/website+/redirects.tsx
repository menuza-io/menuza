import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	desc,
	eq,
	ne,
	WebsiteNotFoundLog,
	WebsitePage,
	WebsiteRedirect,
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
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Switch } from '@repo/ui/switch'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { formatDistanceToNow } from 'date-fns'
import { useCallback, useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	const [redirects, notFoundLogs, pages] = await Promise.all([
		db
			.select()
			.from(WebsiteRedirect)
			.where(eq(WebsiteRedirect.organizationId, organization.id))
			.orderBy(desc(WebsiteRedirect.createdAt)),
		db
			.select()
			.from(WebsiteNotFoundLog)
			.where(eq(WebsiteNotFoundLog.organizationId, organization.id))
			.orderBy(desc(WebsiteNotFoundLog.lastHitAt)),
		db
			.select({
				id: WebsitePage.id,
				title: WebsitePage.title,
				slug: WebsitePage.slug,
				isHomePage: WebsitePage.isHomePage,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, organization.id),
					eq(WebsitePage.status, 'published'),
				),
			),
	])

	return {
		organization,
		redirects: redirects.map((r) => ({
			id: r.id,
			fromPath: r.fromPath,
			toPath: r.toPath,
			statusCode: r.statusCode,
			isEnabled: r.isEnabled,
			hitCount: r.hitCount,
			lastTriggeredAt: r.lastTriggeredAt
				? new Date(r.lastTriggeredAt).toISOString()
				: null,
			createdAt: r.createdAt
				? new Date(r.createdAt).toISOString()
				: new Date().toISOString(),
		})),
		notFoundLogs: notFoundLogs.map((l) => ({
			id: l.id,
			path: l.path,
			hitCount: l.hitCount,
			firstHitAt: l.firstHitAt
				? new Date(l.firstHitAt).toISOString()
				: new Date().toISOString(),
			lastHitAt: l.lastHitAt
				? new Date(l.lastHitAt).toISOString()
				: new Date().toISOString(),
			lastReferrer: l.lastReferrer,
		})),
		pages,
	}
}

function normalizePath(p: string): string {
	let clean = p.trim()
	if (
		!clean.startsWith('/') &&
		!clean.startsWith('http://') &&
		!clean.startsWith('https://')
	) {
		clean = `/${clean}`
	}
	if (clean.length > 1 && clean.endsWith('/') && !clean.startsWith('http')) {
		clean = clean.slice(0, -1)
	}
	return clean
}

function isValidRedirectDestination(val: string): boolean {
	const trimmed = val.trim()
	if (!trimmed) return false
	// Reject scheme-relative URLs like //evil.com
	if (trimmed.startsWith('//')) return false
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		try {
			const parsed = new URL(trimmed)
			return parsed.protocol === 'http:' || parsed.protocol === 'https:'
		} catch {
			return false
		}
	}
	// Internal relative path must start with exactly one slash and not backslash
	return trimmed.startsWith('/') && !trimmed.startsWith('/\\')
}

/**
 * Checks if adding/updating a redirect would cause a loop (e.g. /a -> /b -> /a).
 * Traverses internal redirect chain up to 25 hops.
 */
async function detectRedirectCycle(
	organizationId: string,
	fromPath: string,
	toPath: string,
	ignoreRedirectId?: string,
): Promise<boolean> {
	if (fromPath === toPath) return true
	if (toPath.startsWith('http://') || toPath.startsWith('https://')) {
		return false
	}

	const existingRedirects = await db
		.select({
			id: WebsiteRedirect.id,
			fromPath: WebsiteRedirect.fromPath,
			toPath: WebsiteRedirect.toPath,
		})
		.from(WebsiteRedirect)
		.where(eq(WebsiteRedirect.organizationId, organizationId))

	const redirectMap = new Map<string, string>()
	for (const r of existingRedirects) {
		if (ignoreRedirectId && r.id === ignoreRedirectId) continue
		redirectMap.set(r.fromPath.toLowerCase(), r.toPath)
	}

	// Add the candidate redirect
	redirectMap.set(fromPath.toLowerCase(), toPath)

	let current: string | undefined = toPath.toLowerCase()
	const visited = new Set<string>([fromPath.toLowerCase()])
	let hops = 0

	while (current && redirectMap.has(current) && hops < 25) {
		hops++
		const next: string | undefined = redirectMap.get(current)
		if (!next || next.startsWith('http://') || next.startsWith('https://')) {
			break
		}
		const nextLower = next.toLowerCase()
		if (visited.has(nextLower)) {
			return true
		}
		visited.add(nextLower)
		current = nextLower
	}

	return false
}

const CreateRedirectSchema = z.object({
	fromPath: z.string().trim().min(1, 'Source path is required'),
	toPath: z
		.string()
		.trim()
		.min(1, 'Destination is required')
		.refine(
			isValidRedirectDestination,
			'Destination must be an internal path (e.g. /page) or a valid http:// or https:// URL.',
		),
	statusCode: z.coerce
		.number()
		.refine((val) => val === 301 || val === 302, 'Must be 301 or 302'),
	isEnabled: z.string().nullish(),
})

const UpdateRedirectSchema = z.object({
	id: z.string().min(1),
	fromPath: z.string().trim().min(1, 'Source path is required'),
	toPath: z
		.string()
		.trim()
		.min(1, 'Destination is required')
		.refine(
			isValidRedirectDestination,
			'Destination must be an internal path (e.g. /page) or a valid http:// or https:// URL.',
		),
	statusCode: z.coerce
		.number()
		.refine((val) => val === 301 || val === 302, 'Must be 301 or 302'),
	isEnabled: z.string().nullish(),
})

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)

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

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'create-redirect') {
		const parsed = CreateRedirectSchema.safeParse({
			fromPath: formData.get('fromPath'),
			toPath: formData.get('toPath'),
			statusCode: formData.get('statusCode'),
			isEnabled: formData.get('isEnabled'),
		})

		if (!parsed.success) {
			return Response.json(
				{ status: 'error', errors: parsed.error.flatten().fieldErrors },
				{ status: 400 },
			)
		}

		const fromPath = normalizePath(parsed.data.fromPath)
		const toPath = normalizePath(parsed.data.toPath)

		if (fromPath === toPath) {
			return Response.json(
				{
					status: 'error',
					errors: {
						toPath: ['Destination cannot be the same as the source path.'],
					},
				},
				{ status: 400 },
			)
		}

		// Check duplicate
		const [existing] = await db
			.select({ id: WebsiteRedirect.id })
			.from(WebsiteRedirect)
			.where(
				and(
					eq(WebsiteRedirect.organizationId, organization.id),
					eq(WebsiteRedirect.fromPath, fromPath),
				),
			)
			.limit(1)

		if (existing) {
			return Response.json(
				{
					status: 'error',
					errors: {
						fromPath: ['A redirect for this source path already exists.'],
					},
				},
				{ status: 400 },
			)
		}

		const hasCycle = await detectRedirectCycle(
			organization.id,
			fromPath,
			toPath,
		)
		if (hasCycle) {
			return Response.json(
				{
					status: 'error',
					errors: {
						toPath: [
							'This redirect creates a circular loop with existing rules.',
						],
					},
				},
				{ status: 400 },
			)
		}

		await db.insert(WebsiteRedirect).values({
			organizationId: organization.id,
			fromPath,
			toPath,
			statusCode: parsed.data.statusCode,
			isEnabled: parsed.data.isEnabled !== 'false',
			hitCount: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		})

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: 'Redirect created',
			description: `Requests to ${fromPath} will now redirect to ${toPath}.`,
			type: 'success',
		})
	}

	if (intent === 'update-redirect') {
		const parsed = UpdateRedirectSchema.safeParse({
			id: formData.get('id'),
			fromPath: formData.get('fromPath'),
			toPath: formData.get('toPath'),
			statusCode: formData.get('statusCode'),
			isEnabled: formData.get('isEnabled'),
		})

		if (!parsed.success) {
			return Response.json(
				{ status: 'error', errors: parsed.error.flatten().fieldErrors },
				{ status: 400 },
			)
		}

		const fromPath = normalizePath(parsed.data.fromPath)
		const toPath = normalizePath(parsed.data.toPath)

		if (fromPath === toPath) {
			return Response.json(
				{
					status: 'error',
					errors: {
						toPath: ['Destination cannot be the same as the source path.'],
					},
				},
				{ status: 400 },
			)
		}

		// Check duplicate with another row
		const [existing] = await db
			.select({ id: WebsiteRedirect.id })
			.from(WebsiteRedirect)
			.where(
				and(
					eq(WebsiteRedirect.organizationId, organization.id),
					eq(WebsiteRedirect.fromPath, fromPath),
					ne(WebsiteRedirect.id, parsed.data.id),
				),
			)
			.limit(1)

		if (existing) {
			return Response.json(
				{
					status: 'error',
					errors: {
						fromPath: ['Another redirect for this source path already exists.'],
					},
				},
				{ status: 400 },
			)
		}

		const hasCycle = await detectRedirectCycle(
			organization.id,
			fromPath,
			toPath,
			parsed.data.id,
		)
		if (hasCycle) {
			return Response.json(
				{
					status: 'error',
					errors: {
						toPath: [
							'This redirect creates a circular loop with existing rules.',
						],
					},
				},
				{ status: 400 },
			)
		}

		await db
			.update(WebsiteRedirect)
			.set({
				fromPath,
				toPath,
				statusCode: parsed.data.statusCode,
				isEnabled: parsed.data.isEnabled === 'true',
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(WebsiteRedirect.id, parsed.data.id),
					eq(WebsiteRedirect.organizationId, organization.id),
				),
			)

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: 'Redirect updated',
			description: 'Your redirect changes have been saved.',
			type: 'success',
		})
	}

	if (intent === 'toggle-redirect') {
		const id = formData.get('id')
		const isEnabled = formData.get('isEnabled') === 'true'

		if (typeof id !== 'string') {
			return Response.json({ status: 'error' }, { status: 400 })
		}

		await db
			.update(WebsiteRedirect)
			.set({
				isEnabled,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(WebsiteRedirect.id, id),
					eq(WebsiteRedirect.organizationId, organization.id),
				),
			)

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: isEnabled ? 'Redirect enabled' : 'Redirect disabled',
			description: isEnabled
				? 'The redirect is now active.'
				: 'The redirect is currently inactive.',
			type: 'success',
		})
	}

	if (intent === 'delete-redirect') {
		const id = formData.get('id')
		if (typeof id !== 'string') {
			return Response.json({ status: 'error' }, { status: 400 })
		}

		await db
			.delete(WebsiteRedirect)
			.where(
				and(
					eq(WebsiteRedirect.id, id),
					eq(WebsiteRedirect.organizationId, organization.id),
				),
			)

		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: 'Redirect deleted',
			description: 'The redirect rule has been removed.',
			type: 'success',
		})
	}

	if (intent === 'delete-not-found') {
		const id = formData.get('id')
		if (typeof id !== 'string') {
			return Response.json({ status: 'error' }, { status: 400 })
		}

		await db
			.delete(WebsiteNotFoundLog)
			.where(
				and(
					eq(WebsiteNotFoundLog.id, id),
					eq(WebsiteNotFoundLog.organizationId, organization.id),
				),
			)

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: 'Log entry deleted',
			description: 'The 404 log entry has been removed.',
			type: 'success',
		})
	}

	if (intent === 'clear-all-not-founds') {
		await db
			.delete(WebsiteNotFoundLog)
			.where(eq(WebsiteNotFoundLog.organizationId, organization.id))

		return redirectWithToast(`/${organization.slug}/website/redirects`, {
			title: '404 history cleared',
			description: 'All recorded 404 error logs have been deleted.',
			type: 'success',
		})
	}

	return Response.json(
		{ status: 'error', message: 'Invalid intent' },
		{ status: 400 },
	)
}

type RedirectRecord = {
	id: string
	fromPath: string
	toPath: string
	statusCode: number
	isEnabled: boolean
	hitCount: number
	lastTriggeredAt: string | null
	createdAt: string
}

type NotFoundRecord = {
	id: string
	path: string
	hitCount: number
	firstHitAt: string
	lastHitAt: string
	lastReferrer: string | null
}

export default function WebsiteRedirectsRoute() {
	const { redirects, notFoundLogs, pages } = useLoaderData<typeof loader>()
	const actionData = useActionData<{
		status?: string
		errors?: Record<string, string[]>
	}>()
	const toggleFetcher = useFetcher()
	const deleteFetcher = useFetcher()
	const { _ } = useLingui()

	// Sheet Drawer State
	const [drawerOpen, setDrawerOpen] = useState(false)
	const [editingRedirect, setEditingRedirect] = useState<RedirectRecord | null>(
		null,
	)
	const [fromPathInput, setFromPathInput] = useState('')
	const [toPathInput, setToPathInput] = useState('')
	const [statusCodeInput, setStatusCodeInput] = useState<number>(301)
	const [isEnabledInput, setIsEnabledInput] = useState(true)
	const [destinationType, setDestinationType] = useState<'page' | 'custom'>(
		'custom',
	)
	const [selectedPageSlug, setSelectedPageSlug] = useState<string>('')

	// Search & Tab State
	const [searchQuery, setSearchQuery] = useState('')
	const [activeTab, setActiveTab] = useState<'redirects' | '404s'>('redirects')

	// Delete Confirmation Alert Dialog States
	const [redirectToDelete, setRedirectToDelete] =
		useState<RedirectRecord | null>(null)
	const [logToDelete, setLogToDelete] = useState<NotFoundRecord | null>(null)
	const [clearAll404Open, setClearAll404Open] = useState(false)

	const openCreateDrawer = useCallback((initialFromPath = '') => {
		setEditingRedirect(null)
		setFromPathInput(initialFromPath)
		setToPathInput('')
		setStatusCodeInput(301)
		setIsEnabledInput(true)
		setDestinationType('custom')
		setSelectedPageSlug('')
		setDrawerOpen(true)
	}, [])

	const openEditDrawer = useCallback(
		(record: RedirectRecord) => {
			setEditingRedirect(record)
			setFromPathInput(record.fromPath)
			setStatusCodeInput(record.statusCode)
			setIsEnabledInput(record.isEnabled)

			// Check if toPath matches one of the existing pages
			const matchedPage = pages.find((p) => {
				const expected = p.isHomePage ? '/' : `/${p.slug}`
				return expected === record.toPath
			})

			if (matchedPage) {
				setDestinationType('page')
				setSelectedPageSlug(
					matchedPage.isHomePage ? '__home__' : matchedPage.slug,
				)
				setToPathInput(record.toPath)
			} else {
				setDestinationType('custom')
				setSelectedPageSlug('')
				setToPathInput(record.toPath)
			}
			setDrawerOpen(true)
		},
		[pages],
	)

	const handlePageSelectChange = (val: string) => {
		setSelectedPageSlug(val)
		if (val === '__home__') {
			setToPathInput('/')
		} else {
			setToPathInput(`/${val}`)
		}
	}

	// Page items for destination select mapping value -> label
	const pageSelectItems = useMemo(() => {
		return pages.map((page) => ({
			value: page.isHomePage ? '__home__' : page.slug,
			label: page.title,
		}))
	}, [pages])

	// Filtered redirects
	const filteredRedirects = useMemo(() => {
		if (!searchQuery.trim()) return redirects
		const q = searchQuery.toLowerCase()
		return redirects.filter(
			(r) =>
				r.fromPath.toLowerCase().includes(q) ||
				r.toPath.toLowerCase().includes(q),
		)
	}, [redirects, searchQuery])

	// Filtered 404s
	const filtered404s = useMemo(() => {
		if (!searchQuery.trim()) return notFoundLogs
		const q = searchQuery.toLowerCase()
		return notFoundLogs.filter(
			(l) =>
				l.path.toLowerCase().includes(q) ||
				(l.lastReferrer && l.lastReferrer.toLowerCase().includes(q)),
		)
	}, [notFoundLogs, searchQuery])

	// Map of paths that have active redirects
	const activeRedirectFromPaths = useMemo(() => {
		return new Set(
			redirects.filter((r) => r.isEnabled).map((r) => r.fromPath.toLowerCase()),
		)
	}, [redirects])

	const redirectCount = filteredRedirects.length
	const notFoundCount = filtered404s.length
	const deleteRedirectFrom = redirectToDelete?.fromPath
	const deleteRedirectTo = redirectToDelete?.toPath
	const deleteLogPath = logToDelete?.path

	return (
		<div className="space-y-8">
			{/* Page Header */}
			<PageHeader
				title={<Trans>Redirects & 404 History</Trans>}
				description={
					<Trans>
						Forward old or broken URLs to your new pages to preserve SEO rank
						and customer traffic.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button
						type="button"
						onClick={() => openCreateDrawer()}
						className="gap-1.5"
					>
						<Icon name="plus" className="size-4" />
						<Trans>New Redirect</Trans>
					</Button>
				}
			/>

			<Tabs
				value={activeTab}
				onValueChange={(val) => setActiveTab(val as 'redirects' | '404s')}
				className="space-y-4"
			>
				{/* Tabs & Search Toolbar */}
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<TabsList>
						<TabsTrigger value="redirects" className="gap-2">
							<Trans>URL Redirects</Trans>
							<Badge variant="secondary" className="px-1.5 py-0 text-xs">
								{redirects.length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger value="404s" className="gap-2">
							<Trans>404 Error History</Trans>
							<Badge
								variant={notFoundLogs.length > 0 ? 'default' : 'secondary'}
								className="px-1.5 py-0 text-xs"
							>
								{notFoundLogs.length}
							</Badge>
						</TabsTrigger>
					</TabsList>

					<div className="flex items-center gap-2">
						<div className="relative w-full sm:w-64">
							<Icon
								name="search"
								className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
							/>
							<Input
								type="search"
								placeholder={
									activeTab === 'redirects'
										? _(t`Search redirects...`)
										: _(t`Search missing URLs...`)
								}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-9 text-sm"
							/>
						</div>

						{activeTab === '404s' && notFoundLogs.length > 0 && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setClearAll404Open(true)}
								className="text-muted-foreground hover:text-destructive shrink-0 gap-1.5 text-xs"
							>
								<Icon name="trash-2" className="size-3.5" />
								<Trans>Clear history</Trans>
							</Button>
						)}
					</div>
				</div>

				{/* URL Redirects Tab */}
				<TabsContent value="redirects" className="space-y-4">
					{redirects.length === 0 ? (
						<EmptyState
							title={_(t`No redirects created yet`)}
							description={_(
								t`If you moved from an older website or changed page URLs, create redirects so visitors and search engines are automatically forwarded.`,
							)}
							icons={['route', 'arrow-right', 'external-link']}
						/>
					) : filteredRedirects.length === 0 ? (
						<EmptyState
							title={_(t`No redirects match that search`)}
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
										<TableHead className="w-18">
											<Trans>Live</Trans>
										</TableHead>
										<TableHead>
											<Trans>Old URL (Source)</Trans>
										</TableHead>
										<TableHead>
											<Trans>New Destination</Trans>
										</TableHead>
										<TableHead>
											<Trans>Type</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Usage</Trans>
										</TableHead>
										<TableHead className="w-16">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredRedirects.map((redirect) => {
										const busy =
											toggleFetcher.state !== 'idle' &&
											toggleFetcher.formData?.get('id') === redirect.id

										return (
											<TableRow
												key={redirect.id}
												className={cn(busy && 'opacity-60')}
											>
												<TableCell>
													<Switch
														checked={redirect.isEnabled}
														disabled={busy}
														aria-label={_(t`Toggle redirect active status`)}
														onCheckedChange={(checked) => {
															void toggleFetcher.submit(
																{
																	intent: 'toggle-redirect',
																	id: redirect.id,
																	isEnabled: checked ? 'true' : 'false',
																},
																{ method: 'post' },
															)
														}}
													/>
												</TableCell>
												<TableCell>
													<button
														type="button"
														onClick={() => openEditDrawer(redirect)}
														className="hover:text-primary text-left font-mono text-sm font-medium transition-colors"
													>
														{redirect.fromPath}
													</button>
												</TableCell>
												<TableCell className="font-mono text-sm">
													<div className="text-muted-foreground flex items-center gap-1.5">
														<Icon
															name="arrow-right"
															className="size-3.5 shrink-0"
														/>
														<span className="truncate">{redirect.toPath}</span>
													</div>
												</TableCell>
												<TableCell>
													<Badge variant="outline" className="gap-1.5">
														<span
															aria-hidden="true"
															className={cn(
																'size-1.5 rounded-full',
																redirect.statusCode === 301
																	? 'bg-blue-500'
																	: 'bg-amber-500',
															)}
														/>
														{redirect.statusCode === 301 ? (
															<span>301 (Permanent)</span>
														) : (
															<span>302 (Temporary)</span>
														)}
													</Badge>
												</TableCell>
												<TableCell className="hidden text-xs md:table-cell">
													<div className="text-foreground font-medium">
														{redirect.hitCount.toLocaleString()}{' '}
														<span className="text-muted-foreground font-normal">
															{redirect.hitCount === 1 ? _(t`hit`) : _(t`hits`)}
														</span>
													</div>
													<div className="text-muted-foreground">
														{redirect.lastTriggeredAt ? (
															formatDistanceToNow(
																new Date(redirect.lastTriggeredAt),
																{ addSuffix: true },
															)
														) : (
															<span className="opacity-60">
																{_(t`Never used`)}
															</span>
														)}
													</div>
												</TableCell>
												<TableCell className="text-right">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	size="icon-sm"
																	aria-label={_(t`Redirect actions`)}
																>
																	<Icon name="ellipsis" className="size-4" />
																</Button>
															}
														/>
														<DropdownMenuContent align="end">
															<DropdownMenuItem
																onClick={() => openEditDrawer(redirect)}
															>
																<Icon name="pencil" className="mr-2 size-4" />
																<Trans>Edit</Trans>
															</DropdownMenuItem>
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={() => setRedirectToDelete(redirect)}
															>
																<Icon name="trash-2" className="mr-2 size-4" />
																<Trans>Delete</Trans>
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
								<TableFooter>
									<TableRow>
										<TableCell colSpan={5}>
											{redirectCount === 1 ? (
												<Trans>1 redirect</Trans>
											) : (
												<Trans>{redirectCount} redirects</Trans>
											)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
						</Frame>
					)}
				</TabsContent>

				{/* 404 Error History Tab */}
				<TabsContent value="404s" className="space-y-4">
					{notFoundLogs.length === 0 ? (
						<EmptyState
							title={_(t`No 404 errors recorded`)}
							description={_(
								t`When visitors or search engines request a URL that doesn't exist, it will appear here so you can set up redirects.`,
							)}
							icons={['check-circle']}
						/>
					) : filtered404s.length === 0 ? (
						<EmptyState
							title={_(t`No 404 errors match that search`)}
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
											<Trans>Missing Path</Trans>
										</TableHead>
										<TableHead>
											<Trans>Hits</Trans>
										</TableHead>
										<TableHead>
											<Trans>Last Encountered</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Referrer</Trans>
										</TableHead>
										<TableHead className="w-40 text-right">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filtered404s.map((log) => {
										const hasRedirect = activeRedirectFromPaths.has(
											log.path.toLowerCase(),
										)
										return (
											<TableRow key={log.id}>
												<TableCell className="font-mono text-sm font-medium">
													{log.path}
												</TableCell>
												<TableCell>
													<Badge variant="secondary" className="text-xs">
														{log.hitCount}{' '}
														{log.hitCount === 1 ? _(t`hit`) : _(t`hits`)}
													</Badge>
												</TableCell>
												<TableCell className="text-muted-foreground text-xs">
													{formatDistanceToNow(new Date(log.lastHitAt), {
														addSuffix: true,
													})}
												</TableCell>
												<TableCell className="text-muted-foreground hidden max-w-[220px] truncate text-xs sm:table-cell">
													{log.lastReferrer || _(t`Direct / Unknown`)}
												</TableCell>
												<TableCell className="text-right">
													<div className="flex items-center justify-end gap-2">
														{hasRedirect ? (
															<Badge
																variant="outline"
																className="border-emerald-500/30 bg-emerald-50/50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-950/40 dark:text-emerald-300"
															>
																<Icon
																	name="check"
																	className="mr-1 size-3 text-emerald-600"
																/>
																<Trans>Redirected</Trans>
															</Badge>
														) : (
															<Button
																size="sm"
																variant="secondary"
																className="h-8 gap-1 text-xs"
																onClick={() => openCreateDrawer(log.path)}
															>
																<Icon name="route" className="size-3.5" />
																<Trans>Create redirect</Trans>
															</Button>
														)}

														<Button
															variant="ghost"
															size="icon-sm"
															className="text-muted-foreground hover:text-destructive"
															onClick={() => setLogToDelete(log)}
															aria-label={_(t`Delete log entry`)}
														>
															<Icon name="trash-2" className="size-3.5" />
														</Button>
													</div>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
								<TableFooter>
									<TableRow>
										<TableCell colSpan={4}>
											{notFoundCount === 1 ? (
												<Trans>1 missing URL logged</Trans>
											) : (
												<Trans>{notFoundCount} missing URLs logged</Trans>
											)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
						</Frame>
					)}
				</TabsContent>
			</Tabs>

			{/* Slide-out Drawer (Sheet) for Add / Edit Redirect */}
			<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
				<SheetContent
					side="right"
					className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
				>
					<SheetHeader className="border-b px-6 py-4.5">
						<SheetTitle className="text-base font-semibold">
							{editingRedirect ? _(t`Edit redirect`) : _(t`New redirect`)}
						</SheetTitle>
						<SheetDescription className="text-muted-foreground text-xs">
							<Trans>
								Route incoming traffic from an old path to a new destination.
							</Trans>
						</SheetDescription>
					</SheetHeader>

					<form
						method="post"
						className="flex flex-1 flex-col justify-between overflow-y-auto"
					>
						<input
							type="hidden"
							name="intent"
							value={editingRedirect ? 'update-redirect' : 'create-redirect'}
						/>
						{editingRedirect && (
							<input type="hidden" name="id" value={editingRedirect.id} />
						)}

						<div className="space-y-5 px-6 py-5">
							{/* Source Path */}
							<div className="space-y-1.5">
								<Label
									htmlFor="fromPath"
									className="text-foreground text-xs font-medium"
								>
									<Trans>Old path (Source)</Trans>
								</Label>
								<Input
									id="fromPath"
									name="fromPath"
									placeholder="/old-page"
									value={fromPathInput}
									onChange={(e) => setFromPathInput(e.target.value)}
									required
									className="font-mono text-sm"
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										The path on your old site that visitors or search engines
										request.
									</Trans>
								</p>
								{actionData?.errors?.fromPath && (
									<p className="text-destructive text-xs font-medium">
										{actionData.errors.fromPath[0]}
									</p>
								)}
							</div>

							{/* Destination */}
							<div className="space-y-1.5">
								<div className="flex items-center justify-between">
									<Label
										htmlFor="toPath"
										className="text-foreground text-xs font-medium"
									>
										<Trans>Destination</Trans>
									</Label>
									<div className="bg-muted inline-flex rounded-md p-0.5 text-xs">
										<button
											type="button"
											onClick={() => {
												setDestinationType('page')
												if (pages.length > 0 && !selectedPageSlug) {
													const home = pages.find((p) => p.isHomePage)
													handlePageSelectChange(
														home ? '__home__' : pages[0]!.slug,
													)
												}
											}}
											className={cn(
												'rounded px-2.5 py-0.5 font-medium transition-all',
												destinationType === 'page'
													? 'bg-background text-foreground shadow-xs'
													: 'text-muted-foreground hover:text-foreground',
											)}
										>
											<Trans>Existing page</Trans>
										</button>
										<button
											type="button"
											onClick={() => setDestinationType('custom')}
											className={cn(
												'rounded px-2.5 py-0.5 font-medium transition-all',
												destinationType === 'custom'
													? 'bg-background text-foreground shadow-xs'
													: 'text-muted-foreground hover:text-foreground',
											)}
										>
											<Trans>Custom URL</Trans>
										</button>
									</div>
								</div>

								{destinationType === 'page' ? (
									<div className="space-y-1.5">
										<Select
											items={pageSelectItems}
											value={selectedPageSlug}
											onValueChange={(val) => {
												if (val) handlePageSelectChange(val)
											}}
										>
											<SelectTrigger
												id="toPathSelect"
												className="w-full text-sm"
											>
												<SelectValue placeholder={_(t`Select a website page`)}>
													{(val: string | null) => {
														if (!val) return null
														const p = pages.find(
															(page) =>
																(page.isHomePage ? '__home__' : page.slug) ===
																val,
														)
														return p ? p.title : val
													}}
												</SelectValue>
											</SelectTrigger>
											<SelectContent
												align="start"
												className="w-(--anchor-width)"
											>
												{pages.map((page) => (
													<SelectItem
														key={page.id}
														value={page.isHomePage ? '__home__' : page.slug}
														className="py-2"
													>
														<div className="flex flex-col gap-0.5 text-left">
															<span className="text-foreground text-sm leading-tight font-medium">
																{page.title}
															</span>
															<span className="text-muted-foreground font-mono text-xs leading-tight">
																{page.isHomePage ? '/' : `/${page.slug}`}
															</span>
														</div>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<input type="hidden" name="toPath" value={toPathInput} />
										<p className="text-muted-foreground text-xs">
											<Trans>Will redirect to</Trans>{' '}
											<span className="text-foreground font-mono font-medium">
												{toPathInput || '/'}
											</span>
										</p>
									</div>
								) : (
									<div className="space-y-1.5">
										<Input
											id="toPath"
											name="toPath"
											placeholder="/new-page or https://..."
											value={toPathInput}
											onChange={(e) => setToPathInput(e.target.value)}
											required
											className="font-mono text-sm"
										/>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Enter an internal path (e.g. /new-page) or full external
												URL.
											</Trans>
										</p>
									</div>
								)}
								{actionData?.errors?.toPath && (
									<p className="text-destructive text-xs font-medium">
										{actionData.errors.toPath[0]}
									</p>
								)}
							</div>

							{/* Redirect Type (301 vs 302) */}
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label className="text-foreground text-xs font-medium">
										<Trans>Redirect type</Trans>
									</Label>
									<span className="text-xs">
										{statusCodeInput === 301 ? (
											<span className="font-medium text-emerald-600 dark:text-emerald-400">
												<Trans>Recommended for SEO</Trans>
											</span>
										) : (
											<span className="text-muted-foreground">
												<Trans>Temporary forward</Trans>
											</span>
										)}
									</span>
								</div>

								<div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
									<button
										type="button"
										onClick={() => setStatusCodeInput(301)}
										className={cn(
											'flex flex-col items-center justify-center rounded-md px-3 py-2 text-center transition-all',
											statusCodeInput === 301
												? 'bg-background text-foreground font-medium shadow-xs'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										<span className="text-xs font-semibold">
											301 · Permanent
										</span>
										<span className="text-muted-foreground mt-0.5 text-[11px] font-normal">
											<Trans>Transfers search rank</Trans>
										</span>
									</button>
									<button
										type="button"
										onClick={() => setStatusCodeInput(302)}
										className={cn(
											'flex flex-col items-center justify-center rounded-md px-3 py-2 text-center transition-all',
											statusCodeInput === 302
												? 'bg-background text-foreground font-medium shadow-xs'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										<span className="text-xs font-semibold">
											302 · Temporary
										</span>
										<span className="text-muted-foreground mt-0.5 text-[11px] font-normal">
											<Trans>Keeps original indexing</Trans>
										</span>
									</button>
								</div>
								<input
									type="hidden"
									name="statusCode"
									value={statusCodeInput}
								/>

								<p className="text-muted-foreground text-xs leading-relaxed">
									{statusCodeInput === 301 ? (
										<Trans>
											Permanent (301) tells search engines (like Google) that
											the page has moved permanently, passing ranking and
											backlinks.
										</Trans>
									) : (
										<Trans>
											Temporary (302) keeps original search indexing. Best for
											short-term promotions, maintenance, or seasonal campaigns.
										</Trans>
									)}
								</p>
							</div>

							{/* Active Toggle */}
							<div className="border-t pt-4">
								<div className="flex items-center justify-between">
									<div className="space-y-0.5 pr-4">
										<Label
											htmlFor="isEnabledSwitch"
											className="text-foreground cursor-pointer text-xs font-medium"
										>
											<Trans>Enable redirect immediately</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												When active, visitors requesting the old URL will be
												forwarded right away.
											</Trans>
										</p>
									</div>
									<Switch
										id="isEnabledSwitch"
										checked={isEnabledInput}
										onCheckedChange={setIsEnabledInput}
									/>
								</div>
								<input
									type="hidden"
									name="isEnabled"
									value={isEnabledInput ? 'true' : 'false'}
								/>
							</div>
						</div>

						<SheetFooter className="bg-muted/20 flex flex-row items-center justify-end gap-2 border-t px-6 py-4">
							<Button
								type="button"
								variant="outline"
								onClick={() => setDrawerOpen(false)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit">
								{editingRedirect ? _(t`Save changes`) : _(t`Create redirect`)}
							</Button>
						</SheetFooter>
					</form>
				</SheetContent>
			</Sheet>

			{/* Delete Single Redirect Alert Dialog */}
			<AlertDialog
				open={redirectToDelete != null}
				onOpenChange={(open) => {
					if (!open) setRedirectToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete redirect rule?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete the redirect from{' '}
								<span className="text-foreground font-mono font-medium">
									{deleteRedirectFrom}
								</span>{' '}
								to{' '}
								<span className="text-foreground font-mono font-medium">
									{deleteRedirectTo}
								</span>
								. Visitors requesting this old URL will no longer be forwarded.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (redirectToDelete) {
									void deleteFetcher.submit(
										{
											intent: 'delete-redirect',
											id: redirectToDelete.id,
										},
										{ method: 'post' },
									)
									setRedirectToDelete(null)
								}
							}}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Delete Single 404 Log Alert Dialog */}
			<AlertDialog
				open={logToDelete != null}
				onOpenChange={(open) => {
					if (!open) setLogToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete 404 log entry?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will delete the 404 record for{' '}
								<span className="text-foreground font-mono font-medium">
									{deleteLogPath}
								</span>{' '}
								from your history.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (logToDelete) {
									void deleteFetcher.submit(
										{
											intent: 'delete-not-found',
											id: logToDelete.id,
										},
										{ method: 'post' },
									)
									setLogToDelete(null)
								}
							}}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Clear All 404 History Alert Dialog */}
			<AlertDialog open={clearAll404Open} onOpenChange={setClearAll404Open}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Clear all 404 history?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This will permanently delete all recorded 404 errors for your
								organization website. This action cannot be undone.
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
									{ intent: 'clear-all-not-founds' },
									{ method: 'post' },
								)
								setClearAll404Open(false)
							}}
						>
							<Trans>Clear History</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
