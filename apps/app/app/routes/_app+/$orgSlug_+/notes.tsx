import { invariantResponse } from '@epic-web/invariant'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getNotesViewMode, setNotesViewMode, useDebounce } from '@repo/common'
import {
	db,
	eq,
	Organization,
	OrganizationImage,
	OrganizationNoteStatus,
} from '@repo/database'
import { useDirection } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'

import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import { useCallback, useEffect, useState } from 'react'
import {
	Link,
	Outlet,
	useFetcher,
	useLocation,
	useNavigate,
	useSearchParams,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { ENV } from 'varlock/env'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'
import { NotesCards } from './notes-cards.tsx'
import { NotesKanbanBoard } from './notes-kanban-board.tsx'

export async function loader({ params, request }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug
	invariantResponse(orgSlug, 'Organization slug is required')

	const [organizationRow] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			objectKey: OrganizationImage.objectKey,
		})
		.from(Organization)
		.leftJoin(
			OrganizationImage,
			eq(OrganizationImage.organizationId, Organization.id),
		)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)
	const organization = organizationRow
		? {
				id: organizationRow.id,
				name: organizationRow.name,
				slug: organizationRow.slug,
				image: organizationRow.objectKey
					? { objectKey: organizationRow.objectKey }
					: undefined,
			}
		: null

	invariantResponse(organization, 'Organization not found', { status: 404 })

	// Check if the user has access to this organization
	const userId = await requireUserId(request)
	await userHasOrgAccess(request, organization.id)

	// Get search query from URL
	const url = new URL(request.url)
	const searchQuery = url.searchParams.get('search')?.trim() || ''

	// Build search conditions
	// For SQLite, we'll use a simpler approach and rely on the database's default behavior
	// Execute independent data fetching operations concurrently
	const [notes, statuses, viewMode] = await Promise.all([
		db.query.OrganizationNote.findMany({
			columns: {
				id: true,
				title: true,
				content: true,
				priority: true,
				tags: true,
				createdAt: true,
				updatedAt: true,
				isPublic: true,
				createdById: true,
				statusId: true,
				position: true,
			},
			with: {
				status: { columns: { id: true, name: true, color: true } },
				organizationNoteUploads: {
					columns: {
						id: true,
						type: true,
						altText: true,
						objectKey: true,
					},
				},
				user: {
					columns: { name: true, username: true },
					with: { image: { columns: { objectKey: true } } },
				},
				noteAccess: { columns: { userId: true } },
			},
			where: (note, { and, eq, like, or, sql }) =>
				and(
					eq(note.organizationId, organization.id),
					or(
						eq(note.isPublic, true),
						eq(note.createdById, userId),
						sql`EXISTS (SELECT 1 FROM NoteAccess WHERE noteId = ${note.id} AND userId = ${userId})`,
					),
					searchQuery
						? or(
								like(note.title, `%${searchQuery}%`),
								like(note.content, `%${searchQuery}%`),
							)
						: undefined,
				),
			orderBy: (note, { asc, desc }) => [
				asc(note.statusId),
				asc(note.position),
				desc(note.createdAt),
			],
		}),
		db
			.select({
				id: OrganizationNoteStatus.id,
				name: OrganizationNoteStatus.name,
				color: OrganizationNoteStatus.color,
				position: OrganizationNoteStatus.position,
			})
			.from(OrganizationNoteStatus)
			.where(eq(OrganizationNoteStatus.organizationId, organization.id))
			.orderBy(OrganizationNoteStatus.position),
		getNotesViewMode(request),
	])

	const formattedNotes = notes
		.filter(
			(note) =>
				note.isPublic ||
				note.createdById === userId ||
				note.noteAccess.some((access) => access.userId === userId),
		)
		.map((note) => ({
			...note,
			createdBy: note.user,
			createdByName: note.user?.name || note.user?.username || 'Unknown',
			statusId: note.statusId ?? null,
			statusName: note.status?.name ?? null,
			position: note.position ?? null,
			uploads: note.organizationNoteUploads,
		}))

	return {
		organization,
		notes: formattedNotes,
		statuses,
		viewMode,
		searchQuery,
		mediaTransformBaseUrl: ENV.MEDIA_TRANSFORM_BASE_URL?.trim() || null,
	}
}

export async function action({ request }: ActionFunctionArgs) {
	const formData = await request.formData()
	const viewMode = formData.get('viewMode') as 'cards' | 'kanban'

	if (viewMode !== 'cards' && viewMode !== 'kanban') {
		throw new Response('Invalid view mode', { status: 400 })
	}

	return new Response(null, {
		headers: {
			'Set-Cookie': await setNotesViewMode(viewMode),
		},
	})
}

