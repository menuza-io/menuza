import {
	type ChunkedExportResult,
	type ExportChunk,
	type ExportProgress,
	runChunkedCsvExport,
} from '@repo/reports/export'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Browser side of a chunked export (#386): runs `runChunkedCsvExport`, keeps
 * the progress for the panel and saves the file once, after the last page. A
 * cancel (or leaving the page) aborts the request in flight and drops every
 * page read, so no partial file is ever saved. One hook serves every export
 * (order history, customer list).
 */

export type ChunkedExportState =
	| { status: 'idle' }
	| {
			status: 'running'
			progress: ExportProgress
			/** The cap cuts the result: shown before the download starts. */
			cut: { matching: number; total: number } | null
	  }
	| {
			status: 'done'
			rowCount: number
			cut: { matching: number; total: number } | null
	  }
	| { status: 'cancelled' }
	| { status: 'failed' }

export type StartChunkedExport = {
	filename: string
	header?: string[]
	fetchChunk: (
		cursor: string | null,
		signal: AbortSignal,
	) => Promise<ExportChunk>
}

/** Saves a finished file. A plain anchor click: the browser owns the download. */
export function saveBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = filename
	anchor.click()
	// Revoked on the next turn so the click has started the download.
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function useChunkedExport(save: typeof saveBlob = saveBlob) {
	const [state, setState] = useState<ChunkedExportState>({ status: 'idle' })
	const controller = useRef<AbortController | null>(null)

	// Leaving the page frees the request and the pages read so far.
	useEffect(() => () => controller.current?.abort(), [])

	const cancel = useCallback(() => controller.current?.abort(), [])

	const start = useCallback(
		async (
			options: StartChunkedExport,
		): Promise<ChunkedExportResult | null> => {
			if (controller.current) return null
			const own = new AbortController()
			controller.current = own
			let cut: { matching: number; total: number } | null = null
			setState({
				status: 'running',
				progress: {
					rowsDone: 0,
					rowsTotal: 0,
					percent: 0,
					elapsedMs: 0,
					etaMs: null,
				},
				cut: null,
			})
			try {
				const result = await runChunkedCsvExport({
					header: options.header,
					fetchChunk: options.fetchChunk,
					signal: own.signal,
					onStart: (info) => {
						if (info.truncated) {
							cut = { matching: info.matching, total: info.total }
						}
					},
					onProgress: (progress) =>
						setState({ status: 'running', progress, cut }),
				})
				if (result.status === 'cancelled') {
					setState({ status: 'cancelled' })
					return result
				}
				save(result.blob, options.filename)
				setState({ status: 'done', rowCount: result.rowCount, cut })
				return result
			} catch {
				setState({ status: 'failed' })
				return null
			} finally {
				controller.current = null
			}
		},
		[save],
	)

	return { state, start, cancel, running: state.status === 'running' }
}
