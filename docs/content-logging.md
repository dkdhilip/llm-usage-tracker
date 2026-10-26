# Prompt, response and image logging

## Prompt & response logging

Off by default; a workspace admin turns it on in **Workspace → Prompt & response logging** (everyone in
the workspace can see that it is on). This is the workspace **master** switch: each virtual key must also have
its own logging switch on (see [Per-key logging](#per-key-logging)). While on, each request's prompt and response are stored **after**
the usage row is committed, in `usage_content`, encrypted with `ENCRYPTION_KEY` (required in deployed
environments). Capture can never fail or slow a request, and usage analytics (counts, tokens, cost,
latency, status) are unchanged whether it is on or off.

- **What is stored:** a whitelist per request type (chat, Responses, Messages, Gemini, embeddings, image
  prompts, speech input, transcription prompt + file name/size) and the response text. Never stored:
  headers, cookies, virtual or provider keys, unknown request fields, images/audio/base64, embedding
  vectors, provider error text. Credential-shaped strings (`sk-…`, `vk_…`, `Bearer …`, `AIza…`, JWTs,
  `password=…`, …) are replaced by `[REDACTED:…]`. Redaction is best-effort, **not** PII scrubbing.
- **Limits:** per-field and per-side size caps (flagged `truncated`), a per-workspace row cap.
- **Who can read it:** workspace admins only, one request at a time (`GET /api/requests/{id}/content`);
  list endpoints never return content.
- **Retention:** 30 days maximum, enforced on read (expired content is never returned) and physically
  deleted at startup, opportunistically while capturing/browsing, and when the setting changes. Turning
  the setting off stops new capture; stored records still expire normally, or an admin can delete them
  at once. Deleting a key or the workspace removes its content. Usage rows are never deleted by this.
- **Streaming** responses are observed after each chunk has been forwarded — capture never buffers or
  delays a stream. A stream the client abandons records nothing (as before).
- Rotating `ENCRYPTION_KEY` makes already-stored content unreadable (it is reported as such).

## Per-key logging

Prompt/response logging and image logging are chosen **per virtual key**, under the workspace switches as
**master controls**. A key is captured only when **both** are on:

| | workspace switch | key switch |
|---|---|---|
| prompts & responses | Workspace -> Prompt & response logging | key's "Log prompts & responses" |
| images | Workspace -> "Store images" | key's "Also store images" (needs the text switch on the same key) |

- **Defaults:** both key switches are **off** for every new key, and the workspace switches are off too. Turning
  a workspace switch on does not log any key until that key's own switch is on; turning a workspace switch off
  stops every key at once but keeps each key's setting, so turning it back on restores the admin's choices.
- **Who can change them:** workspace admins only (when creating a key, or later via **Virtual keys -> Logging** or
  `PATCH /api/keys/{id}`). The key's assigned Team Member can see whether their key is logged (`GET /api/keys`).
  Nothing here shows a full key secret: keys are identified by label and `vk_...` prefix only.
- **Unchanged:** the 30-day retention, encryption, storage caps, sweeps and admin-only reading. Switching a key
  off stops *new* capture; content already stored stays until it expires or is deleted from the workspace.
- **Migration (v13):** adds the two columns. The first time they are created, existing keys **inherit their
  workspace's current state once** (a workspace that already logs keeps logging the same keys; a workspace with
  logging off keeps every key off), so no key that is not logging today starts logging. The copy never runs
  again, so re-running the migration cannot re-enable a key an admin turned off. Rolling back to a version
  without per-key switches returns to workspace-wide capture for any workspace whose master switch is on.

## Image logging

A **second, separate opt-in** on top of prompt/response logging (Workspace -> Prompt & response logging ->
"Store images"). It is off by default and turning text logging on never turns it on; it also only takes
effect while text logging is on. When enabled, admins can see the pictures sent to vision models and the
images a model generated, in the request detail panel.

- **Source:** only bytes already inside the request/response JSON - `data:` URLs and base64 fields - for
  chat/OpenRouter (`image_url`), Responses (`input_image`, `image_generation_call`), Anthropic Messages
  (base64 `source`), Gemini (`inlineData`) and `/v1/images/generations` (`b64_json`). **Links are never
  downloaded** (no server-side fetching, so no SSRF) and never stored: a signed or expiring URL is recorded
  only as "not stored". Use `response_format=b64_json` if you want generated images kept. Images in streamed
  *responses* and multipart edits are not stored.
- **Verified, not trusted:** only PNG, JPEG, GIF and WebP, checked by magic number; the declared MIME type is
  ignored. SVG/PDF/audio/other files are skipped. No resizing or transcoding.
- **Encrypted** with `ENCRYPTION_KEY` (Fernet, about 1.37x the image size) in `usage_content_images.data_encrypted`
  (BYTEA); a rotated key makes them unreadable. They expire with their text record (30 days max), are deleted
  by the same sweeps, by "Delete stored content", and by key/workspace deletion.
- **Bounded:** per image, per request, per workspace and global caps (`CONTENT_IMAGE_*`), counted on stored
  bytes and exact under concurrent requests (a Postgres advisory lock). The caps also count expired images the
  sweep has not physically deleted yet (they still occupy the database); an image-bearing request first frees
  expired images. A reached cap skips the image and records the reason; requests, text capture and analytics
  are never affected. The Workspace page shows live (unexpired) usage vs the cap.
- **Cleanup:** expired images are hidden at once and physically deleted by a startup sweep, by captures, by the
  Requests page, by toggling the settings, and by a throttled sweep (`CONTENT_SWEEP_INTERVAL_SECONDS`) that
  rides on ordinary authenticated requests, with no scheduler or extra service. A failed cleanup is logged
  (exception class and record count only) and simply retried by the next sweep.
- **Access:** workspace admins only, one image at a time through the image endpoint; list endpoints never
  contain image bytes or base64. Members can see that image logging is on, not the images.
- **Storage is finite.** Images live in the same database as everything else (on Neon's free tier the whole
  database is small, check your plan in the Neon console). The default caps (50 MB per workspace, 150 MB
  overall) are deliberately modest; raise them only if your plan has room. Deleted rows free space only
  after Postgres vacuums them.
