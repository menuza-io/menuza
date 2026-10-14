import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { PositionChip } from '@repo/ui/position-color'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo } from 'react'
import {
	Link,
	Outlet,
	useLoaderData,
	useNavigate,
	useSearchParams,
} from 'react-router'
import { AccessTab } from '#app/components/staff/access-tab.tsx'
import { DetailsTab } from '#app/components/staff/details-tab.tsx'
import { NotesTab } from '#app/components/staff/notes-tab.tsx'
import { CertificatesTab } from '#app/components/staff/onboarding/certificates-tab.tsx'
import { OnboardingTab } from '#app/components/staff/onboarding/onboarding-tab.tsx'
import { PageWithBack } from '#app/components/staff/page-back.tsx'
import { PositionsTab } from '#app/components/staff/positions-tab.tsx'
import {
	AttentionList,
	ProfileNav,
	useProfileGroups,
} from '#app/components/staff/staff-profile-page.tsx'
import { StaffStatusLabel } from '#app/components/staff/staff-status.tsx'
import {
	type StaffTeamContext,
	StaffTeamContextProvider,
} from '#app/components/staff/team-context.ts'
import {
	useStaffAttention,
	type ProfileSection,
} from '#app/hooks/use-staff-attention.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	getStaffingFeatureState,
	requireStaffingAccess,
} from '#app/utils/staffing/access.server.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import {
	positionsSchema,
	staffDetailSchema,
	type StaffAssignmentRow,
} from '#app/utils/staffing/staff-types.ts'
import {
	filterScopesToScope,
	loadStaffScopes,
} from '#app/utils/staffing/team-context.server.ts'
import { type Route } from './+types/team_.$staffId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.team,
	)
	const canInvite = await userHasOrganizationPermission(
		access.userId,
		access.organizationId,
		ORG_PERMISSIONS.CREATE_MEMBER_ANY,
	)
	// The Onboarding and Certificates tabs belong to Hiring: they need that flag
	// and the hiring read grant, and do not exist for anyone without both.
	const features = await getStaffingFeatureState(access.organizationId)
	const hiring =
		features.hiring && holdsStaffingGrant(access.grants, P.READ_HIRING)
	// A manager limited to some scopes is only offered those, as on the roster.
	const scopes = filterScopesToScope(
		await loadStaffScopes(access.organizationId),
		access.scopeIds,
	)
	return {
		orgSlug: params.orgSlug,
		staffId: params.staffId,
		canInvite,
		hiring,
		dataRegion:
			access.dataRegion === 'ksa' ? ('ksa' as const) : ('us' as const),
		scopes,
	}
}

const NO_ASSIGNMENTS: StaffAssignmentRow[] = []

function isSection(
	value: string | null,
	hiring: boolean,
): value is ProfileSection {
	if (value === 'onboarding' || value === 'certificates') return hiring
	return (
		value === 'details' ||
		value === 'positions' ||
		value === 'access' ||
		value === 'notes'
	)
}

