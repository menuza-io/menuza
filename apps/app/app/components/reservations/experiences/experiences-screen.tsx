import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspaceToolbar } from '@repo/ui/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { ExperienceCreateSheet } from '#app/components/reservations/experiences/experience-create-sheet.tsx'
import { ReservationsHeaderActions } from '#app/components/reservations/shell-context.tsx'
import { FilterSelect, type Option } from '#app/components/staff/controls.tsx'
import {
	type ExperienceDto,
	fetchExperienceContext,
	fetchExperiences,
} from '#app/utils/reservations/experiences-api.ts'
import {
	EXPERIENCE_KIND_LABELS,
	EXPERIENCE_STATUS_LABELS,
	experienceErrorStatus,
	formatCalendarDate,
	pickExperienceText,
	seatingSummary,
} from '#app/utils/reservations/experiences-view.ts'
import { formatMoney } from '#app/utils/reservations/payments-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

type Filter = 'active' | 'published' | 'draft' | 'archived'

type LoadState =
	| { status: 'loading' }
	| { status: 'denied' }
	| { status: 'failed' }
	| { status: 'ready'; experiences: ExperienceDto[]; currency: string }

const STATUS_DOT: Record<ExperienceDto['status'], string> = {
	published: 'bg-success',
	draft: 'bg-muted-foreground/60',
	archived: 'bg-muted-foreground/30',
}

/**
 * The experiences of one location: draft, published and archived. A row opens
 * the editor. Reads go browser-direct to the regional tenant-api.
 */
