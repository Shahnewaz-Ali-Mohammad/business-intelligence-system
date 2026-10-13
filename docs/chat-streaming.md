# Chat Streaming

The existing `/api/chat` endpoint now supports AG-UI server-sent events when
the browser requests `Accept: text/event-stream`. JSON clients remain compatible.
Authentication, warehouse ownership checks and rate limits run before streaming.

## Events

- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`: lifecycle.
- `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`: assistant text.
- `MESSAGES_SNAPSHOT`: replace provisional wording with the checked final text.
- `CUSTOM` (`bi_progress`): user-facing query/insight progress, not internal reasoning.
- `CUSTOM` (`bi_result`): the existing complete response, including report data.

Analytical insight generation uses the model's structured-output stream. Complete
sentences pass the existing grounding checks before publication. Scalar, exact-record,
empty-result and other deterministic answers publish once ready; they are not
artificially delayed to imitate token streaming. Final wording reconciles any draft.
Only completed responses are saved to chat history. Failed or interrupted streams
do not attach incomplete reports or store partial insight text.

Tables and graphs still use the existing report flow and appear when the complete
result is ready. Streaming improves feedback, not database execution speed.

## Running

Restart the existing read-only API process (`npm run dev:api` in
`apps/bi-dashboard`) to load its streaming changes. If using `npm run dev:all`,
restart that combined process instead. The frontend dev server reloads UI changes.
An older running backend continues to answer in JSON, but cannot stream insights
until restarted.

## Verification

Focused protocol, insight, warehouse-planner and MCP tests use in-memory fixtures,
not database seed tables or business-record writes. They cover progressive insight
delivery, correction snapshots, Unicode/CRLF boundaries, reader cancellation,
grounding fallback, incomplete/error handling and read-only tool compilation.
The production build and targeted lint checks pass. Desktop/mobile initial chat
layouts were inspected; authenticated live query streaming still requires a
signed-in session and restarted backend.

Protocol reference: https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx
