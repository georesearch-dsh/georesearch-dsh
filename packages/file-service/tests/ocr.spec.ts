import { describe, expect, it } from 'vitest'
import { normalizeOcrPage, OCR_LIMITS } from '../src/ocr.js'

describe('local OCR result normalization', () => {
  it('returns bounded text and spatial line metadata', () => {
    const result = normalizeOcrPage({
      confidence: 92.5,
      text: 'Figure title\r\nClass A',
      blocks: [{
        paragraphs: [{
          lines: [{
            text: 'Figure title',
            confidence: 95,
            bbox: { x0: 10, y0: 12, x1: 180, y1: 36 },
          }],
        }],
      }],
    })

    expect(result).toMatchObject({
      engine: 'tesseract.js/7.0.0',
      languages: ['eng', 'chi_sim'],
      confidence: 92.5,
      text: 'Figure title\nClass A',
      lines: [{
        text: 'Figure title',
        confidence: 95,
        bbox: { x0: 10, y0: 12, x1: 180, y1: 36 },
      }],
      warnings: [],
    })
  })

  it('bounds hostile OCR output and reports an empty image honestly', () => {
    const huge = 'x'.repeat(OCR_LIMITS.maxTextBytes + 100)
    const bounded = normalizeOcrPage({ text: huge, blocks: [] })
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(OCR_LIMITS.maxTextBytes)
    expect(bounded.warnings.join(' ')).toMatch(/bounded/)

    const empty = normalizeOcrPage({ text: '', blocks: null })
    expect(empty.text).toBe('')
    expect(empty.warnings).toContain('No OCR text was detected in the image.')
  })
})
