import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Form, useFetcher, useNavigation } from 'react-router'
import { restaurantDishPhotoStudio } from '#app/utils/media/photo-studio-vertical.ts'
import { isRestyleErrorCode, RESTYLE_ERROR_MESSAGES } from './restyle-labels.ts'

export type RestyleCategory = {
	id: string
	name: string
	parentId: string | null
}

export type RestylePreview = {
	withPhoto: number
	withoutPhoto: number
	tooMany: boolean
	maxPhotos: number
}

type PreviewData = { ok?: boolean; preview?: RestylePreview }

const DEPTH_PADDING = ['ps-0', 'ps-5', 'ps-10', 'ps-15']

/** The categories as a flat list, children right after their parent. */
function orderCategories(categories: RestyleCategory[]) {
	const byParent = new Map<string | null, RestyleCategory[]>()
	for (const category of categories) {
		const parent =
			category.parentId && categories.some((c) => c.id === category.parentId)
				? category.parentId
				: null
		byParent.set(parent, [...(byParent.get(parent) ?? []), category])
	}
	const out: Array<RestyleCategory & { depth: number }> = []
	const walk = (parent: string | null, depth: number) => {
		for (const category of byParent.get(parent) ?? []) {
			out.push({ ...category, depth })
			if (depth < 3) walk(category.id, depth + 1)
		}
	}
	walk(null, 0)
	return out
}

/**
 * Start a menu restyle (#146): pick one studio style, optionally limit it to
 * some categories, see how many dishes it will restyle and how many are
 * skipped, and start. Nothing on the live menu changes from here.
 */
