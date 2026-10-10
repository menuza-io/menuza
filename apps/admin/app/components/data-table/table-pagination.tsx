import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useSearchParams } from 'react-router'

export interface TablePaginationState {
	page: number
	pageSize: number
	totalCount: number
	totalPages: number
}

/** Rows-per-page + page navigation, driven by `page` / `pageSize` URL params. */
export function TablePagination({
	pagination,
	pageSizes = [10, 20, 30, 40, 50],
	showPageSize = true,
}: {
	pagination: TablePaginationState
	pageSizes?: number[]
	/** Hide the rows-per-page picker for routes with a fixed page size. */
	showPageSize?: boolean
}) {
	const [searchParams, setSearchParams] = useSearchParams()
	const { page, pageSize, totalPages } = pagination
	const lastPage = Math.max(totalPages, 1)

	function update(changes: Record<string, string>) {
		const params = new URLSearchParams(searchParams)
		for (const [key, value] of Object.entries(changes)) params.set(key, value)
		setSearchParams(params, { preventScrollReset: true })
	}

	return (
		<div className="flex flex-wrap items-center justify-between gap-4">
			{showPageSize ? (
				<div className="flex items-center gap-2">
					<Label htmlFor="rows-per-page" className="text-sm font-medium">
						<Trans>Rows per page</Trans>
					</Label>
					<Select
						value={pageSize.toString()}
						onValueChange={(value) =>
							update({ pageSize: String(value), page: '1' })
						}
					>
						<SelectTrigger className="w-20" id="rows-per-page">
							<SelectValue />
						</SelectTrigger>
						<SelectContent side="top">
							{pageSizes.map((size) => (
								<SelectItem key={size} value={size.toString()}>
									{size}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : (
				<span />
			)}
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground text-sm">
					<Trans>
						Page {page} of {lastPage}
					</Trans>
				</span>
				<Button
					variant="outline"
					size="icon-sm"
					className="hidden lg:inline-flex"
					onClick={() => update({ page: '1' })}
					disabled={page <= 1}
				>
					<span className="sr-only">
						<Trans>Go to first page</Trans>
					</span>
					<Icon name="chevrons-left" className="size-4" />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					onClick={() => update({ page: String(page - 1) })}
					disabled={page <= 1}
				>
					<span className="sr-only">
						<Trans>Go to previous page</Trans>
					</span>
					<Icon name="chevron-left" className="size-4" />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					onClick={() => update({ page: String(page + 1) })}
					disabled={page >= lastPage}
				>
					<span className="sr-only">
						<Trans>Go to next page</Trans>
					</span>
					<Icon name="chevron-right" className="size-4" />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					className="hidden lg:inline-flex"
					onClick={() => update({ page: String(lastPage) })}
					disabled={page >= lastPage}
				>
					<span className="sr-only">
						<Trans>Go to last page</Trans>
					</span>
					<Icon name="chevrons-right" className="size-4" />
				</Button>
			</div>
		</div>
	)
}
