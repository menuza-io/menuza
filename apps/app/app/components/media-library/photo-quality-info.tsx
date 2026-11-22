import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isWeakPhoto, type PhotoQualityIssue } from '@repo/common/photo-quality'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Label } from '@repo/ui/label'

export const QUALITY_ISSUE_LABELS = {
	too_dark: msg`Too dark`,
	blurry: msg`Blurry`,
	dish_cut_off: msg`Dish cut off`,
	low_resolution: msg`Low resolution`,
	not_food: msg`Doesn't look like food`,
} as const satisfies Record<PhotoQualityIssue, ReturnType<typeof msg>>

export type PhotoQuality = {
	qualityScore: number | null
	qualityIssues: PhotoQualityIssue[]
	analyzed: boolean
}

/** Whether the library should flag this photo as needing a better one. */
export function needsBetterPhoto(photo: PhotoQuality) {
	return isWeakPhoto({ score: photo.qualityScore, issues: photo.qualityIssues })
}

/** The score on a library card (#145): advisory, never blocks anything. */
export function QualityBadge({ photo }: { photo: PhotoQuality }) {
	const { _ } = useLingui()
	if (!photo.analyzed && photo.qualityScore === null) return null
	const weak = needsBetterPhoto(photo)
	if (photo.qualityScore === null && photo.qualityIssues.length === 0) {
		return null
	}
	return (
		<Badge
			variant={weak ? 'warning' : 'secondary'}
			className="pointer-events-none"
			title={
				photo.qualityIssues.length > 0
					? photo.qualityIssues
							.map((issue) => _(QUALITY_ISSUE_LABELS[issue]))
							.join(', ')
					: undefined
			}
		>
			{photo.qualityScore !== null ? (
				<span className="tabular-nums">{photo.qualityScore}</span>
			) : (
				<Trans>Needs a better photo</Trans>
			)}
		</Badge>
	)
}

/** Details dialog: the score, the plain issues, and the way to fix them. */
export function PhotoQualityInfo({
	photo,
	canFix,
	onFix,
}: {
	photo: PhotoQuality
	canFix: boolean
	onFix: () => void
}) {
	const { _ } = useLingui()
	const weak = needsBetterPhoto(photo)
	const score = photo.qualityScore
	return (
		<div className="space-y-1.5" data-testid="photo-quality-info">
			<Label className="text-xs font-medium">
				<Trans>Photo quality</Trans>
			</Label>
			{!photo.analyzed && photo.qualityScore === null ? (
				<p className="text-muted-foreground text-xs">
					<Trans>Checking this photo. A score appears in a few minutes.</Trans>
				</p>
			) : photo.qualityScore === null && photo.qualityIssues.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					<Trans>No score for this photo.</Trans>
				</p>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					{photo.qualityScore !== null ? (
						<span className="text-sm font-medium tabular-nums">
							<Trans>{score} out of 100</Trans>
						</span>
					) : null}
					{photo.qualityIssues.map((issue) => (
						<Badge key={issue} variant="warning">
							{_(QUALITY_ISSUE_LABELS[issue])}
						</Badge>
					))}
				</div>
			)}
			{weak && canFix ? (
				<Button type="button" size="xs" variant="outline" onClick={onFix}>
					<Trans>Fix in photo studio</Trans>
				</Button>
			) : null}
		</div>
	)
}
