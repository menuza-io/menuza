import { parseWithZod } from '@conform-to/zod'
import { Trans, msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	desc,
	eq,
	OrganizationAnnouncement,
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
import { PageHeader } from '@repo/ui/page-header'
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
import { formatDistanceToNow } from 'date-fns'
import { useCallback, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
	useRevalidator,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	AnnouncementSchema,
	AnnouncementSheet,
	ANNOUNCEMENT_TYPES,
	createAnnouncementIntent,
	deleteAnnouncementIntent,
	getAnnouncementPreviewText,
	toggleAnnouncementIntent,
	updateAnnouncementIntent,
	type AnnouncementRecord,
	type AnnouncementType,
} from '#app/components/settings/cards/organization/announcement-sheet.tsx'
import {
	LocaleContext,
	LocaleSwitcher,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

function isAnnouncementType(value: string): value is AnnouncementType {
	return (ANNOUNCEMENT_TYPES as readonly string[]).includes(value)
}

function serializeAnnouncement(
	announcement: {
		id: string
		content: string
		type: string
		isEnabled: boolean
		linkUrl: string | null
		linkLabel: string | null
		linkNewTab: boolean
		position: number | null
		createdAt: Date
		updatedAt: Date
	},
	defaultLocale: string,
): AnnouncementRecord {
	return {
		id: announcement.id,
		content: parseLocalizedString(announcement.content, defaultLocale),
		type: isAnnouncementType(announcement.type) ? announcement.type : 'info',
		isEnabled: announcement.isEnabled,
		linkUrl: announcement.linkUrl,
		linkLabel: parseLocalizedString(announcement.linkLabel, defaultLocale),
		linkNewTab: announcement.linkNewTab,
		position: announcement.position,
		createdAt: announcement.createdAt.toISOString(),
		updatedAt: announcement.updatedAt.toISOString(),
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)

	const announcements = await db
		.select()
		.from(OrganizationAnnouncement)
		.where(eq(OrganizationAnnouncement.organizationId, organization.id))
		.orderBy(
			asc(OrganizationAnnouncement.position),
			desc(OrganizationAnnouncement.createdAt),
		)

	return {
		organization,
		localesConfig,
		announcements: announcements.map((announcement) =>
			serializeAnnouncement(announcement, localesConfig.defaultLocale),
		),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (
		intent === createAnnouncementIntent ||
		intent === updateAnnouncementIntent
	) {
		const submission = parseWithZod(formData, { schema: AnnouncementSchema })

		if (submission.status !== 'success') {
			return Response.json({
				status: 'error',
				result: submission.reply(),
			})
		}

		const {
			id,
			contentJson,
			type,
			isEnabled,
			addLink,
			linkUrl,
			linkLabelJson,
			linkNewTab,
			defaultLocale,
		} = submission.value
		const wantsLink = addLink === 'on'
		const contentMap = parseLocalizedString(
			contentJson,
			defaultLocale || localesConfig.defaultLocale,
		)
		const linkLabelMap = wantsLink
			? parseLocalizedString(
					linkLabelJson,
					defaultLocale || localesConfig.defaultLocale,
				)
			: {}

		const data = {
			content: serializeLocalizedString(contentMap),
			type,
			isEnabled: isEnabled === 'true',
			linkUrl: wantsLink ? (linkUrl ?? null) : null,
			linkLabel: wantsLink
				? serializeLocalizedString(linkLabelMap) || null
				: null,
			linkNewTab: wantsLink ? linkNewTab === 'on' : true,
		}

		if (intent === createAnnouncementIntent) {
			const [last] = await db
				.select({ position: OrganizationAnnouncement.position })
				.from(OrganizationAnnouncement)
				.where(eq(OrganizationAnnouncement.organizationId, organization.id))
				.orderBy(desc(OrganizationAnnouncement.position))
				.limit(1)
			const nextPosition = (last?.position ?? 0) + 1

			await db.insert(OrganizationAnnouncement).values({
				organizationId: organization.id,
				position: nextPosition,
				...data,
			})

			return Response.json({ status: 'success' })
		}

		if (!id) {
			return Response.json(
				{
					status: 'error',
					result: submission.reply({
						formErrors: ['Announcement not found'],
					}),
				},
				{ status: 400 },
			)
		}

		const [existing] = await db
			.select({ id: OrganizationAnnouncement.id })
			.from(OrganizationAnnouncement)
			.where(
				and(
					eq(OrganizationAnnouncement.id, id),
					eq(OrganizationAnnouncement.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!existing) {
			return Response.json(
				{
					status: 'error',
					result: submission.reply({
						formErrors: ['Announcement not found'],
					}),
				},
				{ status: 404 },
			)
		}

		await db
			.update(OrganizationAnnouncement)
			.set(data)
			.where(eq(OrganizationAnnouncement.id, id))

		return Response.json({ status: 'success' })
	}

	if (intent === toggleAnnouncementIntent) {
		const id = String(formData.get('id') || '')
		const isEnabled = formData.get('isEnabled') === 'true'

		if (!id) {
			return Response.json({ status: 'error' }, { status: 400 })
		}

		const [existing] = await db
			.select({ id: OrganizationAnnouncement.id })
			.from(OrganizationAnnouncement)
			.where(
				and(
					eq(OrganizationAnnouncement.id, id),
					eq(OrganizationAnnouncement.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!existing) {
			return Response.json({ status: 'error' }, { status: 404 })
		}

		await db
			.update(OrganizationAnnouncement)
			.set({ isEnabled })
			.where(eq(OrganizationAnnouncement.id, id))

		return Response.json({ status: 'success' })
	}

	if (intent === deleteAnnouncementIntent) {
		const id = String(formData.get('id') || '')

		if (!id) {
			return Response.json({ status: 'error' }, { status: 400 })
		}

		await db
			.delete(OrganizationAnnouncement)
			.where(
				and(
					eq(OrganizationAnnouncement.id, id),
					eq(OrganizationAnnouncement.organizationId, organization.id),
				),
			)

		return Response.json({ status: 'success' })
	}

	return Response.json({ status: 'error' }, { status: 400 })
}

function TypeBadge({ type }: { type: AnnouncementType }) {
	const { _ } = useLingui()
	const labels: Record<AnnouncementType, string> = {
		info: _(msg`Info`),
		warning: _(msg`Warning`),
		error: _(msg`Error`),
		success: _(msg`Success`),
	}

	const dotColor =
		type === 'error'
			? 'bg-red-500'
			: type === 'warning'
				? 'bg-amber-500'
				: type === 'success'
					? 'bg-emerald-500'
					: 'bg-muted-foreground/64'

	return (
		<Badge variant="outline">
			<span
				aria-hidden="true"
				className={cn('size-1.5 rounded-full', dotColor)}
			/>
			{labels[type]}
		</Badge>
	)
}

function AnnouncementRow({
	announcement,
	activeLocale,
	defaultLocale,
	onEdit,
}: {
	announcement: AnnouncementRecord
	activeLocale: string
	defaultLocale: string
	onEdit: (announcement: AnnouncementRecord) => void
}) {
	const { _ } = useLingui()
	const toggleFetcher = useFetcher()
	const deleteFetcher = useFetcher()
	const busy = toggleFetcher.state !== 'idle' || deleteFetcher.state !== 'idle'
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
	const isEnabled =
		toggleFetcher.formData?.get('isEnabled') !== undefined
			? toggleFetcher.formData.get('isEnabled') === 'true'
			: announcement.isEnabled
	const preview = getAnnouncementPreviewText(
		announcement,
		activeLocale,
		defaultLocale,
	)
	const linkLabel =
		pickLocalized(announcement.linkLabel, activeLocale, defaultLocale) ||
		announcement.linkUrl

	return (
		<TableRow className={busy ? 'opacity-60' : undefined}>
			<TableCell className="w-18">
				<Switch
					checked={isEnabled}
					disabled={busy}
					aria-label={_(msg`Toggle announcement visibility`)}
					onCheckedChange={(checked) => {
						void toggleFetcher.submit(
							{
								intent: toggleAnnouncementIntent,
								id: announcement.id,
								isEnabled: checked ? 'true' : 'false',
							},
							{ method: 'POST' },
						)
					}}
				/>
			</TableCell>
			<TableCell className="max-w-70">
				<button
					type="button"
					className="hover:text-primary line-clamp-2 text-left text-sm font-medium"
					onClick={() => onEdit(announcement)}
				>
					{preview}
				</button>
			</TableCell>
			<TableCell>
				<TypeBadge type={announcement.type} />
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
				{announcement.linkUrl ? (
					<span className="line-clamp-1">{linkLabel}</span>
				) : (
					<span>—</span>
				)}
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
				{formatDistanceToNow(new Date(announcement.updatedAt), {
					addSuffix: true,
				})}
			</TableCell>
			<TableCell className="text-right">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={_(msg`Announcement actions`)}
							>
								<Icon name="ellipsis" className="size-4" />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => onEdit(announcement)}>
							<Icon name="pencil" className="mr-2 size-4" />
							<Trans>Edit</Trans>
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onClick={() => setDeleteDialogOpen(true)}
						>
							<Icon name="trash-2" className="mr-2 size-4" />
							<Trans>Delete</Trans>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>

				<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete announcement?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									This action cannot be undone. Are you sure you want to delete
									this announcement?
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
											intent: deleteAnnouncementIntent,
											id: announcement.id,
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
			</TableCell>
		</TableRow>
	)
}

export default function WebsiteAnnouncementsRoute() {
	const { organization, announcements, localesConfig } =
		useLoaderData<typeof loader>()
	const revalidator = useRevalidator()
	const [sheetOpen, setSheetOpen] = useState(false)
	const [editing, setEditing] = useState<AnnouncementRecord | null>(null)
	const [activeLocale, setActiveLocale] = useState<string>(
		localesConfig.defaultLocale,
	)

	const handleOpenChange = useCallback(
		(open: boolean) => {
			setSheetOpen(open)
			if (!open) {
				setEditing(null)
				void revalidator.revalidate()
			}
		},
		[revalidator],
	)

	const handleEdit = useCallback((announcement: AnnouncementRecord) => {
		setEditing(announcement)
		setSheetOpen(true)
	}, [])

	const announcementCount = announcements.length

	return (
		<LocaleContext.Provider
			value={{
				activeLocale,
				defaultLocale: localesConfig.defaultLocale,
				locales: localesConfig.locales,
				setActiveLocale,
			}}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={localesConfig.defaultLocale}
			>
				<div className="space-y-8">
					<PageHeader
						title={<Trans>Announcements</Trans>}
						description={
							<Trans>
								Create banner announcements for your public organization site.
								Enabled banners appear at the top of the site for visitors.
							</Trans>
						}
						headingLevel="h2"
						size="section"
						actions={
							<>
								<LocaleSwitcher className="max-w-none" />
								<Button
									type="button"
									onClick={() => {
										setEditing(null)
										setSheetOpen(true)
									}}
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add announcement</Trans>
								</Button>
							</>
						}
					/>

					{announcements.length === 0 ? (
						<EmptyState
							title={t`No announcements yet`}
							description={t`Add an announcement to share updates, maintenance notices, or promotions on your public site.`}
							icons={['bell']}
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
											<Trans>Content</Trans>
										</TableHead>
										<TableHead>
											<Trans>Type</Trans>
										</TableHead>
										<TableHead className="hidden sm:table-cell">
											<Trans>Link</Trans>
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
									{announcements.map((announcement) => (
										<AnnouncementRow
											key={announcement.id}
											announcement={announcement}
											activeLocale={activeLocale}
											defaultLocale={localesConfig.defaultLocale}
											onEdit={handleEdit}
										/>
									))}
								</TableBody>
								<TableFooter>
									<TableRow>
										<TableCell colSpan={5}>
											{announcementCount === 1 ? (
												<Trans>1 announcement</Trans>
											) : (
												<Trans>{announcementCount} announcements</Trans>
											)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableFooter>
							</Table>
						</Frame>
					)}
				</div>

				<AnnouncementSheet
					open={sheetOpen}
					onOpenChange={handleOpenChange}
					organizationId={organization.id}
					localesConfig={localesConfig}
					announcement={editing}
				/>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