export default function StaffProfileRoute() {
	const {
		orgSlug,
		staffId,
		canInvite,
		hiring,
		dataRegion,
		scopes: rawScopes,
	} = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const navigate = useNavigate()
	const [searchParams] = useSearchParams()
	const { client, can, ready } = useStaffClient('staff')
	const basePath = `/${orgSlug}/staff/team`
	const query = useStaffQuery(
		client,
		ready ? `/${staffId}` : null,
		staffDetailSchema,
	)
	const positionsQuery = useStaffQuery(
		client,
		ready ? '/positions' : null,
		positionsSchema,
	)
	const detail = query.data

	// Scope names may be stored per language; show the operator's language.
	const scopes = useMemo(
		() =>
			rawScopes.map((scope) => ({
				...scope,
				name: pickLocalized(scope.name, i18n.locale, 'en') || scope.name,
			})),
		[rawScopes, i18n.locale],
	)
	const scopeNames = useMemo(
		() => new Map(scopes.map((scope) => [scope.id, scope.name])),
		[scopes],
	)
	const positions = useMemo(
		() => positionsQuery.data?.positions ?? [],
		[positionsQuery.data],
	)
	const positionMap = useMemo(
		() => new Map(positions.map((position) => [position.id, position])),
		[positions],
	)

	const terminated = detail?.staff.status === 'terminated'
	const attention = useStaffAttention({
		staffId,
		assignments: detail?.assignments ?? NO_ASSIGNMENTS,
		scopeNames,
		hiring,
		terminated: Boolean(terminated),
	})
	const { reload: reloadAttention } = attention
	const { reload: reloadPositions } = positionsQuery

	const requested = searchParams.get('section')
	const section: ProfileSection = isSection(requested, hiring)
		? requested
		: 'details'
	const groups = useProfileGroups(hiring)
	const hrefFor = (id: ProfileSection) =>
		id === 'details'
			? `${basePath}/${staffId}`
			: `${basePath}/${staffId}?section=${id}`

	// Edits in a section can clear (or cause) an item, so look again on each change.
	useEffect(() => {
		reloadAttention()
	}, [section, reloadAttention])

	const context: StaffTeamContext = {
		orgSlug,
		basePath,
		dataRegion,
		scopes,
		positions,
		// This page is not inside the roster, so there is no list to refresh.
		reloadRoster: () => undefined,
		reloadOnboarding: reloadAttention,
		reloadPositions,
		close: () => void navigate(basePath),
	}

	if (query.error && !detail) {
		const notFound = 'status' in query.error && query.error.status === 404
		return (
			<div className="flex flex-col gap-4 px-4 md:px-0">
				<PageWithBack to={basePath} label={_(t`Team`)}>
					<h1 className="text-2xl tracking-tight">
						{notFound ? (
							<Trans>We could not find that person</Trans>
						) : (
							<Trans>Could not load</Trans>
						)}
					</h1>
				</PageWithBack>
				<Alert variant={notFound ? 'default' : 'destructive'}>
					<AlertDescription>
						{notFound
							? _(
									t`They may have been removed, or you may not have access to their workplace.`,
								)
							: describeStaffError(query.error, _)}
					</AlertDescription>
				</Alert>
				{!notFound ? (
					<Button onClick={query.reload}>
						<Trans>Try again</Trans>
					</Button>
				) : null}
			</div>
		)
	}

	if (!detail) {
		return (
			<div className="flex flex-col gap-6 px-4 md:px-0">
				<Skeleton className="h-4 w-32" />
				<div aria-hidden="true" className="flex items-center gap-4">
					<Skeleton className="size-14 rounded-full" />
					<Skeleton className="h-6 w-56" />
				</div>
				<span className="sr-only">
					<Trans>Loading profile</Trans>
				</span>
				<Skeleton className="h-40 w-full" />
			</div>
		)
	}

	const person = detail.staff
	const name = staffDisplayName(person, i18n.locale)
	const canWrite = can(P.UPDATE_STAFF)
	const changed = () => {
		query.reload()
		reloadAttention()
	}
	const leftOn = person.terminatedAt
		? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
				person.terminatedAt,
			)
		: null
	const hired = person.hiredDate
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'medium',
				timeZone: 'UTC',
			}).format(new Date(`${person.hiredDate}T12:00:00Z`))
		: null
	const workerType =
		person.workerType === 'contractor' ? _(t`Contractor`) : _(t`Employee`)
	const jobPositions = [
		...new Map(
			detail.jobs
				.filter((job) => job.effectiveTo === null)
				.map((job) => [job.positionId, positionMap.get(job.positionId)]),
		).values(),
	].filter(Boolean)

	return (
		<StaffTeamContextProvider value={context}>
			<div className="flex flex-col gap-6 px-4 md:px-0">
				<PageWithBack to={basePath} label={_(t`Team`)}>
					<header className="flex items-start justify-between gap-4">
						<div className="flex min-w-0 items-center gap-4">
							<div className="flex min-w-0 flex-col gap-1">
								<h1 className="truncate text-2xl tracking-tight">{name}</h1>
								<div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
									<StaffStatusLabel status={person.status} />
									<span aria-hidden="true">·</span>
									<span>{workerType}</span>
									{hired ? (
										<>
											<span aria-hidden="true">·</span>
											<span>
												<Trans>Hired {hired}</Trans>
											</span>
										</>
									) : null}
									{jobPositions.map((position) =>
										position ? (
											<PositionChip
												key={position.id}
												colorKey={position.colorKey}
											>
												{position.name}
											</PositionChip>
										) : null,
									)}
								</div>
							</div>
						</div>
						{canWrite ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={_(t`More actions for ${name}`)}
										>
											<Icon name="ellipsis" />
										</Button>
									}
								/>
								<DropdownMenuContent align="end">
									{terminated ? (
										<DropdownMenuItem
											render={<Link to={`${basePath}/${staffId}/rehire`} />}
										>
											<Icon name="undo-2" />
											<Trans>Rehire</Trans>
										</DropdownMenuItem>
									) : (
										<DropdownMenuItem
											render={<Link to={`${basePath}/${staffId}/terminate`} />}
										>
											<Icon name="log-out" />
											<Trans>Terminate…</Trans>
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</header>
				</PageWithBack>

				{terminated ? (
					<Alert role="status">
						<AlertTitle>
							<Trans>Left on {leftOn}</Trans>
						</AlertTitle>
						<AlertDescription>
							{person.terminationReason ? (
								<p>{person.terminationReason}</p>
							) : null}
							<p>
								{person.eligibleForRehire === false ? (
									<Trans>Not eligible for rehire.</Trans>
								) : (
									<Trans>Eligible for rehire.</Trans>
								)}
							</p>
						</AlertDescription>
					</Alert>
				) : (
					<AttentionList
						items={attention.items}
						onGo={(target) =>
							void navigate(hrefFor(target), { preventScrollReset: true })
						}
					/>
				)}

				<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
					<ProfileNav
						groups={groups}
						section={section}
						badges={attention.badges}
						hrefFor={hrefFor}
					/>
					<div className="flex min-w-0 flex-col gap-6">
						{section === 'details' ? (
							<>
								<DetailsTab
									key={person.updatedAt ?? person.id}
									detail={detail}
									onChanged={changed}
								/>
							</>
						) : null}
						{section === 'positions' ? (
							<>
								<PositionsTab detail={detail} onChanged={changed} />
							</>
						) : null}
						{section === 'access' ? (
							<>
								<AccessTab
									detail={detail}
									canInvite={canInvite}
									onChanged={changed}
								/>
							</>
						) : null}
						{hiring && section === 'onboarding' ? (
							<>
								<OnboardingTab
									staffId={person.id}
									terminated={Boolean(terminated)}
									onChanged={reloadAttention}
								/>
							</>
						) : null}
						{hiring && section === 'certificates' ? (
							<>
								<CertificatesTab
									staffId={person.id}
									terminated={Boolean(terminated)}
								/>
							</>
						) : null}
						{section === 'notes' ? (
							<>
								<NotesTab staffId={person.id} />
							</>
						) : null}
					</div>
				</div>
			</div>
			<Outlet
				context={{
					staff: person,
					onChanged: changed,
					close: () => void navigate(`${basePath}/${staffId}`),
				}}
			/>
		</StaffTeamContextProvider>
	)
}