export function ExperiencesScreen({
	client,
	orgSlug,
	locationId,
	canWrite,
}: {
	client: ReservationsScopedClient
	orgSlug: string
	locationId: string
	canWrite: boolean
}) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const [state, setState] = useState<LoadState>({ status: 'loading' })
	const [filter, setFilter] = useState<Filter>('active')
	const [creating, setCreating] = useState(false)
	const requestId = useRef(0)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const current = (requestId.current += 1)
			try {
				const [experiences, context] = await Promise.all([
					fetchExperiences(client, locationId, signal),
					fetchExperienceContext(
						client,
						locationId,
						{ withPolicies: false },
						signal,
					),
				])
				if (current !== requestId.current) return
				setState({ status: 'ready', experiences, currency: context.currency })
			} catch (error) {
				if (signal?.aborted || current !== requestId.current) return
				const status = experienceErrorStatus(error)
				setState({
					status: status === 403 || status === 404 ? 'denied' : 'failed',
				})
			}
		},
		[client, locationId],
	)

	useEffect(() => {
		const controller = new AbortController()
		setState({ status: 'loading' })
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const filterOptions: Option[] = [
		{ value: 'active', label: t`Active` },
		{ value: 'published', label: i18n._(EXPERIENCE_STATUS_LABELS.published) },
		{ value: 'draft', label: i18n._(EXPERIENCE_STATUS_LABELS.draft) },
		{ value: 'archived', label: i18n._(EXPERIENCE_STATUS_LABELS.archived) },
	]

	const all = state.status === 'ready' ? state.experiences : []
	const shown = all.filter((experience) =>
		filter === 'active'
			? experience.status !== 'archived'
			: experience.status === filter,
	)
	const currency = state.status === 'ready' ? state.currency : 'USD'

	function priceText(experience: ExperienceDto): string {
		if (experience.priceMinor === null) return '—'
		const amount = formatMoney(
			experience.priceMinor,
			experience.currency,
			i18n.locale,
		)
		return experience.pricePerCover
			? t`${amount} per guest`
			: t`${amount} per booking`
	}

	function partyText(experience: ExperienceDto): string {
		const min = i18n.number(experience.partyMin)
		const max = i18n.number(experience.partyMax)
		return experience.partyMin === experience.partyMax
			? t`${min} guests`
			: t`${min} to ${max} guests`
	}

	function schedulesText(experience: ExperienceDto): string {
		if (experience.schedules.length === 0) return t`No schedules yet`
		const upcoming = experience.schedules.find(
			(schedule) => schedule.seatings.length > 0,
		)
		if (!upcoming) return t`No seating times`
		const first = formatCalendarDate(upcoming.fromDate, i18n.locale)
		const times = seatingSummary(upcoming, i18n.locale, 3)
		return `${first} · ${times}`
	}

	const editorHref = (id: string) =>
		`/${orgSlug}/reservations/experiences/${encodeURIComponent(id)}?locationId=${encodeURIComponent(locationId)}`

	return (
		<div className="flex flex-col gap-6" data-testid="experiences-screen">
			{canWrite ? (
				<ReservationsHeaderActions>
					<Button
						type="button"
						onClick={() => setCreating(true)}
						disabled={state.status !== 'ready'}
						data-testid="experience-new"
					>
						<Icon name="plus" />
						<Trans>New experience</Trans>
					</Button>
				</ReservationsHeaderActions>
			) : null}

			{state.status === 'ready' && all.length > 0 ? (
				<WorkspaceToolbar>
					<FilterSelect
						label={t`Show`}
						options={filterOptions}
						value={filter}
						onValueChange={(value) => setFilter(value as Filter)}
					/>
				</WorkspaceToolbar>
			) : null}

			{state.status === 'loading' ? (
				<div className="flex flex-col gap-2" data-testid="experiences-loading">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : state.status === 'denied' ? (
				<Alert variant="destructive" data-testid="experiences-denied">
					<AlertDescription>
						<Trans>You do not have access to experiences here.</Trans>
					</AlertDescription>
				</Alert>
			) : state.status === 'failed' ? (
				<Alert variant="destructive" data-testid="experiences-error">
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							<Trans>The experiences could not be loaded.</Trans>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setState({ status: 'loading' })
									void load()
								}}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : all.length === 0 ? (
				<EmptyState
					icons={['calendar', 'users', 'clock']}
					title={<Trans>No experiences configured yet</Trans>}
					description={
						<Trans>
							Create a prepaid or ticketed dining experience, give it seating
							times, and publish it on your website.
						</Trans>
					}
				>
					{canWrite ? (
						<Button type="button" onClick={() => setCreating(true)}>
							<Icon name="plus" />
							<Trans>New experience</Trans>
						</Button>
					) : null}
				</EmptyState>
			) : shown.length === 0 ? (
				<EmptyState
					icons={['calendar', 'users', 'clock']}
					title={<Trans>Nothing matches this filter</Trans>}
				>
					<Button
						type="button"
						variant="outline"
						onClick={() => setFilter('active')}
					>
						<Trans>Show active experiences</Trans>
					</Button>
				</EmptyState>
			) : (
				<Frame>
					<Table variant="card" data-testid="experiences-table">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Experience</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead>
									<Trans>Price</Trans>
								</TableHead>
								<TableHead>
									<Trans>Party</Trans>
								</TableHead>
								<TableHead>
									<Trans>Next seatings</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{shown.map((experience) => (
								<TableRow key={experience.id} data-testid="experience-row">
									<TableCell className="min-w-48">
										<div className="flex flex-col gap-0.5">
											<Link
												to={editorHref(experience.id)}
												className="font-medium wrap-anywhere hover:underline focus-visible:underline"
												data-testid="experience-link"
											>
												{pickExperienceText(experience.nameI18n, i18n.locale) ||
													experience.slug}
											</Link>
											<span className="text-muted-foreground text-xs">
												{i18n._(EXPERIENCE_KIND_LABELS[experience.kind])}
											</span>
										</div>
									</TableCell>
									<TableCell>
										<span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
											<span
												aria-hidden="true"
												className={cn(
													'size-1.5 rounded-full',
													STATUS_DOT[experience.status],
												)}
											/>
											{i18n._(EXPERIENCE_STATUS_LABELS[experience.status])}
										</span>
									</TableCell>
									<TableCell className="tabular-nums">
										{priceText(experience)}
									</TableCell>
									<TableCell className="tabular-nums">
										{partyText(experience)}
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{schedulesText(experience)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}

			<ExperienceCreateSheet
				open={creating}
				onClose={() => setCreating(false)}
				client={client}
				locationId={locationId}
				currency={currency}
				onCreated={(experience) => {
					setCreating(false)
					void navigate(editorHref(experience.id))
				}}
			/>
		</div>
	)
}