export function RestyleStartForm({
	categories,
	initialPreview,
	disabled,
	disabledReason,
	error,
}: {
	categories: RestyleCategory[]
	initialPreview: RestylePreview
	disabled?: boolean
	disabledReason?: string
	error?: string | null
}) {
	const { _ } = useLingui()
	const vertical = restaurantDishPhotoStudio
	const formId = useId()
	const navigation = useNavigation()
	const previewFetcher = useFetcher<PreviewData>()
	const [presetId, setPresetId] = useState<string | null>(null)
	const [options, setOptions] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(
			vertical.options.map((option) => [option.id, option.defaultValue]),
		),
	)
	const [selected, setSelected] = useState<string[]>([])
	const ordered = useMemo(() => orderCategories(categories), [categories])
	const preview = previewFetcher.data?.preview ?? initialPreview
	const { withPhoto, withoutPhoto, maxPhotos } = preview
	const starting =
		navigation.state === 'submitting' &&
		navigation.formData?.get('intent') === 'start'

	// Ask the server how many dishes the chosen categories hold.
	const firstRender = useRef(true)
	useEffect(() => {
		if (firstRender.current) {
			firstRender.current = false
			return
		}
		const data = new FormData()
		data.set('intent', 'preview')
		for (const id of selected) data.append('categoryIds', id)
		void previewFetcher.submit(data, { method: 'POST' })
		// The fetcher object changes on every state change; only the choice matters.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected])

	const canStart =
		!disabled &&
		presetId !== null &&
		preview.withPhoto > 0 &&
		!preview.tooMany &&
		!starting

	return (
		<Form method="post" id={formId} className="space-y-8">
			<input type="hidden" name="intent" value="start" />
			<input type="hidden" name="presetId" value={presetId ?? ''} />
			<input type="hidden" name="options" value={JSON.stringify(options)} />
			{selected.map((id) => (
				<input key={id} type="hidden" name="categoryIds" value={id} />
			))}

			<p className="text-muted-foreground flex items-start gap-2 text-sm">
				<Icon name="info" className="mt-0.5 size-4 shrink-0" aria-hidden />
				<span>
					<Trans>
						Only the plate, the backdrop and the light change. Your food stays
						exactly as photographed.
					</Trans>
				</span>
			</p>

			{disabled && disabledReason ? (
				<Alert>
					<AlertDescription>{disabledReason}</AlertDescription>
				</Alert>
			) : null}
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>
						{isRestyleErrorCode(error)
							? _(RESTYLE_ERROR_MESSAGES[error])
							: _(RESTYLE_ERROR_MESSAGES.invalid_style)}
					</AlertDescription>
				</Alert>
			) : null}

			<fieldset className="space-y-6">
				<legend className="text-sm font-medium">
					<Trans>Pick a style</Trans>
				</legend>
				{vertical.categories.map((group) => {
					const presets = vertical.presets.filter(
						(preset) => preset.category === group.id,
					)
					if (presets.length === 0) return null
					return (
						<div key={group.id} className="space-y-2">
							<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
								{_(group.label)}
							</p>
							<RadioGroup
								value={presetId ?? ''}
								onValueChange={(value) => setPresetId(String(value))}
								aria-label={_(group.label)}
								className="sm:grid-cols-2 lg:grid-cols-4"
							>
								{presets.map((preset) => (
									<ChoiceCard key={preset.id}>
										<RadioGroupItem value={preset.id} />
										<ChoiceCardContent>
											<ChoiceCardTitle>
												<Icon
													name={preset.icon}
													className="size-4"
													aria-hidden
												/>
												{_(preset.label)}
											</ChoiceCardTitle>
											<ChoiceCardDescription>
												{_(preset.description)}
											</ChoiceCardDescription>
										</ChoiceCardContent>
									</ChoiceCard>
								))}
							</RadioGroup>
						</div>
					)
				})}
			</fieldset>

			{vertical.options.length > 0 ? (
				<fieldset className="space-y-3">
					<legend className="text-sm font-medium">
						<Trans>Options</Trans>
					</legend>
					{vertical.options.map((option) => {
						const id = `${formId}-${option.id}`
						return (
							<div key={option.id} className="flex items-start gap-3">
								<Checkbox
									id={id}
									checked={options[option.id] ?? option.defaultValue}
									onCheckedChange={(checked) =>
										setOptions((current) => ({
											...current,
											[option.id]: checked === true,
										}))
									}
								/>
								<Label htmlFor={id} className="flex-col items-start gap-0.5">
									<span>{_(option.label)}</span>
									<span className="text-muted-foreground text-xs font-normal">
										{_(option.description)}
									</span>
								</Label>
							</div>
						)
					})}
				</fieldset>
			) : null}

			{ordered.length > 0 ? (
				<fieldset className="space-y-3">
					<legend className="text-sm font-medium">
						<Trans>Which dishes?</Trans>
					</legend>
					<p className="text-muted-foreground text-sm">
						{selected.length === 0 ? (
							<Trans>
								Every dish on your menu. Choose categories to limit it.
							</Trans>
						) : (
							<Trans>Only dishes in the chosen categories.</Trans>
						)}
					</p>
					<ul className="grid gap-2 sm:grid-cols-2">
						{ordered.map((category) => {
							const id = `${formId}-cat-${category.id}`
							return (
								<li
									key={category.id}
									className={cn(
										'flex items-center gap-3',
										DEPTH_PADDING[category.depth] ?? 'ps-15',
									)}
								>
									<Checkbox
										id={id}
										checked={selected.includes(category.id)}
										onCheckedChange={(checked) =>
											setSelected((current) =>
												checked === true
													? [...current, category.id]
													: current.filter((value) => value !== category.id),
											)
										}
									/>
									<Label htmlFor={id} className="wrap-anywhere">
										{category.name}
									</Label>
								</li>
							)
						})}
					</ul>
				</fieldset>
			) : null}

			<div className="space-y-3" aria-live="polite">
				<p className="text-sm">
					<Trans>
						{withPhoto} dishes with a photo, {withoutPhoto} without (skipped)
					</Trans>
				</p>
				{preview.tooMany ? (
					<p className="text-destructive text-sm">
						<Trans>
							One run restyles at most {maxPhotos} photos. Choose fewer
							categories.
						</Trans>
					</p>
				) : null}
				<Button type="submit" disabled={!canStart}>
					<Icon name="sparkles" aria-hidden />
					{starting ? <Trans>Starting...</Trans> : <Trans>Start restyle</Trans>}
				</Button>
				{presetId === null ? (
					<p className="text-muted-foreground text-xs">
						<Trans>Choose a style to start.</Trans>
					</p>
				) : null}
			</div>
		</Form>
	)
}
