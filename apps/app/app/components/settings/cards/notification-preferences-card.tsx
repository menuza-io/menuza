import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_NOTIFICATION_WORKFLOWS } from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon, type IconName } from '@repo/ui/icon'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import React, { useEffect, useId, useRef } from 'react'
import { useFetcher } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { RESERVATION_ALERT_WORKFLOWS } from '#app/utils/reservations/manager-alerts.ts'

const channelIcons: Record<string, IconName> = {
	email: 'mail',
	inApp: 'bell',
}

function getChannelLabel(channel: string, _: (msg: any) => string): string {
	const labels: Record<string, any> = {
		email: msg`Email`,
		inApp: msg`In-App`,
	}
	return _(labels[channel]) || channel
}

function getWorkflowLabel(
	workflowName: string,
	_: (msg: any) => string,
): string {
	const labels: Record<string, any> = {
		'comment-mention-workflow': msg`Notifications when you are mentioned in a comment`,
		'note-comment-workflow': msg`Notifications when someone comments on your notes`,
		'staffing-attendance-workflow': msg`Time clock: someone has not clocked in or forgot to clock out`,
		'staffing-overtime-workflow': msg`Time clock: someone is close to overtime or has reached it`,
		'staffing-schedule-workflow': msg`Schedule: a week was published`,
		'staffing-hiring-workflow': msg`Hiring: someone applied for a job`,
		'reservations.large_party_request': msg`Reservations: a large-party request is waiting`,
		'reservations.waitlist_remote_join': msg`Reservations: a guest joined the waitlist remotely`,
		'reservations.unassigned_conflict': msg`Reservations: a booking no longer has a table`,
		'reservations.payment_failed': msg`Reservations: a payment failed`,
		'reservations.payment_review': msg`Reservations: a payment needs a review`,
		'reservations.dispute_opened': msg`Reservations: a payment dispute was opened`,
		'reservations.message_failed_bulk': msg`Reservations: guest messages could not be delivered`,
	}
	return _(labels[workflowName]) || workflowName
}

function getChannelIcon(channel: string): IconName {
	return channelIcons[channel] ?? 'bell'
}

type Preference = {
	workflow: string
	email: boolean
	inApp: boolean
}

// Workflows configuration
const workflows = [
	{
		id: 'comment-mention-workflow',
		name: 'comment-mention-workflow',
		critical: false,
	},
	{
		id: 'note-comment-workflow',
		name: 'note-comment-workflow',
		critical: false,
	},
]

// Time clock alerts: only offered to members who can actually receive them
// (staffing time clock is on and they can read timesheets), so nobody sees a
// switch that does nothing.
const staffingWorkflows = STAFFING_NOTIFICATION_WORKFLOWS.filter(
	(id) =>
		id !== 'staffing-schedule-workflow' && id !== 'staffing-hiring-workflow',
).map((id) => ({
	id,
	name: id,
	critical: false,
}))
// Schedule alerts are offered on their own: scheduling is on and the member can
// read the schedule.
const scheduleWorkflows = [
	{
		id: 'staffing-schedule-workflow',
		name: 'staffing-schedule-workflow',
		critical: false,
	},
]

// Applicant alerts are offered where hiring is on and the member can read the
// applicants they open.
const hiringWorkflows = [
	{
		id: 'staffing-hiring-workflow',
		name: 'staffing-hiring-workflow',
		critical: false,
	},
]

// Reservations alerts are offered where the module is on and the member can read
// reservations or edit their settings, the members the alerts are sent to.
const reservationsWorkflows = RESERVATION_ALERT_WORKFLOWS.map((id) => ({
	id,
	name: id,
	critical: false,
}))

interface ChannelSwitchListProps {
	preference: Preference
	// Id of the workflow heading, so each switch is named "<channel> <workflow>".
	headingId: string
	isUpdating: boolean
	onUpdate: (workflow: string, channel: string, enabled: boolean) => void
	disabled: boolean
}

