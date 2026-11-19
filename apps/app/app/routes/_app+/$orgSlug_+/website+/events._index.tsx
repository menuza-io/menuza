/**
 * Website, Events (#184, flag `website.events`): the list, and "New event"
 * (a draft opened in the editor). 404 while the flag is off. Read with
 * `read:website:any`, change with `update:website:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { eventPhase, nextOccurrence } from '@repo/common/site-events'
import { pickLocalized } from '@repo/common/site-locales'
import {
	asc,
	db,
	desc,
	eq,
	OrganizationLocation,
	SiteEvent,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	redirect,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireEventsAccess } from '#app/utils/seo/site-events-access.server.ts'
import { scheduleOf } from '#app/utils/seo/site-events.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'read',
	)
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const rows = await db
		.select()
		.from(SiteEvent)
		.where(eq(SiteEvent.organizationId, organization.id))
		.orderBy(desc(SiteEvent.updatedAt))
	const now = Date.now()
	return {
		events: rows.map((row) => {
			const schedule = scheduleOf(row)
			const next = nextOccurrence(schedule, now)
			return {
				id: row.id,
				title: pickLocalized(row.title, defaultLocale, defaultLocale),
				slug: row.slug,
				status: row.status,
				phase: eventPhase(schedule, now),
				next: next.ok ? next.occurrence.start : null,
				timezone: row.timezone,
				repeats: schedule.recurrence.frequency !== 'none',
			}
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'update',
	)
	const formData = await request.formData()
	if (formData.get('intent') !== 'create-event') {
		return Response.json(
			{ ok: false, error: 'invalid_intent' },
			{ status: 400 },
		)
	}
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
		.limit(1)
	const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const [created] = await db
		.insert(SiteEvent)
		.values({
			organizationId: organization.id,
			organizationLocationId: location?.id ?? null,
			slug: `event-${Date.now().toString(36)}`,
			status: 'draft',
			title: JSON.stringify({ [defaultLocale]: 'New event' }),
			startLocal: `${tomorrow}T19:00`,
			endLocal: `${tomorrow}T21:00`,
			timezone: location?.timezone || organization.staffingTimeZone || 'UTC',
		})
		.returning({ id: SiteEvent.id })
	return redirect(`/${organization.slug}/website/events/${created!.id}`)
}

export default function WebsiteEventsRoute() {
	const { events } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const createFetcher = useFetcher()
	const phaseLabel = {
		upcoming: msg`Upcoming`,
		ended: msg`Ended`,
		gone: msg`Ended`,
	} as const
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Events</Trans>}
				description={
					<Trans>
						Announce trivia nights, live music or a holiday brunch. Each event
						gets its own page with an Add to calendar file.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<createFetcher.Form method="POST">
						<input type="hidden" name="intent" value="create-event" />
						<Button type="submit" disabled={createFetcher.state !== 'idle'}>
							<Trans>New event</Trans>
						</Button>
					</createFetcher.Form>
				}
			/>
			{events.length === 0 ? (
				<EmptyState
					title={_(msg`No events yet`)}
					description={_(
						msg`Add an event, then put the Upcoming events section on any page.`,
					)}
					icons={['calendar']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Event</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead>
									<Trans>Next</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{events.map((event) => (
								<TableRow key={event.id}>
									<TableCell>
										<Link
											to={event.id}
											className="hover:text-primary font-medium"
										>
											{event.title || event.slug}
										</Link>
										{event.repeats ? (
											<Badge variant="outline" className="ms-2 text-xs">
												<Trans>Repeats</Trans>
											</Badge>
										) : null}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												event.status === 'published' ? 'secondary' : 'outline'
											}
										>
											{event.status === 'published' ? (
												<Trans>Published</Trans>
											) : (
												<Trans>Draft</Trans>
											)}
										</Badge>{' '}
										<span className="text-muted-foreground text-xs">
											{_(phaseLabel[event.phase])}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{event.next
											? i18n.date(new Date(event.next), {
													dateStyle: 'medium',
													timeStyle: 'short',
													timeZone: event.timezone,
												})
											: '—'}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}
