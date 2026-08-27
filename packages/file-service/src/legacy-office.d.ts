declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(): string
    getFootnotes(): string
    getEndnotes(): string
    getHeaders(options?: { readonly includeFooters?: boolean }): string
    getFooters(): string
    getAnnotations(): string
    getTextboxes(options?: { readonly includeHeadersAndFooters?: boolean; readonly includeBody?: boolean }): string
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<ExtractedWordDocument>
  }
}

declare module 'ppt-to-text' {
  interface Presentation {
    readonly slides?: readonly unknown[]
    readonly docs?: readonly unknown[]
  }

  interface PowerPointReader {
    readBuffer(input: Buffer, options?: { readonly WTF?: boolean }): Presentation
    utils: {
      to_text(presentation: Presentation): string[]
    }
  }

  const reader: PowerPointReader
  export default reader
}
