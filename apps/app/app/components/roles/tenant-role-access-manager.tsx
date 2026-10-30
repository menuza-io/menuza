import { Trans, t } from '@lingui/macro'
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
import { Button, buttonVariants } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useRef, useState } from 'react'
import { Form, Link, useFetcher, useNavigation } from 'react-router'
import { useNativeFormSaveBar } from '#app/components/use-native-form-save-bar.ts'
import { useRoleLabels } from '#app/utils/organization/role-label.ts'
import {
	IMPLIED_PERMISSION_IDS,
	withImpliedTenantRolePermissions,
} from '#app/utils/organization/tenant-role-permissions.ts'

export type TenantRole = {
	id: string
	name: string
	description: string
	isBuiltIn: boolean
	permissionIds: string[]
	memberCount: number
}

type PermissionOption = {
	id: string
	label: string
	description: string
	warning?: string
}

export type PermissionGroup = {
	title: string
	description: string
	permissions: PermissionOption[]
	/** Staff module group: shown only when the organization has Staff turned on. */
	staffing?: boolean
	/** Reservations module group: shown only when the organization has Reservations turned on. */
	reservations?: boolean
	/** Loyalty module group: shown only when the organization has Loyalty turned on. */
	loyalty?: boolean
}

export function getPermissionGroups(): PermissionGroup[] {
	return [
		{
			title: t`Notes & Documents`,
			description: t`Access to personal and shared team notes.`,
			permissions: [
				{
					id: 'org_perm_create_note_own',
					label: t`Create notes`,
					description: t`Draft and create new notes in the organization.`,
				},
				{
					id: 'org_perm_read_note_own',
					label: t`View own notes`,
					description: t`Open and view notes created by this user.`,
				},
				{
					id: 'org_perm_read_note_org',
					label: t`View team notes`,
					description: t`Open and view notes created by any organization teammate.`,
				},
				{
					id: 'org_perm_update_note_own',
					label: t`Edit own notes`,
					description: t`Make modifications to notes created by this user.`,
				},
				{
					id: 'org_perm_update_note_org',
					label: t`Edit team notes`,
					description: t`Modify notes created by other team members.`,
					warning: t`Can edit teammate notes`,
				},
				{
					id: 'org_perm_delete_note_own',
					label: t`Delete own notes`,
					description: t`Permanently delete notes created by this user.`,
				},
				{
					id: 'org_perm_delete_note_org',
					label: t`Delete team notes`,
					description: t`Permanently delete notes created by any teammate.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Team & Members`,
			description: t`Collaborator visibility and access control.`,
			permissions: [
				{
					id: 'org_perm_read_member_any',
					label: t`View team members`,
					description: t`See teammate names, emails, and assigned roles.`,
				},
				{
					id: 'org_perm_create_member_any',
					label: t`Invite new members`,
					description: t`Send invitations to join the organization workspace.`,
				},
				{
					id: 'org_perm_delete_member_any',
					label: t`Remove team members`,
					description: t`Revoke workspace access and remove non-admin members.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Organization Settings`,
			description: t`Organization details and configuration.`,
			permissions: [
				{
					id: 'org_perm_read_settings_any',
					label: t`View organization settings`,
					description: t`Read organization details, verified domain, and storage status.`,
				},
				{
					id: 'org_perm_update_settings_any',
					label: t`Modify organization settings`,
					description: t`Update organization name, slug, and general preferences.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Website & Publishing`,
			description: t`Website editor, announcements, and public pages.`,
			permissions: [
				{
					id: 'org_perm_read_website_any',
					label: t`View website workspace`,
					description: t`Open pages, forms, and themes in the site builder.`,
				},
				{
					id: 'org_perm_update_website_any',
					label: t`Edit website content`,
					description: t`Create, update, and publish web pages, forms, and redirects.`,
					warning: t`High impact`,
				},
				{
					id: 'org_perm_read_announcement_any',
					label: t`View announcements`,
					description: t`Read the announcement banners shown on the public site.`,
				},
				{
					id: 'org_perm_update_announcement_any',
					label: t`Manage announcements`,
					description: t`Create, edit, enable, and delete announcement banners.`,
					warning: t`Appears on the public site`,
				},
			],
		},
		{
			title: t`Marketing`,
			description: t`One-time broadcasts and automated journeys.`,
			permissions: [
				{
					id: 'org_perm_read_campaign_any',
					label: t`View broadcasts`,
					description: t`See one-time email and SMS campaign history.`,
				},
				{
					id: 'org_perm_update_campaign_any',
					label: t`Manage broadcasts`,
					description: t`Create and send one-time email and SMS campaigns.`,
					warning: t`Sends to customers`,
				},
				{
					id: 'org_perm_read_automation_any',
					label: t`View automations`,
					description: t`See automated journeys and their run history.`,
				},
				{
					id: 'org_perm_update_automation_any',
					label: t`Manage automations`,
					description: t`Create, edit, publish, pause, and delete automated journeys.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`AI phone agent`,
			description: t`The assistant that answers restaurant calls.`,
			permissions: [
				{
					id: 'org_perm_read_phone_agent_any',
					label: t`View phone agent`,
					description: t`See the agent's settings, call flow, numbers, and training rules.`,
				},
				{
					id: 'org_perm_update_phone_agent_any',
					label: t`Manage phone agent`,
					description: t`Change settings, publish call flows, manage numbers, and edit training rules.`,
					warning: t`Talks to customers`,
				},
				{
					id: 'org_perm_read_phone_call_any',
					label: t`View calls`,
					description: t`See call history, caller numbers, transcripts, and recordings.`,
					warning: t`Customer personal data`,
				},
				{
					id: 'org_perm_update_phone_call_any',
					label: t`Follow up on calls`,
					description: t`Complete and reopen calls and requests, and tag calls. Needs View calls.`,
				},
				{
					id: 'org_perm_delete_phone_call_any',
					label: t`Delete calls`,
					description: t`Permanently delete calls, transcripts, and recordings. Needs View calls.`,
					warning: t`Cannot be undone`,
				},
			],
		},
		{
			title: t`Team chat`,
			description: t`Internal channels for your team.`,
			permissions: [
				{
					id: 'org_perm_update_chat_any',
					label: t`Manage chat channels`,
					description: t`Create, edit, and delete channels, choose which roles and members can access them, and remove messages in channels they can open. Does not grant access to restricted channels.`,
					warning: t`High impact`,
				},
				{
					id: 'org_perm_create_chat_group',
					label: t`Create group chats`,
					description: t`Start group conversations and add teammates.`,
				},
			],
		},
		{
			title: t`Staff`,
			staffing: true,
			description: t`The people who work here: roster, pay, and private details. Only applies when Staff is turned on for your organization.`,
			permissions: [
				{
					id: 'org_perm_read_staff_any',
					label: t`View staff`,
					description: t`See the staff roster, profiles, and positions. Does not include pay or private details.`,
				},
				{
					id: 'org_perm_update_staff_any',
					label: t`Manage staff`,
					description: t`Add and edit staff, reset time clock PINs, and terminate or rehire people. Includes View staff.`,
					warning: t`High impact`,
				},
				{
					id: 'org_perm_read_staff_pay_any',
					label: t`View pay rates`,
					description: t`See individual pay rates and wage history.`,
					warning: t`Sensitive pay data`,
				},
				{
					id: 'org_perm_update_staff_pay_any',
					label: t`Change pay rates`,
					description: t`Change individual pay rates and salary details. Includes View pay rates.`,
					warning: t`Sensitive pay data`,
				},
				{
					id: 'org_perm_read_staff_private_any',
					label: t`View private details`,
					description: t`See dates of birth, home addresses, and emergency contacts.`,
					warning: t`Personal data`,
				},
				{
					id: 'org_perm_update_staff_private_any',
					label: t`Edit private details`,
					description: t`Edit dates of birth, home addresses, and emergency contacts. Includes View private details.`,
					warning: t`Personal data`,
				},
			],
		},
		{
			title: t`Schedule & time clock`,
			staffing: true,
			description: t`Shifts, time cards, and labor cost. Only applies when the matching Staff features are turned on.`,
			permissions: [
				{
					id: 'org_perm_read_schedule_any',
					label: t`View team schedule`,
					description: t`See everyone's shifts, availability, and time-off requests.`,
				},
				{
					id: 'org_perm_update_schedule_any',
					label: t`Manage schedule`,
					description: t`Create, edit, and publish shifts, and decide availability and time-off requests. Includes View team schedule.`,
				},
				{
					id: 'org_perm_read_schedule_own',
					label: t`View own shifts`,
					description: t`See your own published shifts. Only useful for people who also work shifts.`,
				},
				{
					id: 'org_perm_create_timeclock_own',
					label: t`Use own time clock`,
					description: t`Clock yourself in and out. Only useful for people who also work shifts.`,
				},
				{
					id: 'org_perm_read_timesheet_any',
					label: t`View time cards`,
					description: t`See everyone's time cards and hours.`,
				},
				{
					id: 'org_perm_update_timesheet_any',
					label: t`Edit time cards`,
					description: t`Add and edit time cards and export hours. Includes View time cards.`,
					warning: t`Affects pay`,
				},
				{
					id: 'org_perm_approve_timesheet_any',
					label: t`Approve time cards`,
					description: t`Approve, lock, and unlock time cards. Includes View time cards.`,
					warning: t`Affects pay`,
				},
				{
					id: 'org_perm_read_labor_any',
					label: t`View labor cost`,
					description: t`See labor cost and labor percentage.`,
					warning: t`Sensitive pay data`,
				},
				{
					id: 'org_perm_read_labor_policy_any',
					label: t`View labor policy`,
					description: t`See labor rules, time clock devices, and pay periods.`,
				},
				{
					id: 'org_perm_update_labor_policy_any',
					label: t`Manage labor policy`,
					description: t`Change labor rules, pair time clock devices, and set pay periods. Includes View labor policy.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Hiring`,
			staffing: true,
			description: t`Job posts and applicants. Only applies when Hiring is turned on for your organization.`,
			permissions: [
				{
					id: 'org_perm_read_hiring_any',
					label: t`View hiring`,
					description: t`See job posts and applicants.`,
					warning: t`Applicant personal data`,
				},
				{
					id: 'org_perm_update_hiring_any',
					label: t`Manage hiring`,
					description: t`Manage job posts, move applicants between stages, and hire. Includes View hiring.`,
					warning: t`Applicant personal data`,
				},
			],
		},
		{
			title: t`Reservations`,
			reservations: true,
			description: t`Reservation book, waitlist, guestbook, dining room setup, experiences, reports, and reservation payments. Only applies when Reservations is turned on for your organization.`,
			permissions: [
				{
					id: 'org_perm_read_reservation_any',
					label: t`View reservation book & waitlist`,
					description: t`See the reservation book, timeline, floor plan, calendar, overview, and waitlist.`,
				},
				{
					id: 'org_perm_update_reservation_any',
					label: t`Manage reservation book & waitlist`,
					description: t`Create, edit, seat, and manage reservations, walk-ins, waitlist entries, service notes, and section assignments. Includes View reservation book & waitlist.`,
				},
				{
					id: 'org_perm_read_reservation_settings_any',
					label: t`View reservation settings & experiences`,
					description: t`See dining areas, tables, combinations, services, pacing, blocks, policies, messages, sections, and experiences.`,
				},
				{
					id: 'org_perm_update_reservation_settings_any',
					label: t`Manage reservation settings & experiences`,
					description: t`Edit dining areas, tables, combinations, services, pacing, blocks, policies, messages, sections, and experiences. Includes View reservation settings & experiences.`,
					warning: t`High impact`,
				},
				{
					id: 'org_perm_read_reservation_guest_any',
					label: t`View guestbook`,
					description: t`See guestbook profiles, visit history, notes, and exports.`,
					warning: t`Guest personal data`,
				},
				{
					id: 'org_perm_update_reservation_guest_any',
					label: t`Manage guestbook`,
					description: t`Edit guestbook profiles, tags, notes, and merge or erase guests. Includes View guestbook.`,
					warning: t`Guest personal data`,
				},
				{
					id: 'org_perm_read_reservation_report_any',
					label: t`View reservation reports`,
					description: t`See covers, pacing, no-show, waitlist, channel, deposit, and section reports.`,
				},
				{
					id: 'org_perm_update_reservation_payment_any',
					label: t`Charge fees & refund reservation payments`,
					description: t`Charge cancellation or no-show fees and issue reservation refunds. Includes View reservation book & waitlist and View reservation reports.`,
					warning: t`Charges & refunds`,
				},
			],
		},
		{
			title: t`Loyalty`,
			loyalty: true,
			description: t`Loyalty program, members and points, redemptions waiting for review, and loyalty reports. Only applies when Loyalty is turned on for your organization.`,
			permissions: [
				{
					id: 'org_perm_read_loyalty_any',
					label: t`View loyalty members`,
					description: t`See loyalty members, balances, point activity, and redemptions.`,
				},
				{
					id: 'org_perm_update_loyalty_program_any',
					label: t`Manage loyalty program`,
					description: t`Edit the loyalty program and its rewards. Includes View loyalty members.`,
					warning: t`Changes what customers earn`,
				},
				{
					id: 'org_perm_update_loyalty_points_any',
					label: t`Adjust loyalty points`,
					description: t`Adjust member points with a recorded reason. Includes View loyalty members.`,
					warning: t`Moves customer points`,
				},
				{
					id: 'org_perm_update_loyalty_redemption_any',
					label: t`Resolve loyalty reviews & refunds`,
					description: t`Resolve redemptions and purchases waiting for review, record loyalty refunds, and repair balances. Includes View loyalty members.`,
					warning: t`Moves customer points`,
				},
				{
					id: 'org_perm_read_loyalty_report_any',
					label: t`View loyalty reports`,
					description: t`See loyalty reports and analytics.`,
				},
			],
		},
	]
}

export type RolePreset = {
	name: string
	description: string
	permissionIds: string[]
	/** Staff module template: offered only when Staff is turned on. */
	staffing?: boolean
	/** Reservations module template: offered only when Reservations is turned on. */
	reservations?: boolean
}

export function getPresets(): RolePreset[] {
	return [
		{
			name: t`Content editor`,
			description: t`Notes & website`,
			permissionIds: [
				'org_perm_create_note_own',
				'org_perm_read_note_own',
				'org_perm_read_note_org',
				'org_perm_update_note_own',
				'org_perm_update_website_any',
				'org_perm_read_website_any',
				'org_perm_read_announcement_any',
				'org_perm_update_announcement_any',
			],
		},
		{
			name: t`Marketing manager`,
			description: t`Broadcasts & automations`,
			permissionIds: [
				'org_perm_read_campaign_any',
				'org_perm_update_campaign_any',
				'org_perm_read_automation_any',
				'org_perm_update_automation_any',
			],
		},
		{
			name: t`Team manager`,
			description: t`Members & invites`,
			permissionIds: [
				'org_perm_read_member_any',
				'org_perm_create_member_any',
				'org_perm_delete_member_any',
				'org_perm_read_note_org',
			],
		},
		{
			name: t`Shift manager`,
			staffing: true,
			description: t`Schedule & time cards`,
			permissionIds: [
				'org_perm_read_staff_any',
				'org_perm_read_schedule_any',
				'org_perm_update_schedule_any',
				'org_perm_read_timesheet_any',
				'org_perm_update_timesheet_any',
			],
		},
		{
			name: t`General manager`,
			staffing: true,
			description: t`Staff, pay & labor`,
			permissionIds: [
				'org_perm_read_staff_any',
				'org_perm_update_staff_any',
				'org_perm_read_staff_pay_any',
				'org_perm_update_staff_pay_any',
				'org_perm_read_schedule_any',
				'org_perm_update_schedule_any',
				'org_perm_read_timesheet_any',
				'org_perm_update_timesheet_any',
				'org_perm_approve_timesheet_any',
				'org_perm_read_labor_any',
				'org_perm_read_labor_policy_any',
				'org_perm_read_hiring_any',
				'org_perm_update_hiring_any',
			],
		},
		{
			name: t`Hiring manager`,
			staffing: true,
			description: t`Job posts & applicants`,
			permissionIds: [
				'org_perm_read_staff_any',
				'org_perm_read_hiring_any',
				'org_perm_update_hiring_any',
			],
		},
		{
			name: t`Host`,
			reservations: true,
			description: t`Book, waitlist & table status`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_update_reservation_any',
			],
		},
		{
			name: t`Shift manager`,
			reservations: true,
			description: t`Book, guestbook & reports`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_update_reservation_any',
				'org_perm_read_reservation_guest_any',
				'org_perm_read_reservation_report_any',
			],
		},
		{
			name: t`Reservations manager`,
			reservations: true,
			description: t`Setup, book, guestbook & reports`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_update_reservation_any',
				'org_perm_read_reservation_settings_any',
				'org_perm_update_reservation_settings_any',
				'org_perm_read_reservation_guest_any',
				'org_perm_update_reservation_guest_any',
				'org_perm_read_reservation_report_any',
			],
		},
		{
			name: t`Guest relations`,
			reservations: true,
			description: t`Guestbook profiles & merges`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_read_reservation_guest_any',
				'org_perm_update_reservation_guest_any',
			],
		},
		{
			name: t`Guestbook manager`,
			reservations: true,
			description: t`Guestbook profiles & merges`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_read_reservation_guest_any',
				'org_perm_update_reservation_guest_any',
			],
		},
		{
			name: t`Finance`,
			reservations: true,
			description: t`Deposit reports, charges & refunds`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_read_reservation_report_any',
				'org_perm_update_reservation_payment_any',
			],
		},
		{
			name: t`Owner`,
			reservations: true,
			description: t`All reservations, guestbook, setup & payments`,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_update_reservation_any',
				'org_perm_read_reservation_settings_any',
				'org_perm_update_reservation_settings_any',
				'org_perm_read_reservation_guest_any',
				'org_perm_update_reservation_guest_any',
				'org_perm_read_reservation_report_any',
				'org_perm_update_reservation_payment_any',
			],
		},
		{
			name: t`Viewer`,
			description: t`Read-only`,
			permissionIds: [
				'org_perm_read_note_org',
				'org_perm_read_member_any',
				'org_perm_read_website_any',
				'org_perm_read_announcement_any',
				'org_perm_read_campaign_any',
				'org_perm_read_automation_any',
			],
		},
		{
			name: t`Blank`,
			description: t`Zero permissions`,
			permissionIds: [],
		},
	]
}

export function RoleAccessForm({
	role,
	cancelHref,
	errors,
	staffingEnabled = false,
	reservationsEnabled = false,
	loyaltyEnabled = false,
}: {
	role?: TenantRole
	cancelHref: string
	/** The action's errors: `nameError` under Role name, `error` above the form. */
	errors?: { error?: string; nameError?: string }
	orgSlug?: string
	/** Whether the Staff module is turned on for this organization. */
	staffingEnabled?: boolean
	/** Whether the Reservations module is turned on for this organization. */
	reservationsEnabled?: boolean
	/** Whether Loyalty is turned on for this organization. */
	loyaltyEnabled?: boolean
}) {
	const navigation = useNavigation()
	// Editing saves through a fetcher so the save bar's redirect to the list is
	// not held back by its own leave guard; creating keeps a plain submit.
	const fetcher = useFetcher<{ error?: string; nameError?: string }>()
	const isSubmitting = role
		? fetcher.state !== 'idle'
		: navigation.state === 'submitting'
	const RoleForm = role ? fetcher.Form : Form
	const formRef = useRef<HTMLFormElement>(null)
	// An edit's errors come back on the fetcher, a create's as action data.
	const actionErrors = role ? (fetcher.data ?? errors) : errors
	const error = actionErrors?.error
	const nameError = actionErrors?.nameError
	const errorRef = useRef<HTMLDivElement>(null)
	const nameRef = useRef<HTMLInputElement>(null)
	// The Create role button sits in the footer, far below both messages, so
	// each failed submit moves focus to the message (or the field it is about).
	// Focus also makes screen readers read it, so the message has no alert role
	// (that would read it twice). The action data is a new object on every
	// submit, so a repeated identical error still moves focus.
	useEffect(() => {
		if (actionErrors?.nameError) nameRef.current?.focus()
		else if (actionErrors?.error) errorRef.current?.focus()
	}, [actionErrors])
	const permissionGroups = getPermissionGroups().filter(
		(group) =>
			(staffingEnabled || !group.staffing) &&
			(reservationsEnabled || !group.reservations) &&
			(loyaltyEnabled || !group.loyalty),
	)
	const rawPresets = getPresets().filter(
		(preset) =>
			(staffingEnabled || !preset.staffing) &&
			(reservationsEnabled || !preset.reservations),
	)
	// When both Staffing and Reservations are enabled, both define a "Shift manager"
	// template; merge any templates sharing a name so template buttons stay unique.
	const presets: RolePreset[] = []
	for (const preset of rawPresets) {
		const existing = presets.find((p) => p.name === preset.name)
		if (existing) {
			existing.permissionIds = [
				...new Set([...existing.permissionIds, ...preset.permissionIds]),
			]
		} else {
			presets.push({ ...preset })
		}
	}

	// Module grants a role already holds stay on it while those module groups are
	// hidden, so saving a role with a module off never silently strips them.
	const hiddenModuleIds = new Set(
		getPermissionGroups()
			.filter(
				(group) =>
					(group.staffing && !staffingEnabled) ||
					(group.reservations && !reservationsEnabled) ||
					(group.loyalty && !loyaltyEnabled),
			)
			.flatMap((group) => group.permissions.map((p) => p.id)),
	)

	const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>(
		role ? role.permissionIds : (presets[0]?.permissionIds ?? []),
	)
	const [activePreset, setActivePreset] = useState<string | null>(
		role ? null : (presets[0]?.name ?? null),
	)

	useNativeFormSaveBar(formRef, isSubmitting, {
		enabled: Boolean(role),
		extraDirty:
			role !== undefined &&
			[...selectedPermissionIds].sort().join() !==
				[...role.permissionIds].sort().join(),
		onDiscard: () => {
			if (!role) return
			setActivePreset(null)
			setSelectedPermissionIds(role.permissionIds)
		},
	})

	const togglePermission = (id: string, checked: boolean) => {
		setActivePreset(null)
		setSelectedPermissionIds((prev) => {
			if (checked) return withImpliedTenantRolePermissions([...prev, id])
			// Clearing a read grant also clears the update/approve grants that
			// depend on it, so the saved role never holds an orphaned write.
			const dependents = Object.entries(IMPLIED_PERMISSION_IDS)
				.filter(([, implied]) => implied.includes(id))
				.map(([dependent]) => dependent)
			return prev.filter((p) => p !== id && !dependents.includes(p))
		})
	}

	const applyPreset = (preset: (typeof presets)[number]) => {
		setActivePreset(preset.name)
		setSelectedPermissionIds(preset.permissionIds)
	}

	return (
		<div className="space-y-6">
			{error && (
				<div
					ref={errorRef}
					tabIndex={-1}
					className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
				>
					{error}
				</div>
			)}

			<RoleForm
				ref={formRef}
				method="POST"
				id="role-access-form"
				className="space-y-6"
			>
				{/* Role Details Frame */}
				<Frame className="w-full">
					<FrameHeader>
						<FrameTitle className="text-base">
							{role ? (
								<Trans>Edit Custom Role</Trans>
							) : (
								<Trans>Create Custom Role</Trans>
							)}
						</FrameTitle>
						<FrameDescription>
							{role
								? t`Update this role’s name, description, and permissions.`
								: t`Define role details and select what permissions members receive.`}
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="space-y-6">
						<div className="grid gap-5 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="role-name" className="text-sm font-medium">
									<Trans>Role name</Trans>{' '}
									<span className="text-destructive">*</span>
								</Label>
								<Input
									ref={nameRef}
									id="role-name"
									name="name"
									defaultValue={role?.name}
									required
									maxLength={80}
									placeholder="e.g. Content Editor"
									disabled={isSubmitting}
									aria-invalid={nameError ? true : undefined}
									aria-describedby={nameError ? 'role-name-error' : undefined}
									className="h-10 text-sm"
								/>
								{nameError ? (
									<p id="role-name-error" className="text-destructive text-sm">
										{nameError}
									</p>
								) : null}
							</div>
							<div className="space-y-2">
								<Label
									htmlFor="role-description"
									className="text-sm font-medium"
								>
									<Trans>Description</Trans>
								</Label>
								<Input
									id="role-description"
									name="description"
									defaultValue={role?.description}
									maxLength={280}
									placeholder="e.g. Can edit content but cannot change settings."
									disabled={isSubmitting}
									className="h-10 text-sm"
								/>
							</div>
						</div>

						{!role && (
							<div className="border-border/60 space-y-3 border-t pt-4">
								<Label className="text-foreground block text-sm font-medium">
									<Trans>Start from a template</Trans>
								</Label>
								<div className="flex flex-wrap gap-2.5">
									{presets.map((preset) => {
										const isSelected = activePreset === preset.name
										return (
											<button
												key={preset.name}
												type="button"
												onClick={() => applyPreset(preset)}
												disabled={isSubmitting}
												aria-pressed={isSelected}
												className={cn(
													'rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-all',
													isSelected
														? 'bg-primary text-primary-foreground border-primary shadow-xs'
														: 'bg-card text-muted-foreground border-border hover:text-foreground hover:bg-muted/40',
												)}
											>
												{preset.name}
											</button>
										)
									})}
								</div>
							</div>
						)}
					</FramePanel>
				</Frame>

				{/* Framed Tables for Each Permission Group */}
				<div className="space-y-6">
					{permissionGroups.map((group) => {
						const groupPermissionIds = group.permissions.map((p) => p.id)
						const selectedInGroup = group.permissions.filter((p) =>
							selectedPermissionIds.includes(p.id),
						).length
						const allGroupSelected =
							selectedInGroup === group.permissions.length

						const toggleGroup = () => {
							setActivePreset(null)
							if (allGroupSelected) {
								setSelectedPermissionIds((prev) =>
									prev.filter((id) => !groupPermissionIds.includes(id)),
								)
							} else {
								setSelectedPermissionIds((prev) =>
									withImpliedTenantRolePermissions([
										...prev,
										...groupPermissionIds,
									]),
								)
							}
						}

						return (
							<Frame key={group.title} className="w-full">
								<FrameHeader>
									<div className="flex items-center gap-2">
										<FrameTitle className="text-base">{group.title}</FrameTitle>
										<Badge variant="outline" className="text-xs font-normal">
											{selectedInGroup} of {group.permissions.length} selected
										</Badge>
									</div>
									<FrameDescription>{group.description}</FrameDescription>
									<FrameAction>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={toggleGroup}
											disabled={isSubmitting}
											className="text-muted-foreground hover:text-foreground text-xs font-medium"
										>
											{allGroupSelected ? (
												<Trans>Deselect all</Trans>
											) : (
												<Trans>Select all</Trans>
											)}
										</Button>
									</FrameAction>
								</FrameHeader>

								<Table variant="card">
									<TableHeader>
										<TableRow>
											<TableHead className="w-12 text-center">
												<Checkbox
													checked={allGroupSelected}
													indeterminate={
														selectedInGroup > 0 && !allGroupSelected
													}
													onCheckedChange={toggleGroup}
													disabled={isSubmitting}
													aria-label={`Select all ${group.title}`}
												/>
											</TableHead>
											<TableHead className="w-1/3">
												<Trans>Permission</Trans>
											</TableHead>
											<TableHead>
												<Trans>Description</Trans>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.permissions.map((permission) => {
											const id = `permission-${permission.id}`
											const isChecked = selectedPermissionIds.includes(
												permission.id,
											)

											return (
												<TableRow
													key={permission.id}
													className="hover:bg-muted/30 cursor-pointer transition-colors"
													onClick={() =>
														togglePermission(permission.id, !isChecked)
													}
												>
													<TableCell
														className="pt-4 text-center align-top"
														onClick={(e) => e.stopPropagation()}
													>
														<Checkbox
															id={id}
															aria-label={permission.label}
															checked={isChecked}
															onCheckedChange={(checked) =>
																togglePermission(
																	permission.id,
																	checked === true,
																)
															}
															disabled={isSubmitting}
														/>
														{isChecked ? (
															<input
																type="hidden"
																name="permissionIds"
																value={permission.id}
															/>
														) : null}
													</TableCell>
													<TableCell className="text-foreground pt-3.5 align-top font-medium">
														<div className="flex flex-wrap items-center gap-2">
															<span className="text-sm font-medium">
																{permission.label}
															</span>
															{permission.warning && (
																<span className="text-xs font-normal text-amber-600 dark:text-amber-400">
																	· {permission.warning}
																</span>
															)}
														</div>
													</TableCell>
													<TableCell className="text-muted-foreground pt-3.5 align-top text-sm leading-relaxed">
														{permission.description}
													</TableCell>
												</TableRow>
											)
										})}
									</TableBody>
								</Table>
							</Frame>
						)
					})}
				</div>

				{selectedPermissionIds
					.filter((id) => hiddenModuleIds.has(id))
					.map((id) => (
						<input key={id} type="hidden" name="permissionIds" value={id} />
					))}

				{/* Sticky/Bottom Actions Frame */}
				<Frame className="w-full">
					<FrameFooter className="flex flex-row items-center justify-between p-4">
						<span className="text-muted-foreground text-sm">
							<strong className="text-foreground">
								{selectedPermissionIds.length}
							</strong>{' '}
							<Trans>permissions selected</Trans>
						</span>
						<div className="flex items-center gap-3">
							<Button
								variant="outline"
								render={<Link to={cancelHref} />}
								disabled={isSubmitting}
							>
								<Trans>Cancel</Trans>
							</Button>
							{role ? null : (
								<Button type="submit" disabled={isSubmitting}>
									{isSubmitting ? (
										<Trans>Saving…</Trans>
									) : (
										<Trans>Create role</Trans>
									)}
								</Button>
							)}
						</div>
					</FrameFooter>
				</Frame>
			</RoleForm>
		</div>
	)
}

