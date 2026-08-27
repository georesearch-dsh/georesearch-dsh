# DeepSeek Visual Understanding

GeoResearch automatically uses DeepSeek's experimental visual-understanding
model when an attachment tool needs to interpret raster content. This route is
implemented inside `@georesearch/dsh-file-service`; it does not patch or replace
the Harness `deepseek-official` provider adapter.

## Verified Official Capability

The following facts were verified against the official DeepSeek API
documentation on 2026-08-21:

| Item | Official value |
| --- | --- |
| Release | 2026-08-21 |
| Model | `deepseek-v4-flash-vision-exp` |
| Status | Experimental multimodal visual-understanding model |
| OpenAI-compatible base URL | `https://api.deepseek.com` |
| GeoResearch endpoint | `POST /chat/completions` |
| Accepted image formats | JPEG, PNG, GIF, WebP |
| Inline or external image limit | 32 MiB per image |
| Request body limit | 48 MiB |
| Files API image limit | 64 MiB per image |
| Image count limit | 600 images per request |
| Dimension envelope | 8192 pixels per side; 4096 pixels per side for requests containing 15 or more images |
| Context and output | 1M-token context; provider maximum output 384K tokens |
| Other supported API features | Tool calls, JSON output, Responses API, and Anthropic API |
| Unsupported feature | FIM completion |

Official sources:

- <https://api-docs.deepseek.com/updates>
- <https://api-docs.deepseek.com/guides/vision>
- <https://api-docs.deepseek.com/quick_start/pricing>

## GeoResearch Request Policy

The Host resolves the existing managed `DEEPSEEK_API_KEY` credential for each
visual-analysis request. The credential is sent only in the HTTPS
`Authorization` header and is never copied into prompts, tool results, warnings,
or logs. The public endpoint and model identifier are fixed in the shipped
implementation.

GeoResearch uses the official OpenAI-compatible content-array shape with one
inline base64 `image_url`, `detail: high`, non-streaming output, and thinking
disabled. The image block precedes the variable question text, which preserves
an exact image prefix when the same image is analyzed with another question.
The plugin caps visible analysis at 4,096 output tokens and 256 KiB of
UTF-8 text, bounds response bodies at 2 MiB, and applies a 120-second internal
timeout. Caller cancellation remains authoritative and is never converted into
a fallback result. Transport failures and HTTP 408, 429, 500, 502, 503, and 504
responses receive up to five total attempts with bounded exponential backoff;
all attempts share that same 120-second timeout authority.

Successful exact requests are cached inside the long-lived file service. The
key covers the image bytes, media type, purpose, normalized question,
model/release/system policy, output cap, and a one-way credential contribution.
The cache stores only the bounded analysis result, not image bytes, and evicts
the least-recently-used entry above 64 results. A local exact hit issues no
provider request, reports zero incremental token usage, and is marked
`local-exact-hit` in tool metadata. Set `visionCacheMaxEntries` to `0` to
disable this process-local cache. Concurrent exact requests also share the
first in-flight provider call; followers return the same result as local exact
hits instead of creating duplicate requests before the LRU entry exists.

Common browser images are locally capped at 20 MiB so every accepted upload can
still use the final OCR fallback. PDF page renders and embedded document images
are already bounded at 5 MiB. TIFF and BMP are decoded under the existing pixel
and page limits, then transcoded to PNG before provider submission because the
official model does not accept TIFF or BMP directly.

PDF windows contain at most four rendered pages. Embedded-document analysis has
no plugin-defined image-count cap: every approved image inside the per-image,
cumulative-byte, selected-container-byte, and archive-entry safety envelopes is
processed with at most three concurrent provider calls. GeoResearch sends each
image in a separate request, so the official per-request image-count limits do
not constrain this route.

Different images contain different base64 tokens, so low provider prompt-cache
percentages are expected for unique pages or figures. Prompt ordering can help
when the same image is reused, while the exact local result cache removes repeat
calls only when image, purpose, and question all match.

For PPTX, only `ppt/media/*` raster content is eligible; package previews such
as `docProps/thumbnail.jpeg` are excluded. Open Packaging Convention slide
relationships link each image to every slide that uses it. Bounded slide text
and speaker notes are supplied as untrusted context, and the vision component
is asked to state how the visible image evidence supports, complements,
qualifies, or conflicts with that context. The returned tool metadata preserves
the slide numbers for provider, native-vision, and OCR outcomes.

## Automatic Routing and Fallback

In a GeoResearch session, full-page drop handling routes PNG, JPEG, WebP, and
GIF batches through the same universal attachment service as documents, source
files, data files, and archives. Pure image batches no longer bypass the plugin
through Harness-native image submission.

The GeoResearch Agent scope also shadows Harness's native `read_image` tool.
Workspace PNG, JPEG, WebP, GIF, TIFF, and BMP paths therefore enter the same
DeepSeek visual-analysis pipeline even when the selected primary model is
text-only. Path resolution and byte reads still use the Harness filesystem
service and current session workspace; non-GeoResearch Agents retain the
native Harness implementation.

The read order is deterministic:

1. `deepseek-v4-flash-vision-exp` semantic analysis.
2. The selected Harness model's native image input, only when that route and
   the Harness image store declare support.
3. Bounded local English/Simplified-Chinese Tesseract OCR.

Missing credentials, terminal provider HTTP errors, exhausted transport
retries, internal timeouts, oversized provider responses, and malformed
provider payloads produce an explicit model-visible warning before fallback.
Provider error bodies are
discarded so they cannot echo secrets or untrusted prompt content into the
agent conversation.

## Untrusted Image Content

Every image is evidence, not authority. The visual-analysis system prompt
explicitly treats instructions, commands, links, credentials requests, and
prompt text visible inside an image as untrusted data. The model may report
that such content exists, but must not follow it. Returned visual text is XML
escaped before it enters Harness tool output so image-driven text cannot close
or forge GeoResearch result tags.
