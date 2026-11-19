import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Textarea } from '@repo/ui/textarea'
import { Form, Link, useLoaderData, useNavigation } from 'react-router'
import { action, loader } from './legal-agreements.server.ts'

export { action, loader }

function titleOf(raw: string, locale: string) {
	try {
		const map = JSON.parse(raw) as Record<string, string>
		return map[locale] || map.en || Object.values(map)[0] || raw
	} catch {
		return raw
	}
}

export default function LegalAgreementsAdminRoute() {
	const { overview, selected, keys } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const navigation = useNavigation()
	const busy = navigation.state !== 'idle'
	const missingKey = selected?.agreement.key ?? ''
	const missingVersion = selected?.agreement.version ?? 0
	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Legal agreements</Trans>}
				description={
					<Trans>
						Publish a new version of a Menuza agreement and see which
						organizations have not accepted it. Owners are asked at their next
						sign-in; after a "required by" date the dashboard is blocked until
						they accept.
					</Trans>
				}
			/>

			<Frame className="w-full">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Agreement</Trans>
							</TableHead>
							<TableHead>
								<Trans>Version</Trans>
							</TableHead>
							<TableHead>
								<Trans>Required by</Trans>
							</TableHead>
							<TableHead>
								<Trans>Accepted</Trans>
							</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{overview.map((row) => (
							<TableRow key={row.key}>
								<TableCell className="font-medium">
									{titleOf(row.title, i18n.locale)}{' '}
									<span className="text-muted-foreground font-mono text-xs">
										{row.key}
									</span>
								</TableCell>
								<TableCell>{row.version}</TableCell>
								<TableCell>
									{row.requiredBy
										? new Date(row.requiredBy).toLocaleDateString(i18n.locale)
										: '—'}
								</TableCell>
								<TableCell>
									<Badge variant="outline">
										{row.acceptedCount} / {row.organizationCount}
									</Badge>
								</TableCell>
								<TableCell className="text-right">
									<Button
										variant="outline"
										size="sm"
										render={
											<Link
												to={`?key=${row.key}&version=${row.version}`}
												prefetch="none"
											/>
										}
									>
										<Trans>Who has not accepted</Trans>
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>

			{selected ? (
				<section aria-labelledby="missing-heading" className="space-y-3">
					<h2 id="missing-heading" className="text-lg font-semibold">
						<Trans>
							Not accepted: {missingKey} version {missingVersion}
						</Trans>{' '}
						<span className="text-muted-foreground text-sm font-normal">
							({selected.total})
						</span>
					</h2>
					{selected.agreement.overdue ? (
						<p className="text-destructive text-sm">
							<Trans>
								The required-by date has passed: these owners are blocked until
								they accept.
							</Trans>
						</p>
					) : null}
					<Frame className="w-full">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Organization</Trans>
									</TableHead>
									<TableHead>
										<Trans>Owners</Trans>
									</TableHead>
									<TableHead>
										<Trans>Created</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{selected.organizations.map((org) => (
									<TableRow key={org.id}>
										<TableCell className="font-medium wrap-anywhere">
											{org.name}{' '}
											<span className="text-muted-foreground text-xs">
												{org.slug}
											</span>
										</TableCell>
										<TableCell>{org.owners.join(', ') || '—'}</TableCell>
										<TableCell className="text-muted-foreground">
											{new Date(org.createdAt).toLocaleDateString(i18n.locale)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Frame>
				</section>
			) : null}

			<section aria-labelledby="publish-heading" className="space-y-3">
				<h2 id="publish-heading" className="text-lg font-semibold">
					<Trans>Publish a new version</Trans>
				</h2>
				<Form method="post" className="grid max-w-xl gap-4">
					<input type="hidden" name="_action" value="publish" />
					<div className="space-y-1.5">
						<Label htmlFor="agreement-key">
							<Trans>Agreement</Trans>
						</Label>
						<select
							id="agreement-key"
							name="key"
							className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
							defaultValue="terms"
						>
							{keys.map((key) => (
								<option key={key} value={key}>
									{key}
								</option>
							))}
						</select>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="title-en">
								<Trans>Title (English)</Trans>
							</Label>
							<Input id="title-en" name="titleEn" required />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="title-ar">
								<Trans>Title (Arabic)</Trans>
							</Label>
							<Input id="title-ar" name="titleAr" dir="rtl" />
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="summary-en">
							<Trans>What changed (English)</Trans>
						</Label>
						<Textarea id="summary-en" name="summaryEn" rows={3} />
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="summary-ar">
							<Trans>What changed (Arabic)</Trans>
						</Label>
						<Textarea id="summary-ar" name="summaryAr" rows={3} dir="rtl" />
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="agreement-url">
							<Trans>Link to the full text</Trans>
						</Label>
						<Input id="agreement-url" name="url" placeholder="/tos" required />
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="required-by">
							<Trans>Required by (optional)</Trans>
						</Label>
						<Input id="required-by" name="requiredBy" type="date" />
						<p className="text-muted-foreground text-xs">
							{_(
								msg`After this date the dashboard is blocked for owners who have not accepted.`,
							)}
						</p>
					</div>
					<Button type="submit" disabled={busy} className="w-fit">
						<Trans>Publish version</Trans>
					</Button>
				</Form>
			</section>
		</div>
	)
}