export function ReadOnlyRoleView({
	role,
	editHref,
	staffingEnabled = false,
	reservationsEnabled = false,
	loyaltyEnabled = false,
}: {
	role: TenantRole
	editHref?: string
	orgSlug?: string
	/** Whether the Staff module is turned on for this organization. */
	staffingEnabled?: boolean
	/** Whether the Reservations module is turned on for this organization. */
	reservationsEnabled?: boolean
	/** Whether Loyalty is turned on for this organization. */
	loyaltyEnabled?: boolean
}) {
	const { roleName, roleDescription } = useRoleLabels()
	const permissionGroups = getPermissionGroups().filter(
		(group) =>
			(staffingEnabled || !group.staffing) &&
			(reservationsEnabled || !group.reservations) &&
			(loyaltyEnabled || !group.loyalty),
	)
	const visibleIds = new Set(
		permissionGroups.flatMap((group) => group.permissions.map((p) => p.id)),
	)
	const grantedCount = role.permissionIds.filter((id) =>
		visibleIds.has(id),
	).length
	const totalCount = permissionGroups.reduce(
		(sum, g) => sum + g.permissions.length,
		0,
	)

	return (
		<div className="space-y-6" aria-label="Role permissions overview">
			{/* Role Overview Frame */}
			<Frame className="w-full">
				<FrameHeader>
					<div className="flex items-center gap-2.5">
						<FrameTitle className="text-lg">{roleName(role)}</FrameTitle>
						<Badge variant="secondary" className="text-xs font-normal">
							{role.isBuiltIn ? <Trans>Built-in</Trans> : <Trans>Custom</Trans>}
						</Badge>
					</div>
					<FrameDescription>
						{roleDescription(role) || (
							<span className="italic">
								<Trans>Standard system role.</Trans>
							</span>
						)}{' '}
						· {role.memberCount}{' '}
						{role.memberCount === 1 ? t`member` : t`members`} · {grantedCount}{' '}
						of {totalCount} <Trans>permissions granted</Trans>
					</FrameDescription>
					{editHref && (
						<FrameAction>
							<Button
								variant="outline"
								size="sm"
								render={<Link to={editHref} />}
							>
								<Trans>Edit role</Trans>
							</Button>
						</FrameAction>
					)}
				</FrameHeader>
			</Frame>

			{/* Framed Tables for Each Permission Group */}
			<div className="space-y-6">
				{permissionGroups.map((group) => {
					const allowedInGroup = group.permissions.filter((p) =>
						role.permissionIds.includes(p.id),
					).length

					return (
						<Frame key={group.title} className="w-full">
							<FrameHeader>
								<div className="flex items-center gap-2">
									<FrameTitle className="text-base">{group.title}</FrameTitle>
									<Badge variant="outline" className="text-xs font-normal">
										{allowedInGroup} of {group.permissions.length} allowed
									</Badge>
								</div>
								<FrameDescription>{group.description}</FrameDescription>
							</FrameHeader>

							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead className="w-1/3">
											<Trans>Permission</Trans>
										</TableHead>
										<TableHead className="w-1/2">
											<Trans>Description</Trans>
										</TableHead>
										<TableHead className="w-1/6 text-right">
											<Trans>Status</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{group.permissions.map((permission) => {
										const isAllowed = role.permissionIds.includes(permission.id)

										return (
											<TableRow key={permission.id}>
												<TableCell className="text-foreground pt-3.5 align-top font-medium">
													<div className="flex flex-wrap items-center gap-2">
														<span className="text-sm font-medium">
															{permission.label}
														</span>
														{isAllowed && permission.warning && (
															<span className="text-xs font-normal text-amber-600 dark:text-amber-400">
																· {permission.warning}
															</span>
														)}
													</div>
												</TableCell>
												<TableCell className="text-muted-foreground pt-3.5 align-top text-sm leading-relaxed">
													{permission.description}
												</TableCell>
												<TableCell className="pt-3.5 text-right align-top">
													{isAllowed ? (
														<Badge
															variant="outline"
															className="border-emerald-500/30 bg-emerald-500/10 text-xs font-medium text-emerald-700 dark:text-emerald-400"
														>
															<Trans>Allowed</Trans>
														</Badge>
													) : (
														<span className="text-muted-foreground text-xs">
															<Trans>Not allowed</Trans>
														</span>
													)}
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						</Frame>
					)
				})}
			</div>
		</div>
	)
}

export type StaffingRolePresetOption = {
	key: string
	name: string
	description: string
	/** A role with this name already exists in the organization. */
	exists: boolean
}

export type ReservationsRolePresetOption = {
	key: string
	name: string
	description: string
	/** A role with this name already exists in the organization. */
	exists: boolean
}

export function TenantRoleAccessManager({
	roles,
	orgSlug,
	message,
	error,
	staffingPresets,
	reservationsPresets,
}: {
	roles: TenantRole[]
	orgSlug: string
	message?: string
	error?: string
	/** Present only while the Staff module is on for the organization. */
	staffingPresets?: StaffingRolePresetOption[]
	/** Present only while the Reservations module is on for the organization. */
	reservationsPresets?: ReservationsRolePresetOption[]
}) {
	const { roleName, roleDescription } = useRoleLabels()
	const navigation = useNavigation()
	const [roleToDelete, setRoleToDelete] = useState<TenantRole | null>(null)

	const isDeleting =
		navigation.state === 'submitting' &&
		navigation.formData?.get('intent') === 'delete-role'

	const customRoles = roles.filter((role) => !role.isBuiltIn)
	const builtInRoles = roles.filter((role) => role.isBuiltIn)
	const basePath = `/${orgSlug}/settings/roles`
	const roleNameToDelete = roleToDelete?.name ?? ''

	return (
		<div className="space-y-8">
			{/* Notifications */}
			{message && (
				<div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
					{message}
				</div>
			)}
			{error && (
				<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm">
					{error}
				</div>
			)}

			{/* Custom Roles Framed Table */}
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle className="text-base">
						<Trans>Custom Roles</Trans> ({customRoles.length})
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Tailored roles specific to your organization with configured
							permissions.
						</Trans>
					</FrameDescription>
					<FrameAction>
						<Button
							size="sm"
							render={<Link to={`${basePath}/new`} />}
							className="gap-1.5"
						>
							<Icon name="plus" className="size-3.5" />
							<Trans>Create role</Trans>
						</Button>
					</FrameAction>
				</FrameHeader>

				{customRoles.length === 0 ? (
					<FramePanel className="text-muted-foreground py-10 text-center text-sm">
						<p>
							<Trans>No custom roles created yet.</Trans>
						</p>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>
								Create a custom role to assign specific permissions to
								teammates.
							</Trans>
						</p>
					</FramePanel>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead className="w-1/4">
									<Trans>Role</Trans>
								</TableHead>
								<TableHead className="w-1/3">
									<Trans>Description</Trans>
								</TableHead>
								<TableHead className="text-center">
									<Trans>Members</Trans>
								</TableHead>
								<TableHead className="text-center">
									<Trans>Permissions</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{customRoles.map((role) => (
								<TableRow key={role.id}>
									<TableCell className="text-foreground align-middle">
										{roleName(role)}
									</TableCell>
									<TableCell className="text-muted-foreground max-w-md truncate align-middle text-sm">
										{role.description || '—'}
									</TableCell>
									<TableCell className="text-muted-foreground text-center align-middle text-sm">
										{role.memberCount}
									</TableCell>
									<TableCell className="text-muted-foreground text-center align-middle text-sm">
										{role.permissionIds.length}
									</TableCell>
									<TableCell className="text-right align-middle">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="sm"
												render={<Link to={`${basePath}/${role.id}`} />}
												className="text-muted-foreground hover:text-foreground text-xs"
											>
												<Trans>View</Trans>
											</Button>
											<Button
												variant="ghost"
												size="sm"
												render={<Link to={`${basePath}/${role.id}/edit`} />}
												className="text-muted-foreground hover:text-foreground text-xs"
											>
												<Trans>Edit</Trans>
											</Button>
											<Button
												variant="ghost"
												size="sm"
												type="button"
												className="text-muted-foreground hover:text-destructive text-xs"
												disabled={isDeleting}
												onClick={() => setRoleToDelete(role)}
											>
												<Trans>Delete</Trans>
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Frame>

			{/* Staff role presets: one-click starting points, created as ordinary custom roles */}
			{staffingPresets && staffingPresets.length > 0 ? (
				<Frame className="w-full">
					<FrameHeader>
						<FrameTitle className="text-base">
							<Trans>Staff role presets</Trans>
						</FrameTitle>
						<FrameDescription>
							<Trans>
								Create a ready-made role for the people who run your team. Each
								one becomes a normal custom role that you can rename, edit, or
								delete.
							</Trans>
						</FrameDescription>
					</FrameHeader>
					{staffingPresets.map((preset) => (
						<FramePanel key={preset.key}>
							<Form
								method="POST"
								className="flex flex-wrap items-center justify-between gap-3"
							>
								<input
									type="hidden"
									name="intent"
									value="create-staffing-preset"
								/>
								<input type="hidden" name="presetKey" value={preset.key} />
								<div className="min-w-0 flex-1 basis-64">
									<p className="text-sm font-medium">{preset.name}</p>
									<p className="text-muted-foreground text-xs">
										{preset.description}
									</p>
								</div>
								{preset.exists ? (
									<Badge variant="secondary">
										<Trans>Created</Trans>
									</Badge>
								) : (
									<Button type="submit" variant="outline" size="sm">
										<Trans>Create role</Trans>
									</Button>
								)}
							</Form>
						</FramePanel>
					))}
				</Frame>
			) : null}

			{/* Reservations role presets: one-click starting points, created as ordinary custom roles */}
			{reservationsPresets && reservationsPresets.length > 0 ? (
				<Frame className="w-full">
					<FrameHeader>
						<FrameTitle className="text-base">
							<Trans>Reservations role presets</Trans>
						</FrameTitle>
						<FrameDescription>
							<Trans>
								Create a ready-made role for your host stand, shift leads,
								reservations team, guestbook, or finance. Each one becomes a
								normal custom role that you can rename, edit, or delete.
							</Trans>
						</FrameDescription>
					</FrameHeader>
					{reservationsPresets.map((preset) => (
						<FramePanel key={preset.key}>
							<Form
								method="POST"
								className="flex flex-wrap items-center justify-between gap-3"
							>
								<input
									type="hidden"
									name="intent"
									value="create-reservations-preset"
								/>
								<input type="hidden" name="presetKey" value={preset.key} />
								<div className="min-w-0 flex-1 basis-64">
									<p className="text-sm font-medium">{preset.name}</p>
									<p className="text-muted-foreground text-xs">
										{preset.description}
									</p>
								</div>
								{preset.exists ? (
									<Badge variant="secondary">
										<Trans>Created</Trans>
									</Badge>
								) : (
									<Button type="submit" variant="outline" size="sm">
										<Trans>Create role</Trans>
									</Button>
								)}
							</Form>
						</FramePanel>
					))}
				</Frame>
			) : null}

			{/* Built-in Roles Framed Table */}
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle className="text-base">
						<Trans>Built-in Roles</Trans> ({builtInRoles.length})
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Standard platform roles. Click any role to review its active
							permissions.
						</Trans>
					</FrameDescription>
				</FrameHeader>

				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead className="w-1/4">
								<Trans>Role</Trans>
							</TableHead>
							<TableHead className="w-1/2">
								<Trans>Description</Trans>
							</TableHead>
							<TableHead className="text-center">
								<Trans>Members</Trans>
							</TableHead>
							<TableHead className="text-right">
								<Trans>Access</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{builtInRoles.map((role) => (
							// One link per row: the role name, stretched over the whole row so
							// any cell still opens the role. The other cells stay plain text
							// so screen readers do not hear links named only "0" or "1". The
							// focus ring is drawn on the stretched area, so it outlines the row.
							<TableRow key={role.id} className="group relative cursor-pointer">
								<TableCell className="text-foreground group-hover:text-primary align-middle transition-colors">
									<Link
										to={`${basePath}/${role.id}`}
										className="focus-visible:after:ring-ring block py-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset"
									>
										{roleName(role)}
									</Link>
								</TableCell>
								<TableCell className="text-muted-foreground align-middle text-sm">
									<span className="block py-1">
										{roleDescription(role) || t`Platform-provided role.`}
									</span>
								</TableCell>
								<TableCell className="text-muted-foreground text-center align-middle text-sm">
									<span className="block py-1">{role.memberCount}</span>
								</TableCell>
								<TableCell className="text-right align-middle">
									<span
										aria-hidden
										className={cn(
											buttonVariants({ variant: 'ghost', size: 'sm' }),
											'text-muted-foreground group-hover:text-foreground gap-1 text-xs',
										)}
									>
										<Trans>Inspect</Trans>
										<Icon name="arrow-right" className="size-3.5" />
									</span>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>

			{/* Delete Role Confirmation Dialog */}
			<AlertDialog
				open={roleToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setRoleToDelete(null)
				}}
			>
				<AlertDialogContent>
					<Form method="POST">
						<input type="hidden" name="intent" value="delete-role" />
						{roleToDelete && (
							<input type="hidden" name="roleId" value={roleToDelete.id} />
						)}
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete custom role</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription className="text-sm">
								<Trans>
									Are you sure you want to delete “{roleNameToDelete}”? This
									action cannot be undone.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isDeleting}>
								<Trans>Cancel</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="submit"
								variant="destructive"
								disabled={isDeleting}
							>
								{isDeleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
							</AlertDialogAction>
						</AlertDialogFooter>
					</Form>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
