import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AuditAction } from '@repo/audit'
import {
	LOCATION_TAG_NAME_MAX_LENGTH,
	MAX_LOCATION_TAGS,
} from '@repo/common/location-tags'
import { db, eq, OrganizationLocation } from '@repo/database'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Spinner } from '@repo/ui/spinner'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { requireHeadOffice } from '#app/utils/location/location-access.server.ts'
import { auditLocationSettingEntries } from '#app/utils/location/location-settings.server.ts'
import {
	exportLocationsCsv,
	importLocationsCsv,
} from '#app/utils/location/locations-csv.server.ts'
import {
	createLocationTag,
	deleteLocationTag,
	listLocationTags,
	renameLocationTag,
	setTagLocations,
} from '#app/utils/location/tags.server.ts'

/**
 * Location tags (#374): name groups of locations, put locations in them, and
 * download or upload the locations as a file. Tags grant access (Settings,
 * Members) so only head office, a member with every location, manages them.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const manager = await requireHeadOffice(request, params.orgSlug)
	const url = new URL(request.url)
	if (url.searchParams.get('download') === 'csv') {
		const csv = await exportLocationsCsv(manager.organization.id)
		return new Response(csv, {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="locations-${manager.organization.slug}.csv"`,
				'Cache-Control': 'private, no-store',
			},
		})
	}
	const [tags, locations] = await Promise.all([
		listLocationTags(manager.organization.id),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, manager.organization.id)),
	])
	return {
		orgSlug: manager.organization.slug,
		tags,
		locations: locations.sort((a, b) => a.name.localeCompare(b.name)),
		maxTags: MAX_LOCATION_TAGS,
	}
}

const idSchema = z.string().trim().min(1).max(64)
const intentSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('create-tag'), name: z.string().max(200) }),
	z.object({
		intent: z.literal('rename-tag'),
		tagId: idSchema,
		name: z.string().max(200),
	}),
	z.object({ intent: z.literal('delete-tag'), tagId: idSchema }),
	z.object({
		intent: z.literal('set-tag-locations'),
		tagId: idSchema,
		locationIds: z.array(idSchema).max(500),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	const manager = await requireHeadOffice(request, params.orgSlug)
	const { organization, userId } = manager
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'preview-csv' || intent === 'apply-csv') {
		const file = formData.get('file')
		const text =
			file instanceof File
				? await file.text()
				: typeof formData.get('csv') === 'string'
					? (formData.get('csv') as string)
					: ''
		const result = await importLocationsCsv({
			organization,
			userId,
			request,
			text,
			apply: intent === 'apply-csv',
		})
		return result.ok
			? data({ ok: true as const, csv: result })
			: data({ ok: false as const, error: result.error }, { status: 400 })
	}

	const raw: Record<string, unknown> = { intent }
	for (const [key, value] of formData.entries()) {
		if (key === 'locationIds') continue
		raw[key] = value
	}
	raw.locationIds = formData.getAll('locationIds')
	const parsed = intentSchema.safeParse(raw)
	if (!parsed.success) {
		return data(
			{ ok: false as const, error: 'invalid_request' },
			{ status: 400 },
		)
	}
	const body = parsed.data
	const log = (
		action: AuditAction,
		resourceId: string,
		details: string,
		metadata: Record<string, unknown> = {},
	) =>
		auditLocationSettingEntries({
			organizationId: organization.id,
			userId,
			request,
			entries: [
				{
					action,
					locationId: '',
					resource: { type: 'organization_location_tag', id: resourceId },
					details,
					metadata,
				},
			],
		})

	if (body.intent === 'create-tag') {
		const result = await createLocationTag(organization.id, body.name)
		if (!result.ok) {
			return data(
				{ ok: false as const, error: result.error },
				{ status: result.error === 'duplicate' ? 409 : 400 },
			)
		}
		await log(
			AuditAction.LOCATION_TAG_CREATED,
			result.id,
			'Location tag created',
		)
		return data({ ok: true as const })
	}
	if (body.intent === 'rename-tag') {
		const result = await renameLocationTag(
			organization.id,
			body.tagId,
			body.name,
		)
		if (!result.ok) {
			return data(
				{ ok: false as const, error: result.error },
				{ status: result.error === 'tag_not_found' ? 404 : 409 },
			)
		}
		await log(
			AuditAction.LOCATION_TAG_UPDATED,
			body.tagId,
			'Location tag renamed',
		)
		return data({ ok: true as const })
	}
	if (body.intent === 'delete-tag') {
		const result = await deleteLocationTag(organization.id, body.tagId)
		if (!result.ok) {
			return data({ ok: false as const, error: result.error }, { status: 404 })
		}
		await log(
			AuditAction.LOCATION_TAG_DELETED,
			body.tagId,
			'Location tag deleted',
		)
		return data({ ok: true as const })
	}
	const result = await setTagLocations(
		organization.id,
		body.tagId,
		body.locationIds,
	)
	if (!result.ok) {
		return data(
			{ ok: false as const, error: result.error },
			{ status: result.error === 'tag_not_found' ? 404 : 400 },
		)
	}
	await log(
		AuditAction.LOCATION_TAGS_ASSIGNED,
		body.tagId,
		'Location tag assigned',
		{
			locationCount: body.locationIds.length,
		},
	)
	return data({ ok: true as const })
}

type CsvResponse =
	| {
			ok: true
			csv: {
				applied: boolean
				plan: {
					rows: number
					changes: Array<{ row: number; name: string; fields: string[] }>
					problems: Array<{
						row: number
						id: string
						problem: string
						column?: string
						value?: string
					}>
					newTags: string[]
				}
			}
	  }
	| { ok: false; error: string }

function useTagErrorText() {
	const { _ } = useLingui()
	return (code: string) => {
		switch (code) {
			case 'name_required':
				return _(t`Enter a tag name.`)
			case 'name_too_long':
				return _(t`Use ${LOCATION_TAG_NAME_MAX_LENGTH} characters or fewer.`)
			case 'duplicate':
				return _(t`A tag with this name already exists.`)
			case 'limit_reached':
				return _(
					t`You can have at most ${MAX_LOCATION_TAGS} tags. Delete one you no longer use first.`,
				)
			case 'tag_not_found':
				return _(t`That tag no longer exists.`)
			case 'unknown_location':
				return _(t`One of those locations was not found.`)
			case 'tag_limit':
				return _(
					t`This file would create more than ${MAX_LOCATION_TAGS} tags. Nothing was changed.`,
				)
			case 'too_large':
				return _(t`That file is too large.`)
			case 'empty':
				return _(t`That file is empty.`)
			case 'not_template':
				return _(
					t`That does not look like the locations file. Download it, edit it, and upload it again.`,
				)
			case 'too_many_rows':
				return _(t`That file has too many rows.`)
			case 'import_failed':
				return _(
					t`Nothing was changed. Something went wrong, please try again.`,
				)
			default:
				return _(t`Something went wrong. Please try again.`)
		}
	}
}

export default function LocationTagsRoute() {
	const { orgSlug, tags, locations, maxTags } = useLoaderData<typeof loader>()
	const errorText = useTagErrorText()
	const createFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const tagCount = tags.length
	const [name, setName] = useState('')
	const creating = createFetcher.state !== 'idle'

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center gap-3">
				<Button
					variant="outline"
					size="icon"
					render={<Link to={`/${orgSlug}/settings/locations`} />}
				>
					<Icon name="arrow-left" className="size-4" />
					<span className="sr-only">
						<Trans>Back</Trans>
					</span>
				</Button>
				<div>
					<h2 className="text-xl tracking-tight">
						<Trans>Location tags and import</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Group locations (a region, a franchisee) to give a team member
							access to the whole group, filter reports, and edit many locations
							from a file.
						</Trans>
					</p>
				</div>
			</div>

			<section className="bg-card space-y-3 rounded-md border p-4">
				<h3 className="font-medium">
					<Trans>New tag</Trans>
				</h3>
				<createFetcher.Form
					method="POST"
					className="flex flex-wrap items-start gap-2"
					onSubmit={() => setName('')}
				>
					<input type="hidden" name="intent" value="create-tag" />
					<Input
						name="name"
						aria-label={t`Tag name`}
						className="max-w-xs"
						maxLength={LOCATION_TAG_NAME_MAX_LENGTH + 20}
						placeholder={t`For example: Texas`}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<Button type="submit" disabled={creating || name.trim() === ''}>
						{creating ? <Spinner /> : null}
						<Trans>Add tag</Trans>
					</Button>
				</createFetcher.Form>
				<p className="text-muted-foreground text-xs">
					<Trans>
						{tagCount} of {maxTags} tags used
					</Trans>
				</p>
				{createFetcher.data && !createFetcher.data.ok ? (
					<Alert variant="destructive">
						<AlertDescription>
							{errorText(createFetcher.data.error ?? '')}
						</AlertDescription>
					</Alert>
				) : null}
			</section>

			{tags.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No tags yet.</Trans>
				</p>
			) : (
				<ul className="grid gap-4">
					{tags.map((tag) => (
						<li key={tag.id}>
							<TagCard tag={tag} locations={locations} errorText={errorText} />
						</li>
					))}
				</ul>
			)}

			<CsvSection orgSlug={orgSlug} errorText={errorText} />
		</div>
	)
}

function TagCard({
	tag,
	locations,
	errorText,
}: {
	tag: { id: string; name: string; locationIds: string[] }
	locations: Array<{ id: string; name: string }>
	errorText: (code: string) => string
}) {
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [editing, setEditing] = useState(false)
	const [renaming, setRenaming] = useState(false)
	const [newName, setNewName] = useState(tag.name)
	const [selected, setSelected] = useState(new Set(tag.locationIds))
	const busy = fetcher.state !== 'idle'

	return (
		<div
			className="bg-card space-y-3 rounded-md border p-4"
			data-testid="tag-card"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Icon name="tag" className="size-4" />
					<h3 className="font-medium wrap-anywhere">{tag.name}</h3>
					<Badge variant="outline">
						{plural(tag.locationIds.length, {
							one: '# location',
							other: '# locations',
						})}
					</Badge>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => setEditing((v) => !v)}
					>
						<Trans>Choose locations</Trans>
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setRenaming((v) => !v)}
					>
						<Trans>Rename</Trans>
					</Button>
					<fetcher.Form method="POST">
						<input type="hidden" name="intent" value="delete-tag" />
						<input type="hidden" name="tagId" value={tag.id} />
						<Button size="sm" variant="ghost" type="submit" disabled={busy}>
							<Trans>Delete</Trans>
						</Button>
					</fetcher.Form>
				</div>
			</div>

			{renaming ? (
				<fetcher.Form
					method="POST"
					className="flex flex-wrap items-center gap-2"
					onSubmit={() => setRenaming(false)}
				>
					<input type="hidden" name="intent" value="rename-tag" />
					<input type="hidden" name="tagId" value={tag.id} />
					<Input
						name="name"
						aria-label={t`Tag name`}
						className="max-w-xs"
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
					/>
					<Button type="submit" size="sm" disabled={busy}>
						<Trans>Save name</Trans>
					</Button>
				</fetcher.Form>
			) : null}

			{editing ? (
				<fetcher.Form
					method="POST"
					className="space-y-2"
					onSubmit={() => setEditing(false)}
				>
					<input type="hidden" name="intent" value="set-tag-locations" />
					<input type="hidden" name="tagId" value={tag.id} />
					<div className="grid max-h-56 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
						{locations.map((location) => (
							<label
								key={location.id}
								className="flex items-center gap-2 text-sm"
							>
								<Checkbox
									checked={selected.has(location.id)}
									onCheckedChange={(value) =>
										setSelected((current) => {
											const next = new Set(current)
											if (value === true) next.add(location.id)
											else next.delete(location.id)
											return next
										})
									}
								/>
								<span className="wrap-anywhere">{location.name}</span>
								{selected.has(location.id) ? (
									<input type="hidden" name="locationIds" value={location.id} />
								) : null}
							</label>
						))}
					</div>
					<Button type="submit" size="sm" disabled={busy}>
						{busy ? <Spinner /> : null}
						<Trans>Save locations</Trans>
					</Button>
				</fetcher.Form>
			) : null}

			{fetcher.data && !fetcher.data.ok ? (
				<Alert variant="destructive">
					<AlertDescription>
						{errorText(fetcher.data.error ?? '')}
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	)
}

function CsvSection({
	orgSlug,
	errorText,
}: {
	orgSlug: string
	errorText: (code: string) => string
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CsvResponse>()
	const [file, setFile] = useState<File | null>(null)
	const busy = fetcher.state !== 'idle'
	const response = fetcher.data
	const csv = response && response.ok ? response.csv : null
	const newTagNames = csv ? csv.plan.newTags.join(', ') : ''

	function submit(intent: 'preview-csv' | 'apply-csv') {
		if (!file) return
		const form = new FormData()
		form.set('intent', intent)
		form.set('file', file)
		void fetcher.submit(form, {
			method: 'POST',
			encType: 'multipart/form-data',
		})
	}

	function problemText(problem: {
		problem: string
		column?: string
		value?: string
	}) {
		switch (problem.problem) {
			case 'unknown_location':
				return _(t`This location id does not exist.`)
			case 'duplicate_row':
				return _(t`This location appears twice in the file.`)
			case 'bad_active':
				return _(t`Active must be yes or no.`)
			case 'bad_phone':
				return _(t`This phone number is not valid.`)
			case 'bad_tag':
				return _(t`This tag name is not valid.`)
			case 'tag_too_long':
				return _(t`A tag name is too long.`)
			default:
				return problem.problem
		}
	}

	return (
		<section className="bg-card space-y-3 rounded-md border p-4">
			<h3 className="font-medium">
				<Trans>Download and edit as a file</Trans>
			</h3>
			<p className="text-muted-foreground text-sm">
				<Trans>
					Download your locations, change the phone, active and tags columns,
					and upload the file. Every row is checked first: if one row has a
					problem nothing is changed.
				</Trans>
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					render={
						<a
							href={`/${orgSlug}/settings/locations/tags?download=csv`}
							download
						/>
					}
				>
					<Icon name="download" className="size-4" />
					<Trans>Download locations</Trans>
				</Button>
				<Input
					type="file"
					accept=".csv,text/csv,.tsv,text/plain"
					aria-label={t`Locations file`}
					className="max-w-xs"
					onChange={(event) => setFile(event.target.files?.[0] ?? null)}
				/>
				<Button
					variant="outline"
					disabled={busy || !file}
					onClick={() => submit('preview-csv')}
				>
					{busy ? <Spinner /> : null}
					<Trans>Check the file</Trans>
				</Button>
			</div>

			{response && !response.ok ? (
				<Alert variant="destructive">
					<AlertDescription>{errorText(response.error)}</AlertDescription>
				</Alert>
			) : null}

			{csv ? (
				<div className="space-y-3" data-testid="csv-result">
					{csv.plan.problems.length > 0 ? (
						<Alert variant="destructive" data-testid="csv-problems">
							<AlertDescription>
								<p className="font-medium">
									{plural(csv.plan.problems.length, {
										one: '# problem found. Nothing was changed.',
										other: '# problems found. Nothing was changed.',
									})}
								</p>
								<ul className="mt-1 list-disc ps-5">
									{csv.plan.problems.map((problem, index) => {
										const row = problem.row
										return (
											<li key={index}>
												<Trans>Row {row}:</Trans> {problemText(problem)}
											</li>
										)
									})}
								</ul>
							</AlertDescription>
						</Alert>
					) : csv.applied ? (
						<Alert>
							<AlertDescription>
								{plural(csv.plan.changes.length, {
									one: 'Updated # location.',
									other: 'Updated # locations.',
								})}
							</AlertDescription>
						</Alert>
					) : (
						<div className="space-y-2 text-sm">
							<p>
								{plural(csv.plan.changes.length, {
									one: '# location will change.',
									other: '# locations will change.',
								})}
								{csv.plan.newTags.length > 0
									? ` ${_(t`New tags: ${newTagNames}.`)}`
									: ''}
							</p>
							<Button
								disabled={busy || csv.plan.changes.length === 0}
								onClick={() => submit('apply-csv')}
							>
								<Trans>Apply the file</Trans>
							</Button>
						</div>
					)}
				</div>
			) : null}
		</section>
	)
}
