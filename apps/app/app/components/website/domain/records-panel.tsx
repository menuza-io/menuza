import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useState } from 'react'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import {
	CopyValue,
	errorMessage,
	issueMessage,
	useDomainFetcher,
} from './domain-ui.tsx'

/**
 * The DNS records of a domain Menuza manages (#283): add and edit with checks
 * (one SPF per name, MX needs a priority, no duplicates), records Menuza
 * writes for the site, email forwarding or sending are read-only.
 */

type ManagedView = DomainOverview['managed'][number]
type RecordView = ManagedView['records'][number]

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'] as const

function RecordForm({
	domain,
	record,
	onDone,
}: {
	domain: ManagedView
	record: RecordView | null
	onDone: () => void
}) {
	const { _ } = useLingui()
	const form = useDomainFetcher({
		success: record ? msg`Record saved` : msg`Record added`,
		onSuccess: onDone,
		silent: true,
	})
	const [type, setType] = useState<string>(record?.type ?? 'A')
	const issues =
		(form.result && !form.result.ok
			? (form.result.issues as
					Array<{ field: string; code: string }> | undefined)
			: undefined) ?? []
	return (
		<form.Form
			method="POST"
			className="bg-muted/50 grid gap-3 rounded-xl p-3 sm:grid-cols-6"
		>
			<input
				type="hidden"
				name="intent"
				value={record ? 'update-record' : 'add-record'}
			/>
			<input type="hidden" name="managedDomainId" value={domain.id} />
			{record ? (
				<input type="hidden" name="recordId" value={record.id} />
			) : null}
			<input type="hidden" name="type" value={type} />
			<div className="space-y-1 sm:col-span-1">
				<Label>
					<Trans>Type</Trans>
				</Label>
				<Select
					value={type}
					onValueChange={(value) => value && setType(value)}
					items={TYPES.map((t) => ({ value: t, label: t }))}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TYPES.map((t) => (
							<SelectItem key={t} value={t}>
								{t}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="space-y-1 sm:col-span-2">
				<Label htmlFor={`rec-name-${record?.id ?? 'new'}`}>
					<Trans>Name</Trans>
				</Label>
				<Input
					id={`rec-name-${record?.id ?? 'new'}`}
					name="name"
					defaultValue={record?.name ?? domain.fqdn}
					required
				/>
			</div>
			<div className="space-y-1 sm:col-span-2">
				<Label htmlFor={`rec-content-${record?.id ?? 'new'}`}>
					<Trans>Value</Trans>
				</Label>
				<Input
					id={`rec-content-${record?.id ?? 'new'}`}
					name="content"
					defaultValue={record?.content ?? ''}
					required
				/>
			</div>
			{type === 'MX' || type === 'SRV' ? (
				<div className="space-y-1 sm:col-span-1">
					<Label htmlFor={`rec-priority-${record?.id ?? 'new'}`}>
						<Trans>Priority</Trans>
					</Label>
					<Input
						id={`rec-priority-${record?.id ?? 'new'}`}
						name="priority"
						inputMode="numeric"
						defaultValue={record?.priority ?? ''}
					/>
				</div>
			) : null}
			<div className="space-y-1 sm:col-span-1">
				<Label htmlFor={`rec-ttl-${record?.id ?? 'new'}`}>
					<Trans>TTL</Trans>
				</Label>
				<Input
					id={`rec-ttl-${record?.id ?? 'new'}`}
					name="ttl"
					inputMode="numeric"
					defaultValue={record && record.ttl > 1 ? record.ttl : ''}
					placeholder={_(msg`Auto`)}
				/>
			</div>
			<div className="flex items-end gap-2 sm:col-span-6">
				<Button type="submit" size="sm" disabled={form.busy}>
					{record ? <Trans>Save record</Trans> : <Trans>Add record</Trans>}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					<Trans>Cancel</Trans>
				</Button>
			</div>
			{form.result && !form.result.ok ? (
				<ul className="text-destructive space-y-0.5 text-sm sm:col-span-6">
					{issues.length > 0 ? (
						issues.map((issue) => (
							<li key={`${issue.field}-${issue.code}`}>
								{issueMessage(issue.code, _)}
							</li>
						))
					) : (
						<li>{errorMessage(form.result.error, _)}</li>
					)}
				</ul>
			) : null}
		</form.Form>
	)
}

export function RecordsPanel({
	domain,
	canUpdate,
}: {
	domain: ManagedView
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const [editing, setEditing] = useState<string | null>(null)
	const [adding, setAdding] = useState(false)
	const remover = useDomainFetcher({ success: msg`Record removed` })
	const labels: Record<string, string> = {
		site: _(msg`Managed for your site`),
		email_forwarding: _(msg`Managed for email forwarding`),
		email_sending: _(msg`Managed for email sending`),
		registrar: _(msg`Managed by the registrar`),
	}
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm font-medium">
					<Trans>DNS records</Trans>
				</p>
				{canUpdate ? (
					<div className="flex gap-2">
						<form method="POST">
							<input type="hidden" name="intent" value="export-zone" />
							<input type="hidden" name="managedDomainId" value={domain.id} />
							<Button type="submit" variant="outline" size="sm">
								<Icon name="download" className="me-1.5 size-3.5" />
								<Trans>Export zone file</Trans>
							</Button>
						</form>
						<Button
							type="button"
							size="sm"
							onClick={() => {
								setAdding(true)
								setEditing(null)
							}}
						>
							<Icon name="plus" className="me-1.5 size-3.5" />
							<Trans>Add record</Trans>
						</Button>
					</div>
				) : null}
			</div>
			{adding ? (
				<RecordForm
					domain={domain}
					record={null}
					onDone={() => setAdding(false)}
				/>
			) : null}
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-sm">
					<thead className="bg-muted text-muted-foreground text-xs">
						<tr>
							<th className="px-3 py-2 text-start font-medium">
								<Trans>Type</Trans>
							</th>
							<th className="px-3 py-2 text-start font-medium">
								<Trans>Name</Trans>
							</th>
							<th className="px-3 py-2 text-start font-medium">
								<Trans>Value</Trans>
							</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{domain.records.length === 0 ? (
							<tr>
								<td
									colSpan={4}
									className="text-muted-foreground px-3 py-4 text-center"
								>
									<Trans>No records yet.</Trans>
								</td>
							</tr>
						) : null}
						{domain.records.map((record) => (
							<tr key={record.id} className="border-t align-top">
								{editing === record.id ? (
									<td colSpan={4} className="p-2">
										<RecordForm
											domain={domain}
											record={record}
											onDone={() => setEditing(null)}
										/>
									</td>
								) : (
									<>
										<td className="px-3 py-2 font-mono text-xs">
											{record.type}
										</td>
										<td className="px-3 py-2">
											<CopyValue value={record.name} />
										</td>
										<td className="px-3 py-2">
											<CopyValue
												value={
													record.priority !== null
														? `${record.priority} ${record.content}`
														: record.content
												}
											/>
										</td>
										<td className="px-3 py-2 text-end whitespace-nowrap">
											{record.managedBy ? (
												<Badge variant="secondary">
													<Icon name="lock" />
													{labels[record.managedBy] ??
														_(msg`Managed by Menuza`)}
												</Badge>
											) : canUpdate ? (
												<>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={_(msg`Edit`)}
														onClick={() => {
															setEditing(record.id)
															setAdding(false)
														}}
													>
														<Icon name="pencil" className="size-3.5" />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={_(msg`Remove`)}
														disabled={remover.busy}
														onClick={() =>
															remover.submit({
																intent: 'delete-record',
																managedDomainId: domain.id,
																recordId: record.id,
															})
														}
													>
														<Icon name="trash-2" className="size-3.5" />
													</Button>
												</>
											) : null}
										</td>
									</>
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Every change to a record is logged under Website, Activity.
				</Trans>
			</p>
		</div>
	)
}
