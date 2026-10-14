import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { FieldLegend, FieldSet } from '@repo/ui/field'
import { Item, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { Skeleton } from '@repo/ui/skeleton'
import { useMemo, useState, type FormEvent } from 'react'
import { useLoaderData } from 'react-router'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { ReviewRows } from '#app/components/staff/review-rows.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { useTeamContext } from '#app/components/staff/team-context.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	reviewDrafts,
	splitName,
	type DraftRow,
} from '#app/utils/staffing/staff-import.ts'
import {
	bulkResultSchema,
	staffListSchema,
	type BulkResult,
} from '#app/utils/staffing/staff-types.ts'
import { loadImportableMembers } from '#app/utils/staffing/team-context.server.ts'
import { type Route } from './+types/team.import.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_WRITE_REQUIREMENT,
	)
	// Linking a login to a staff record is a trust decision about identity, so
	// tenant-api only accepts it from a token that is not limited to selected
	// scopes. Refuse early instead of listing members to someone who cannot
	// use them.
	if (access.scopeIds !== null) {
		throw new Response('Forbidden: requires access to every workplace', {
			status: 403,
		})
	}
	// The picker lists every member's login name and email, so it needs the same
	// permission as the Members page. Managing staff alone does not reveal logins.
	await requireUserWithOrganizationPermission(
		request,
		access.organizationId,
		ORG_PERMISSIONS.READ_MEMBER_ANY,
	)
	return { members: await loadImportableMembers(access.organizationId) }
}

type Step = 'choose' | 'review' | 'done'