export default function NotesRoute({
	loaderData,
}: {
	loaderData: {
		organization: {
			id: string
			name: string
			slug: string
			image?: { objectKey: string }
		}
		notes: Array<{
			id: string
			title: string
			content: string
			createdAt: string
			updatedAt: string
			isPublic: boolean
			createdById: string
			statusId: string | null
			statusName: string | null
			position: number | null
			uploads: Array<{
				id: string
				type: string
				altText: string | null
				objectKey: string
			}>
			createdBy?: {
				name: string | null
				username: string | null
			} | null
			noteAccess: Array<{
				userId: string
			}>
			createdByName: string
		}>
		statuses: Array<{
			id: string
			name: string
			position: number | null
		}>
		viewMode: 'cards' | 'kanban'
		searchQuery: string
		mediaTransformBaseUrl: string | null
	}
}) {
	const { _ } = useLingui()
	const location = useLocation()
	const [hasOutlet, setHasOutlet] = useState(false)
	const navigate = useNavigate()
	const fetcher = useFetcher()
	const [searchParams, setSearchParams] = useSearchParams()
	const [searchValue, setSearchValue] = useState(loaderData.searchQuery)
	const direction = useDirection()

	const viewMode = loaderData.viewMode

	// Simple check: if we're not on the base notes route, show outlet
	useEffect(() => {
		const baseNotesPath = `/${loaderData.organization.slug}/notes`
		setHasOutlet(location.pathname !== baseNotesPath)
	}, [location.pathname, loaderData.organization.slug])

	const handleSearch = useCallback(
		(value: string) => {
			const newSearchParams = new URLSearchParams(searchParams)
			if (value.trim()) {
				newSearchParams.set('search', value.trim())
			} else {
				newSearchParams.delete('search')
			}
			setSearchParams(newSearchParams)
		},
		[searchParams, setSearchParams],
	)

	const handleDebouncedSearch = useDebounce(handleSearch, 300)

	const handleSearchSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault()
			handleSearch(searchValue)
		},
		[handleSearch, searchValue],
	)

	const handleSearchKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault()
				handleSearch(searchValue)
			}
		},
		[handleSearch, searchValue],
	)

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col py-8 md:px-6 lg:px-8">
			<PageHeader
				title={_(t`Notes`)}
				description={_(t`You can create notes for your organization here.`)}
				actions={
					<>
						<Tabs
							value={viewMode}
							onValueChange={(val) => {
								if (val === 'cards' || val === 'kanban') {
									void fetcher.submit({ viewMode: val }, { method: 'POST' })
								}
							}}
						>
							<TabsList>
								<TabsTrigger value="cards" aria-label={_(t`Cards view`)}>
									<Tooltip>
										<TooltipTrigger
											render={
												<span>
													<Icon name="blocks" />
												</span>
											}
										></TooltipTrigger>
										<TooltipContent>
											<Trans>Cards</Trans>
										</TooltipContent>
									</Tooltip>
								</TabsTrigger>
								<TabsTrigger value="kanban" aria-label={_(t`Kanban board`)}>
									<Tooltip>
										<TooltipTrigger
											render={
												<span>
													<Icon name="menu" />
												</span>
											}
										></TooltipTrigger>
										<TooltipContent>
											<Trans>Kanban</Trans>
										</TooltipContent>
									</Tooltip>
								</TabsTrigger>
							</TabsList>
						</Tabs>
						<Button variant="default" render={<Link to="new" />}>
							<Icon name="plus">
								<Trans>New Note</Trans>
							</Icon>
						</Button>
					</>
				}
			/>

			{/* Search Section */}
			<div className="pt-8 pb-4">
				<form onSubmit={handleSearchSubmit} className="relative max-w-md">
					<Input
						type="search"
						role="searchbox"
						name="search"
						aria-label={_(t`Search notes`)}
						placeholder={_(t`Search notes by title or content...`)}
						value={searchValue}
						onChange={(e) => {
							setSearchValue(e.target.value)
							handleDebouncedSearch(e.target.value)
						}}
						onKeyDown={handleSearchKeyDown}
						className="pr-10"
					/>
					<div className="absolute inset-y-0 right-0 flex items-center pr-3">
						<Icon name="search" className="text-muted-foreground h-4 w-4" />
					</div>
				</form>
			</div>

			<div className="grow pb-4">
				{loaderData.notes.length > 0 ? (
					viewMode === 'kanban' ? (
						<NotesKanbanBoard
							notes={loaderData.notes}
							orgSlug={loaderData.organization.slug}
							statuses={loaderData.statuses}
							organizationId={loaderData.organization.id}
						/>
					) : (
						<NotesCards
							notes={loaderData.notes}
							organizationId={loaderData.organization.id}
						/>
					)
				) : loaderData.searchQuery ? (
					<EmptyState
						title={_(t`No notes found`)}
						description={_(
							t`No notes match your search for "${searchValue}". Try a different search term or create a new note.`,
						)}
						icons={['search', 'file-text']}
						action={{
							label: _(t`Create Note`),
							href: `/${loaderData.organization.slug}/notes/new`,
						}}
					/>
				) : (
					<EmptyState
						title={_(t`You haven't created any notes yet!`)}
						description={_(
							t`Notes help you capture thoughts, meeting minutes, or anything important for your organization. Get started by creating your first note.`,
						)}
						icons={['file-text', 'link-2', 'image']}
						action={{
							label: _(t`Create Note`),
							href: `/${loaderData.organization.slug}/notes/new`,
						}}
					/>
				)}
			</div>

			{/* Sheet for nested routes */}
			<Sheet
				open={hasOutlet}
				onOpenChange={() => {
					if (hasOutlet) {
						// Navigate back to notes list
						void navigate(`/${loaderData.organization.slug}/notes`)
					}
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-[40vw] flex-col gap-0 data-[side=right]:w-full sm:max-w-xl data-[side=right]:sm:max-w-lg md:max-w-2xl lg:max-w-3xl xl:max-w-4xl"
				>
					<Outlet />
				</SheetContent>
			</Sheet>
		</div>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: ({ params }) => {
					const orgSlug = params.orgSlug
					return (
						<p>
							<Trans>No organization with the slug "{orgSlug}" exists</Trans>
						</p>
					)
				},
			}}
		/>
	)
}
