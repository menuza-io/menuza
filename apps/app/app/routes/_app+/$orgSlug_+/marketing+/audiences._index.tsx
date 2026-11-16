import { i18n } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AUDIENCE_LIMITS,
	audienceDefinitionSchema,
	type AudienceCounts,
	type AudienceDefinition,
	type AudienceErrorCode,
} from '@repo/common/marketing-audiences'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { useEffect, useState } from 'react'
import {
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	AudienceBuilder,
	EMPTY_AUDIENCE,
} from '#app/components/marketing/audience-builder.tsx'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import {
	loadAudiences,
	type AudienceListItem,
} from '#app/utils/marketing/audiences.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/** Words for each refusal tenant-api can give; never a value the guest or operator typed. */
function audienceErrorText(code: AudienceErrorCode | string | undefined) {
	switch (code) {
		case 'audience_in_use':
			return i18n._(
				t`This audience is used by a broadcast that has not finished, or by an automation. Remove it there first.`,
			)
		case 'audience_limit':
			return i18n._(t`You can save up to ${AUDIENCE_LIMITS.audiences} audiences.`)
		case 'audience_name_taken':
			return i18n._(t`You already have an audience with this name.`)
		case 'audience_version_changed':
			return i18n._(
				t`Someone else changed this audience. Reload the page and try again.`,
			)
		case 'sensitive_rule_not_allowed':
			return i18n._(
				t`Audiences cannot use tags, allergies or notes. Choose another rule.`,
			)
		case 'location_out_of_scope':
			return i18n._(t`You can only use rules for your own locations.`)
		case 'invalid_audience':
			return i18n._(t`Check the rules: something is missing or out of range.`)
		default:
			return i18n._(t`Something went wrong. Please try again.`)
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)
	// Off until the organization turns it on: the page does not exist before.
	if (!(await getMarketingFeatures(orgId)).audiences) {
		throw new Response('Not found', { status: 404 })
	}
	const audiences = await loadAudiences(fetchTenant)
	return {
		orgSlug,
		audiences: audiences ?? ([] as AudienceListItem[]),
		error: audiences ? null : i18n._(t`Failed to load audiences`),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug, {
		canUpdate: true,
		canDelete: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	if (!(await getMarketingFeatures(orgId)).audiences) {
		throw new Response('Not found', { status: 404 })
	}

	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	const audienceId = String(form.get('audienceId') ?? '')

	if (intent === 'delete') {
		const res = await fetchTenant(`/operator/marketing/audiences/${audienceId}`, {
			method: 'DELETE',
		})
		if (res.ok) return { ok: true as const, intent }
		const body = (await res.json().catch(() => ({}))) as { error?: string }
		return { ok: false as const, intent, error: audienceErrorText(body.error) }
	}

	let definition: unknown
	try {
		definition = JSON.parse(String(form.get('definition') ?? ''))
	} catch {
		return { ok: false as const, intent, error: audienceErrorText('invalid_audience') }
	}
	// Checked here too, so a bad body never leaves the App.
	if (!audienceDefinitionSchema.safeParse(definition).success) {
		return { ok: false as const, intent, error: audienceErrorText('invalid_audience') }
	}

	if (intent === 'preview') {
		const res = await fetchTenant('/operator/marketing/audiences/preview', {
			method: 'POST',
			body: JSON.stringify({ definition }),
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			return { ok: false as const, intent, error: audienceErrorText(body.error) }
		}
		const data = (await res.json()) as { counts: AudienceCounts }
		return { ok: true as const, intent, counts: data.counts }
	}

	if (intent === 'save') {
		const expectedVersion = Number(form.get('expectedVersion')) || undefined
		const res = await fetchTenant(
			audienceId
				? `/operator/marketing/audiences/${audienceId}`
				: '/operator/marketing/audiences',
			{
				method: audienceId ? 'PUT' : 'POST',
				body: JSON.stringify({
					name: String(form.get('name') ?? ''),
					definition,
					...(audienceId && expectedVersion ? { expectedVersion } : {}),
				}),
			},
		)
		if (res.ok) return { ok: true as const, intent }
		const body = (await res.json().catch(() => ({}))) as { error?: string }
		return { ok: false as const, intent, error: audienceErrorText(body.error) }
	}

	return { ok: false as const, intent, error: audienceErrorText(undefined) }
}

/** "Fewer than 5" below the floor; the exact figure above it. */
function useCountText() {
	const { _ } = useLingui()
	return (value: number | null | undefined) =>
		value === null || value === undefined
			? _(msg`Fewer than ${AUDIENCE_LIMITS.countFloor}`)
			: String(value)
}

function AudienceDialog({
	audience,
	open,
	onOpenChange,
}: {
	audience: AudienceListItem | null
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<typeof action>()
	const preview = useFetcher<typeof action>()
	const countText = useCountText()
	const [name, setName] = useState('')
	const [definition, setDefinition] = useState<AudienceDefinition>(EMPTY_AUDIENCE)

	useEffect(() => {
		if (!open) return
		setName(audience?.name ?? '')
		setDefinition(audience?.definition ?? EMPTY_AUDIENCE)
	}, [open, audience])

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data) return
		if (fetcher.data.ok) {
			toast.success(_(msg`Audience saved`))
			onOpenChange(false)
		} else if ('error' in fetcher.data) {
			toast.error(fetcher.data.error)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	const counts =
		preview.data && 'counts' in preview.data ? preview.data.counts : null
	const busy = fetcher.state !== 'idle'

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{audience ? _(msg`Edit audience`) : _(msg`New audience`)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Pick the guests by what they did. The size is worked out each time
							you send, never stored.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="audience-name">
							<Trans>Name</Trans>
						</Label>
						<Input
							id="audience-name"
							value={name}
							maxLength={AUDIENCE_LIMITS.nameMax}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>

					<AudienceBuilder
						value={definition}
						onChange={setDefinition}
						disabled={busy}
					/>

					<div className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={preview.state !== 'idle'}
							onClick={() =>
								void preview.submit(
									{ intent: 'preview', definition: JSON.stringify(definition) },
									{ method: 'POST' },
								)
							}
						>
							<Trans>Check size</Trans>
						</Button>
						{counts ? (
							<span className="text-muted-foreground">
								{_(
									msg`Matches ${countText(counts.size)} · email ${countText(counts.email)} · text ${countText(counts.sms)}`,
								)}
							</span>
						) : (
							<span className="text-muted-foreground">
								<Trans>Counts only. No guest is shown.</Trans>
							</span>
						)}
					</div>
					{preview.data && 'error' in preview.data ? (
						<p className="text-destructive text-sm">{preview.data.error}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={busy || name.trim().length === 0}
						onClick={() =>
							void fetcher.submit(
								{
									intent: 'save',
									name,
									definition: JSON.stringify(definition),
									...(audience
										? {
												audienceId: audience.id,
												expectedVersion: String(audience.version),
											}
										: {}),
								},
								{ method: 'POST' },
							)
						}
					>
						<Trans>Save audience</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

export default function AudiencesRoute() {
	const { _ } = useLingui()
	const { audiences, error } = useLoaderData<typeof loader>()
	const hasPermission = useHasPermission()
	const canManage = hasPermission('update:campaign:any')
	const fetcher = useFetcher<typeof action>()
	const countText = useCountText()
	const [editing, setEditing] = useState<AudienceListItem | null>(null)
	const [open, setOpen] = useState(false)

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data) return
		if (fetcher.data.intent !== 'delete') return
		if (fetcher.data.ok) toast.success(_(msg`Audience deleted`))
		else if ('error' in fetcher.data) toast.error(fetcher.data.error)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Audiences`)}
				description={_(
					msg`Saved groups of guests, by what they ordered, visited or earned. Use them to send a broadcast or to branch an automation.`,
				)}
				actions={
					canManage ? (
						<Button
							className="shrink-0 gap-2"
							onClick={() => {
								setEditing(null)
								setOpen(true)
							}}
						>
							<Icon name="plus" className="size-4" />
							{_(msg`New audience`)}
						</Button>
					) : null
				}
			/>

			{error ? (
				<p className="text-destructive text-sm">{error}</p>
			) : audiences.length === 0 ? (
				<EmptyState
					title={_(msg`No audiences yet`)}
					description={_(msg`Create your first audience.`)}
					icons={['users', 'search', 'send']}
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/40 text-muted-foreground text-xs">
							<tr>
								<th className="px-3 py-2 text-start font-medium">
									<Trans>Audience</Trans>
								</th>
								<th className="px-3 py-2 text-start font-medium">
									<Trans>Guests</Trans>
								</th>
								<th className="px-3 py-2 text-start font-medium">
									<Trans>Can get email</Trans>
								</th>
								<th className="px-3 py-2 text-start font-medium">
									<Trans>Can get texts</Trans>
								</th>
								<th className="px-3 py-2" />
							</tr>
						</thead>
						<tbody>
							{audiences.map((audience) => (
								<tr key={audience.id} className="border-t">
									<td className="px-3 py-2 font-medium">{audience.name}</td>
									<td className="px-3 py-2">{countText(audience.counts?.size)}</td>
									<td className="px-3 py-2">{countText(audience.counts?.email)}</td>
									<td className="px-3 py-2">{countText(audience.counts?.sms)}</td>
									<td className="px-3 py-2 text-end">
										{canManage ? (
											<div className="flex justify-end gap-1">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														setEditing(audience)
														setOpen(true)
													}}
												>
													<Trans>Edit</Trans>
												</Button>
												<Button
													variant="ghost"
													size="sm"
													className="text-destructive"
													onClick={() => {
														const audienceName = audience.name
														if (
															confirm(
																_(msg`Delete the audience "${audienceName}"?`),
															)
														) {
															void fetcher.submit(
																{ intent: 'delete', audienceId: audience.id },
																{ method: 'POST' },
															)
														}
													}}
												>
													<Trans>Delete</Trans>
												</Button>
											</div>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<AudienceDialog audience={editing} open={open} onOpenChange={setOpen} />
		</div>
	)
}