export default function ImportMembersRoute() {
	const { members } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const { client, ready: tokenReady } = useStaffClient('staff')
	const { scopes, reloadRoster, close } = useTeamContext()

	const [step, setStep] = useState<Step>('choose')
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	const [drafts, setDrafts] = useState<DraftRow[]>([])
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<BulkResult | null>(null)

	// Members already on the roster are marked instead of imported twice.
	const roster = useStaffQuery(
		client,
		tokenReady ? '/?limit=200' : null,
		staffListSchema,
	)
	const linked = useMemo(
		() =>
			new Set(
				(roster.data?.staff ?? [])
					.map((row) => row.userId)
					.filter((id): id is string => Boolean(id)),
			),
		[roster.data],
	)
	const importable = members.filter((member) => !linked.has(member.userId))
	const allSelected =
		importable.length > 0 &&
		importable.every((member) => selected.has(member.userId))
	const reviewed = useMemo(() => reviewDrafts(drafts), [drafts])
	const ready = reviewed.filter((row) => row.problems.length === 0)
	const readyCount = ready.length
	const needFix = reviewed.length - readyCount

	function toggle(userId: string, on: boolean) {
		setSelected((current) => {
			const next = new Set(current)
			if (on) next.add(userId)
			else next.delete(userId)
			return next
		})
	}

	function review(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const chosen = importable.filter((member) => selected.has(member.userId))
		setDrafts(
			chosen.map((member) => {
				const { firstName, lastName } = splitName(member.name)
				return {
					id: `member-${member.userId}`,
					userId: member.userId,
					firstName,
					lastName,
					email: member.email,
					phone: '',
				}
			}),
		)
		setStep('review')
	}

	async function confirm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending || ready.length === 0) return
		setPending(true)
		setError(null)
		try {
			const data = bulkResultSchema.parse(
				await client.request('/import', {
					method: 'POST',
					json: {
						members: ready.map((row) => ({
							userId: row.userId,
							firstName: row.firstName,
							lastName: row.lastName,
							email: row.email,
							assignments: scopeId ? [{ scopeId, isPrimary: true }] : [],
						})),
					},
				}),
			)
			setResult(data)
			setStep('done')
			reloadRoster()
			const created = data.summary.created
			toast.success(
				plural(created, {
					one: '# person imported',
					other: '# people imported',
				}),
			)
		} catch (failure) {
			setError(describeStaffError(failure, _))
		} finally {
			setPending(false)
		}
	}

	if (step === 'done' && result) {
		const { created, existing, invalid, conflict } = result.summary
		const notImported = invalid + conflict
		return (
			<SheetForm
				title={_(t`Import finished`)}
				onSubmit={(event) => {
					event.preventDefault()
					close()
				}}
				footer={
					<Button type="submit">
						<Trans>Done</Trans>
					</Button>
				}
			>
				<p role="status" className="text-sm">
					<Trans>
						{created} imported, {existing} already on your team, {notImported}{' '}
						not imported.
					</Trans>
				</p>
			</SheetForm>
		)
	}

	if (step === 'review') {
		return (
			<SheetForm
				title={_(t`Review before importing`)}
				description={_(
					t`Nothing is saved until you confirm. Members keep their login; this only adds them to your team.`,
				)}
				onSubmit={(event) => void confirm(event)}
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => setStep('choose')}
						>
							<Trans>Back</Trans>
						</Button>
						<Button type="submit" disabled={pending || readyCount === 0}>
							{pending
								? _(t`Importing…`)
								: plural(readyCount, {
										one: 'Import # person',
										other: 'Import # people',
									})}
						</Button>
					</>
				}
			>
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						{readyCount} ready, {needFix} need a fix. Rows with a problem are
						skipped.
					</Trans>
				</p>
				<ReviewRows
					rows={reviewed}
					editable={['name']}
					onChange={(id, patch) =>
						setDrafts((current) =>
							current.map((draft) =>
								draft.id === id ? { ...draft, ...patch } : draft,
							),
						)
					}
					onRemove={(id) =>
						setDrafts((current) => current.filter((draft) => draft.id !== id))
					}
				/>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
			</SheetForm>
		)
	}

	return (
		<SheetForm
			title={_(t`Import current members`)}
			description={_(
				t`Choose the members who also work here. You review the list next.`,
			)}
			onSubmit={review}
			footer={
				<>
					<Button type="button" variant="outline" onClick={close}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={selected.size === 0}>
						<Trans>Review list</Trans>
					</Button>
				</>
			}
		>
			{members.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>There are no active members to import.</Trans>
				</p>
			) : roster.loading ? (
				<div className="flex flex-col gap-3" role="status">
					<span className="sr-only">
						<Trans>Loading members</Trans>
					</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : (
				<FieldSet>
					<FieldLegend variant="label" className="sr-only">
						<Trans>Members</Trans>
					</FieldLegend>
					<Label className="flex min-h-11 items-center gap-3 text-sm font-medium">
						<Checkbox
							checked={allSelected}
							disabled={importable.length === 0}
							onCheckedChange={(on) =>
								setSelected(
									on
										? new Set(importable.map((member) => member.userId))
										: new Set(),
								)
							}
						/>
						<Trans>Select all</Trans>
					</Label>
					<ItemGroup>
						{members.map((member) => {
							const already = linked.has(member.userId)
							return (
								<Item key={member.userId} variant="outline" render={<li />}>
									<div className="w-full">
										<Label className="flex min-h-14 items-center gap-3 px-3 py-2">
											<Checkbox
												checked={selected.has(member.userId)}
												disabled={already}
												onCheckedChange={(on) => toggle(member.userId, on)}
											/>
											<span className="flex min-w-0 flex-col">
												<span className="truncate text-sm font-medium">
													{member.name}
												</span>
												<span className="text-muted-foreground truncate text-xs">
													{member.email}
												</span>
											</span>
											{already ? (
												<span className="text-muted-foreground ms-auto text-xs">
													<Trans>On your team</Trans>
												</span>
											) : null}
										</Label>
									</div>
								</Item>
							)
						})}
					</ItemGroup>
				</FieldSet>
			)}
			{scopes.length > 1 ? (
				<SelectField
					label={<Trans>Workplace</Trans>}
					value={scopeId}
					onValueChange={setScopeId}
					options={scopes.map((item) => ({
						value: item.id,
						label: item.name,
					}))}
					hint={_(t`Everyone you import is added to this workplace.`)}
				/>
			) : null}
		</SheetForm>
	)
}
