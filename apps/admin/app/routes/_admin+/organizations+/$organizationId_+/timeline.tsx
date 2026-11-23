import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	TIMELINE_FILTERS,
	TIMELINE_FILTER_LABELS,
	isTimelineFilter,
	type TimelineFilter,
} from '@repo/common/organization-events'
import { SupportNote, db, eq, and } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Textarea } from '@repo/ui/textarea'
import {
	Form,
	Link,
	data,
	useLoaderData,
	type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { OrganizationTabs } from '#app/components/organization-tabs.tsx'
import { auditSupportAction } from '#app/utils/support.server.ts'
import { loadTimeline } from '#app/utils/timeline.server.ts'

export async function loader({
	request,
	params,
}: {
	request: Request
	params: { organizationId?: string }
}) {
	await requireUserWithRole(request, 'admin')
	const organizationId = params.organizationId
	if (!organizationId) throw new Response('Not found', { status: 404 })
	const url = new URL(request.url)
	const filters = url.searchParams
		.getAll('kind')
		.filter((value): value is TimelineFilter => isTimelineFilter(value))
	const locationId = url.searchParams.get('location')?.slice(0, 64) || null
	const beforeParam = url.searchParams.get('before')
	const before = beforeParam ? new Date(beforeParam) : null
	const timeline = await loadTimeline({
		organizationId,
		filters,
		locationId,
		before: before && !Number.isNaN(before.getTime()) ? before : null,
	})
	return {
		organizationId,
		filters,
		locationId,
		pinned: timeline.pinned.map((note) => ({
			...note,
			createdAt: note.createdAt.toISOString(),
		})),
		locations: timeline.locations,
		nextBefore: timeline.nextBefore?.toISOString() ?? null,
		entries: timeline.entries.map((entry) => ({
			...entry,
			at: entry.at.toISOString(),
		})),
	}
}

const NoteSchema = z.object({
	intent: z.enum(['add-note', 'pin', 'unpin']),
	body: z.string().trim().max(1000).optional(),
	noteId: z.string().trim().max(64).optional(),
	pinned: z.string().optional(),
})

/** Support's own notes on a restaurant, pinnable into the Timeline (#279). */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const organizationId = params.organizationId
	if (!organizationId) throw data({ error: 'not_found' }, { status: 404 })
	const parsed = NoteSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw data({ error: 'invalid' }, { status: 400 })
	const input = parsed.data

	if (input.intent === 'add-note') {
		if (!input.body) throw data({ error: 'empty' }, { status: 400 })
		const [note] = await db
			.insert(SupportNote)
			.values({
				organizationId,
				authorId: agentId,
				body: input.body,
				pinned: input.pinned === 'on',
			})
			.returning({ id: SupportNote.id })
		await auditSupportAction({
			action: AuditAction.SUPPORT_NOTE_ADDED,
			agentId,
			organizationId,
			resourceType: 'SupportNote',
			resourceId: note!.id,
			// The note's words stay in the note: the audit row records that one exists.
			details: 'Support note added',
			request,
		})
		return data({ ok: true })
	}
	if (!input.noteId) throw data({ error: 'invalid' }, { status: 400 })
	await db
		.update(SupportNote)
		.set({ pinned: input.intent === 'pin' })
		.where(
			and(
				eq(SupportNote.id, input.noteId),
				eq(SupportNote.organizationId, organizationId),
			),
		)
	return data({ ok: true })
}

export default function OrganizationTimelinePage() {
	const {
		organizationId,
		filters,
		locationId,
		pinned,
		locations,
		nextBefore,
		entries,
	} = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const selected = new Set(filters)

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="text-2xl font-bold">
					<Trans>Timeline</Trans>
				</h1>
				<OrganizationTabs organizationId={organizationId} />
			</div>

			{pinned.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							<Trans>Pinned notes</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2 text-sm">
							{pinned.map((note) => (
								<div
									key={note.id}
									className="flex items-start justify-between gap-3"
								>
									<p>
										{note.body}{' '}
										<span className="text-muted-foreground text-xs">
											{note.authorName ?? ''} ·{' '}
											{new Date(note.createdAt).toLocaleDateString()}
										</span>
									</p>
									<Form method="post">
										<input type="hidden" name="intent" value="unpin" />
										<input type="hidden" name="noteId" value={note.id} />
										<Button type="submit" variant="ghost" size="sm">
											<Trans>Unpin</Trans>
										</Button>
									</Form>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			) : null}

			<Form method="get" className="flex flex-wrap items-end gap-3">
				<fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
					<legend className="text-muted-foreground mb-1 text-xs">
						<Trans>Show</Trans>
					</legend>
					{TIMELINE_FILTERS.map((filter) => (
						<label key={filter} className="flex items-center gap-1">
							<input
								type="checkbox"
								name="kind"
								value={filter}
								defaultChecked={selected.has(filter)}
							/>
							{TIMELINE_FILTER_LABELS[filter]}
						</label>
					))}
				</fieldset>
				{locations.length > 1 ? (
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>Location</Trans>
						</span>
						<select
							name="location"
							defaultValue={locationId ?? ''}
							className="bg-background h-8 rounded-md border px-2"
						>
							<option value="">{_(msg`All locations`)}</option>
							{locations.map((location) => (
								<option key={location.id} value={location.id}>
									{location.name}
								</option>
							))}
						</select>
					</label>
				) : null}
				<Button type="submit" variant="outline" size="sm">
					<Trans>Filter</Trans>
				</Button>
			</Form>

			<Form method="post" className="flex max-w-2xl items-end gap-3">
				<input type="hidden" name="intent" value="add-note" />
				<Textarea
					name="body"
					required
					maxLength={1000}
					aria-label={_(msg`Note`)}
					placeholder={_(msg`Called the owner, will fix bank details Monday`)}
					className="min-h-[60px]"
				/>
				<div className="space-y-2">
					<label className="flex items-center gap-1 text-sm">
						<input type="checkbox" name="pinned" /> <Trans>Pin</Trans>
					</label>
					<Button type="submit" size="sm">
						<Trans>Add note</Trans>
					</Button>
				</div>
			</Form>

			{entries.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Nothing to show for these filters.</Trans>
				</p>
			) : (
				<ol className="divide-y rounded-lg border">
					{entries.map((entry) => (
						<li
							key={entry.id}
							className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm"
						>
							<div className="space-y-0.5">
								<p className="font-medium">
									{entry.title}
									{entry.locationName ? (
										<Badge variant="outline" className="ms-2">
											{entry.locationName}
										</Badge>
									) : null}
								</p>
								{entry.detail ? (
									<p className="text-muted-foreground">{entry.detail}</p>
								) : null}
								{entry.link ? (
									entry.link.external ? (
										<a
											href={entry.link.href}
											target="_blank"
											rel="noreferrer"
											className="text-xs underline"
										>
											{entry.link.label}
										</a>
									) : (
										<Link to={entry.link.href} className="text-xs underline">
											{entry.link.label}
										</Link>
									)
								) : null}
							</div>
							<time
								className="text-muted-foreground text-xs"
								dateTime={entry.at}
							>
								{new Date(entry.at).toLocaleString()}
							</time>
						</li>
					))}
				</ol>
			)}

			{nextBefore ? (
				<Link
					to={`?${new URLSearchParams([
						...filters.map((filter): [string, string] => ['kind', filter]),
						...(locationId
							? ([['location', locationId]] as Array<[string, string]>)
							: []),
						['before', nextBefore],
					]).toString()}`}
					className="text-sm underline"
				>
					<Trans>Older events</Trans>
				</Link>
			) : null}
		</div>
	)
}
