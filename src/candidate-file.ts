export type CandidateFileResult = { text: string; format: 'text' | 'pdf'; pages?: number }

export async function extractCandidateFile(file: File): Promise<CandidateFileResult> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    return { text: await file.text(), format: 'text' }
  }
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = workerModule.default
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const document = await loadingTask.promise
  const pages = document.numPages
  const lines: string[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    let line = ''
    let previousY: number | null = null
    for (const raw of content.items) {
      if (!('str' in raw)) continue
      const item = raw as { str: string; hasEOL?: boolean; transform?: number[] }
      const y: number | null = item.transform?.[5] ?? previousY
      if (previousY !== null && y !== null && Math.abs(y - previousY) > 2 && line.trim()) {
        lines.push(line.trim())
        line = ''
      }
      line += (line ? ' ' : '') + item.str
      if (item.hasEOL && line.trim()) { lines.push(line.trim()); line = '' }
      previousY = y
    }
    if (line.trim()) lines.push(line.trim())
  }
  await loadingTask.destroy()
  return { text: lines.join('\n'), format: 'pdf', pages }
}
