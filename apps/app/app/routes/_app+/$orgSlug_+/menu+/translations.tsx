import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	getSiteLocaleLabel,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	computeTranslationStatus,
	filterTranslationGaps,
	TRANSLATABLE_KINDS,
	type TranslatableKind,
	type TranslationField,
} from '@repo/common/translation-status'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { loadTranslatableRecords } from '#app/utils/menu/translation-status.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/** Rows shown at once; the counts above always cover everything. */
const MAX_ROWS = 500

const FIELDS = ['name', 'description'] as const

function readFilter<T extends string>(
	value: string | null,
	allowed: readonly T[],
): T | null {
	return value && (allowed as readonly string[]).includes(value)
		? (value as T)
		: null
}

/**
 * Menu > Translations (#410): per website language, the dishes, options,
 * option groups and categories missing a name or a description. Read fresh on
 * every load, so saving a record and coming back updates the list.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	await requireMenuRead(request, organization.id)

	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const records = await loadTranslatableRecords(organization.id)
	const status = computeTranslationStatus(records, { locales, defaultLocale })

	const url = new URL(request.url)
	const enabled = status.locales.map((summary) => summary.locale)
	const translationLocales = enabled.filter(
		(locale) => locale !== defaultLocale,
	)
	const locale =
		readFilter(url.searchParams.get('locale'), enabled) ??
		translationLocales[0] ??
		defaultLocale
	const field = readFilter<TranslationField>(
		url.searchParams.get('field'),
		FIELDS,
	)
	const kind = readFilter<TranslatableKind>(
		url.searchParams.get('kind'),
		TRANSLATABLE_KINDS,
	)
	const gaps = filterTranslationGaps(status.gaps, { locale, field, kind })

	return {
		orgSlug: organization.slug,
		defaultLocale,
		summaries: status.locales,
		filter: { locale, field, kind },
		total: gaps.length,
		gaps: gaps.slice(0, MAX_ROWS),
	}
}

const EDIT_PATH: Record<TranslatableKind, string> = {
	item: 'items',
	option: 'options',
	modifier_group: 'modifiers',
	category: 'categories',
}

export default function MenuTranslations() {
	const { _ } = useLingui()
	const { orgSlug, defaultLocale, summaries, filter, total, gaps } =
		useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()

	const kindLabels: Record<TranslatableKind, string> = {
		item: _(t`Dish`),
		option: _(t`Option`),
		modifier_group: _(t`Option group`),
		category: _(t`Category`),
	}
	const fieldLabels: Record<TranslationField, string> = {
		name: _(t`Name`),
		description: _(t`Description`),
	}

	const setParam = (key: string, value: string | null) => {
		const next = new URLSearchParams(searchParams)
		if (value && value !== 'all') next.set(key, value)
		else next.delete(key)
		setSearchParams(next, { replace: true, preventScrollReset: true })
	}

	if (summaries.length < 2) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>
						<Trans>Your website has one language</Trans>
					</EmptyTitle>
					<EmptyDescription>
						<Trans>
							Add a second language in Website settings to see which names and
							descriptions still need a translation.
						</Trans>
					</EmptyDescription>
				</EmptyHeader>
				<Button variant="outline" render={<Link to={`/${orgSlug}/website`} />}>
					<Trans>Website settings</Trans>
				</Button>
			</Empty>
		)
	}

	const localeItems = summaries.map((summary) => ({
		value: summary.locale,
		label: getSiteLocaleLabel(summary.locale),
	}))
	const fieldItems = [
		{ value: 'all', label: _(t`Names and descriptions`) },
		...FIELDS.map((value) => ({ value, label: fieldLabels[value] })),
	]
	const kindItems = [
		{ value: 'all', label: _(t`Everything`) },
		...TRANSLATABLE_KINDS.map((value) => ({ value, label: kindLabels[value] })),
	]

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{summaries.map((summary) => {
					const languageName = getSiteLocaleLabel(summary.locale)
					const { missingNames, names, missingDescriptions, descriptions } =
						summary
					return (
						<Card key={summary.locale} data-testid={`locale-${summary.locale}`}>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									{languageName}
									{summary.locale === defaultLocale ? (
										<Badge variant="secondary">
											<Trans>Default</Trans>
										</Badge>
									) : null}
								</CardTitle>
							</CardHeader>
							<CardContent className="flex flex-col gap-1">
								<span>
									<Trans>
										Missing names: {missingNames} of {names}
									</Trans>
								</span>
								<span className="text-muted-foreground">
									<Trans>
										Missing descriptions: {missingDescriptions} of{' '}
										{descriptions}
									</Trans>
								</span>
							</CardContent>
						</Card>
					)
				})}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<Select
					value={filter.locale}
					items={localeItems}
					onValueChange={(value) => setParam('locale', value)}
				>
					<SelectTrigger aria-label={_(t`Language`)} className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{localeItems.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={filter.field ?? 'all'}
					items={fieldItems}
					onValueChange={(value) => setParam('field', value)}
				>
					<SelectTrigger aria-label={_(t`Missing field`)} className="w-56">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{fieldItems.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={filter.kind ?? 'all'}
					items={kindItems}
					onValueChange={(value) => setParam('kind', value)}
				>
					<SelectTrigger aria-label={_(t`Record type`)} className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{kindItems.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{gaps.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>
							<Trans>Nothing is missing</Trans>
						</EmptyTitle>
						<EmptyDescription>
							<Trans>
								Every name and description matching these filters is filled in.
							</Trans>
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<p className="text-muted-foreground text-sm">
						<Trans>
							{total} missing. Open a record to add the translation.
						</Trans>
					</p>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Record</Trans>
								</TableHead>
								<TableHead>
									<Trans>Type</Trans>
								</TableHead>
								<TableHead>
									<Trans>Missing</Trans>
								</TableHead>
								<TableHead>
									<span className="sr-only">
										<Trans>Edit</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{gaps.map((gap) => (
								<TableRow
									key={`${gap.kind}:${gap.id}:${gap.field}:${gap.locale}`}
								>
									<TableCell className="wrap-anywhere">
										{gap.label || <Trans>(no name)</Trans>}
									</TableCell>
									<TableCell>{kindLabels[gap.kind]}</TableCell>
									<TableCell>
										{fieldLabels[gap.field]} · {getSiteLocaleLabel(gap.locale)}
									</TableCell>
									<TableCell className="text-end">
										<Button
											variant="outline"
											size="sm"
											render={
												<Link
													to={`/${orgSlug}/menu/${EDIT_PATH[gap.kind]}/${gap.id}`}
												/>
											}
										>
											<Trans>Edit</Trans>
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</>
			)}
		</div>
	)
}