function ChannelSwitchList({
	preference,
	headingId,
	isUpdating,
	onUpdate,
	disabled,
}: ChannelSwitchListProps) {
	const { _ } = useLingui()
	const channels = ['email', 'inApp'] as const
	return (
		<div className="grid gap-1 sm:pl-4">
			{channels.map((channel) => (
				<div
					key={channel}
					className="flex items-center justify-between gap-3 py-2"
				>
					<div className="flex min-w-0 items-center gap-3">
						<Icon
							name={getChannelIcon(channel)}
							className="text-muted-foreground h-4 w-4 shrink-0"
						/>
						<span
							id={`${headingId}-${channel}`}
							className="text-sm font-medium"
						>
							{getChannelLabel(channel, _)}
						</span>
					</div>
					<Switch
						aria-labelledby={`${headingId}-${channel} ${headingId}`}
						checked={preference[channel]}
						onCheckedChange={(checked) =>
							onUpdate(preference.workflow, channel, checked)
						}
						disabled={disabled || isUpdating}
					/>
				</div>
			))}
		</div>
	)
}

function WorkflowPreferenceRow({
	organizationId,
	workflow,
	serverPref,
	isLast,
}: {
	organizationId: string
	workflow: (typeof workflows)[0]
	serverPref: Preference
	isLast: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const formRef = useRef<HTMLFormElement>(null)
	const headingId = useId()

	const isUpdating = fetcher.state !== 'idle'

	// Optimistic UI updates
	const pref = { ...serverPref }
	if (isUpdating && fetcher.formData) {
		const formChannel = fetcher.formData.get('channel') as 'email' | 'inApp'
		const formEnabled = fetcher.formData.get('enabled') === 'true'
		if (formChannel) {
			pref[formChannel] = formEnabled
		}
	}

	const updatePreference = (
		workflowId: string,
		channel: string,
		enabled: boolean,
	) => {
		const formData = new FormData(formRef.current!)
		formData.set('organizationId', organizationId)
		formData.set('workflow', workflowId)
		formData.set('channel', channel)
		formData.set('enabled', String(enabled))

		void fetcher.submit(formData, {
			method: 'POST',
			action: '/api/notifications/preferences',
		})
	}

	return (
		<div className="space-y-2">
			<form ref={formRef} className="hidden">
				<HoneypotInputs />
			</form>
			<div className="flex flex-wrap items-center gap-2">
				<Icon name="cog" className="h-4 w-4 shrink-0" />
				<h3 id={headingId} className="text-base font-medium">
					{getWorkflowLabel(workflow.name, _)}
				</h3>
				{workflow.critical && (
					<Badge variant="destructive" className="text-xs">
						<Trans>Critical</Trans>
					</Badge>
				)}
			</div>
			<ChannelSwitchList
				preference={pref}
				headingId={headingId}
				isUpdating={isUpdating}
				onUpdate={updatePreference}
				disabled={workflow.critical}
			/>
			{!isLast && <Separator />}
		</div>
	)
}

export function NotificationPreferencesCard({
	organizationId,
	showStaffingAlerts = false,
	showScheduleAlerts = false,
	showHiringAlerts = false,
	showReservationsAlerts = false,
}: {
	organizationId: string
	showStaffingAlerts?: boolean
	showScheduleAlerts?: boolean
	showHiringAlerts?: boolean
	showReservationsAlerts?: boolean
}) {
	const fetcher = useFetcher<{ preferences: Preference[] }>()

	useEffect(() => {
		if (fetcher.state === 'idle' && !fetcher.data) {
			void fetcher.load(
				`/api/notifications/preferences?organizationId=${organizationId}`,
			)
		}
	}, [fetcher, organizationId])

	const preferences = fetcher.data?.preferences || []
	const visibleWorkflows = [
		...workflows,
		...(showStaffingAlerts ? staffingWorkflows : []),
		...(showScheduleAlerts ? scheduleWorkflows : []),
		...(showHiringAlerts ? hiringWorkflows : []),
		...(showReservationsAlerts ? reservationsWorkflows : []),
	]

	const getPreference = (workflowId: string): Preference => {
		const pref = preferences.find((p) => p.workflow === workflowId)
		return pref || { workflow: workflowId, email: true, inApp: true }
	}

	return (
		<Card className="w-full">
			<CardHeader>
				<CardTitle>
					<Trans>Notification Preferences</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Manage your notification settings for different channels and
						workflows.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{visibleWorkflows.map((workflow, index) => {
					const serverPref = getPreference(workflow.id)

					return (
						<WorkflowPreferenceRow
							key={workflow.id}
							organizationId={organizationId}
							workflow={workflow}
							serverPref={serverPref}
							isLast={index === visibleWorkflows.length - 1}
						/>
					)
				})}
			</CardContent>
		</Card>
	)
}
