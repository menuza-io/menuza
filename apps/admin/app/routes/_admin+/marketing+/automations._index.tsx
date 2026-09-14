import { i18n } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	requireUserWithPermission,
	SYSTEM_PERMISSIONS,
	userHasPermission,
} from '@repo/auth'
import {
	deletePlatformJourney,
	duplicatePlatformJourney,
	listPlatformJourneys,
	pausePlatformJourney,
	publishPlatformJourney,
} from '@repo/marketing/server/platform-journeys'
import { type PlatformJourneyListItem } from '@repo/marketing/types/platform'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { useState } from 'react'
import {
	Link,
	redirect,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'

const JOURNEY_STATUS_LABELS: Record<
	'draft' | 'active' | 'paused' | 'archived',
	ReturnType<typeof msg>
> = {
	draft: msg`Draft`,
	active: msg`Active`,
	paused: msg`Paused`,
	archived: msg`Archived`,
}

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserWithPermission(
		request,
		SYSTEM_PERMISSIONS.READ_PLATFORM_AUTOMATION_ANY,
	)
	const [journeys, canManage] = await Promise.all([
		listPlatformJourneys(),
		userHasPermission(
			userId,
			SYSTEM_PERMISSIONS.UPDATE_PLATFORM_AUTOMATION_ANY,
		),
	])
	return { journeys, canManage, error: null }
}

export async function action({ request }: ActionFunctionArgs) {
	await requireUserWithPermission(
		request,
		SYSTEM_PERMISSIONS.UPDATE_PLATFORM_AUTOMATION_ANY,
	)
	const formData = await request.formData()
	const intent = formData.get('intent')
	const journeyId = String(formData.get('journeyId') || '')

	try {
		if (intent === 'publish') {
			await publishPlatformJourney(journeyId)
		} else if (intent === 'pause') {
			await pausePlatformJourney(journeyId)
		} else if (intent === 'delete') {
			await deletePlatformJourney(journeyId)
		} else if (intent === 'duplicate') {
			const created = await duplicatePlatformJourney(journeyId)
			if (created?.id) {
				return redirect(`/marketing/automations/${created.id}`)
			}
		}
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : i18n._(t`Action failed`),
		}
	}

	return redirect('/marketing/automations')
}

export default function AdminAutomationsIndexRoute() {
	const { _ } = useLingui()
	const { journeys, canManage, error } = useLoaderData<typeof loader>()
	const fetcher = useFetcher()
	const [searchQuery, setSearchQuery] = useState('')

	const filtered = journeys.filter((j: PlatformJourneyListItem) =>
		j.name.toLowerCase().includes(searchQuery.toLowerCase()),
	)

	const getTriggerLabel = (triggerType: string) => {
		switch (triggerType) {
			case 'org_created':
				return _(msg`Organization Created`)
			case 'operator_invited':
				return _(msg`Operator Invited`)
			case 'subscription_started':
				return _(msg`Subscription Started`)
			case 'subscription_cancelled':
				return _(msg`Subscription Cancelled`)
			case 'manual':
				return _(msg`Manual Trigger`)
			default:
				return triggerType.replace(/_/g, ' ')
		}
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between border-b pb-4">
				<div>
					<h1 className="text-2xl font-bold tracking-tight">
						<Trans>Platform Automations</Trans>
					</h1>
					<p className="text-muted-foreground mt-1 text-sm">
						<Trans>Event-driven workflows for tenant operator lifecycle.</Trans>
					</p>
				</div>
				{canManage ? (
					<Button
						render={<Link to="/marketing/automations/new" />}
						className="gap-2"
					>
						<Icon name="plus" className="size-4" />
						<Trans>New Automation</Trans>
					</Button>
				) : null}
			</div>

			<Input
				placeholder={_(msg`Search automations...`)}
				value={searchQuery}
				onChange={(e) => setSearchQuery(e.target.value)}
				className="h-9 max-w-md"
			/>

			{error && (
				<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border p-4 text-sm">
					{error}
				</div>
			)}

			{filtered.length === 0 ? (
				<EmptyState
					title={_(msg`No automations found`)}
					description={_(msg`Create your first platform automation workflow.`)}
					icons={['route', 'mail']}
					action={
						canManage
							? {
									label: _(msg`Create Automation`),
									href: '/marketing/automations/new',
								}
							: undefined
					}
				/>
			) : (
				<ItemGroup>
					{filtered.map((journey) => {
						const journeySummary = (
							<>
								<ItemTitle>{journey.name}</ItemTitle>
								<ItemDescription>
									{getTriggerLabel(journey.triggerType)}
									{' · '}
									{journey.stepCount} <Trans>steps</Trans>
									{' · '}
									{journey.runsCount} <Trans>runs</Trans>
								</ItemDescription>
							</>
						)

						return (
							<Item key={journey.id} variant="outline" size="sm">
								<ItemContent>
									{canManage ? (
										<Link
											to={`/marketing/automations/${journey.id}`}
											className="min-w-0"
										>
											{journeySummary}
										</Link>
									) : (
										<div className="min-w-0">{journeySummary}</div>
									)}
								</ItemContent>
								<ItemActions>
									<Badge variant="outline" className="text-[10px] capitalize">
										{_(
											JOURNEY_STATUS_LABELS[
												journey.status as keyof typeof JOURNEY_STATUS_LABELS
											],
										)}
									</Badge>
									{canManage ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<Button
														variant="ghost"
														size="icon-xs"
														aria-label={_(msg`Actions`)}
													/>
												}
											>
												<Icon name="ellipsis" className="size-4" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													render={
														<Link to={`/marketing/automations/${journey.id}`} />
													}
												>
													<Trans>Edit</Trans>
												</DropdownMenuItem>
												{journey.status !== 'active' && (
													<fetcher.Form method="post">
														<input
															type="hidden"
															name="intent"
															value="publish"
														/>
														<input
															type="hidden"
															name="journeyId"
															value={journey.id}
														/>
														<DropdownMenuItem render={<button type="submit" />}>
															<Trans>Publish</Trans>
														</DropdownMenuItem>
													</fetcher.Form>
												)}
												{journey.status === 'active' && (
													<fetcher.Form method="post">
														<input type="hidden" name="intent" value="pause" />
														<input
															type="hidden"
															name="journeyId"
															value={journey.id}
														/>
														<DropdownMenuItem render={<button type="submit" />}>
															<Trans>Pause</Trans>
														</DropdownMenuItem>
													</fetcher.Form>
												)}
												<fetcher.Form method="post">
													<input
														type="hidden"
														name="intent"
														value="duplicate"
													/>
													<input
														type="hidden"
														name="journeyId"
														value={journey.id}
													/>
													<DropdownMenuItem render={<button type="submit" />}>
														<Trans>Duplicate</Trans>
													</DropdownMenuItem>
												</fetcher.Form>
												<fetcher.Form method="post">
													<input type="hidden" name="intent" value="delete" />
													<input
														type="hidden"
														name="journeyId"
														value={journey.id}
													/>
													<DropdownMenuItem
														className="text-destructive"
														render={<button type="submit" />}
													>
														<Trans>Delete</Trans>
													</DropdownMenuItem>
												</fetcher.Form>
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
								</ItemActions>
							</Item>
						)
					})}
				</ItemGroup>
			)}
		</div>
	)
}
