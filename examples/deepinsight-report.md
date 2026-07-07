<!--
This is a real, unedited output from a live Archie run — the exact markdown
`archie analyze` writes to `archie-report.md`. It ran against DeepInsight
(github.com/aidanc667/DeepInsight), a real ~7,000 LOC Next.js/TypeScript
research application, via:

    archie analyze . --topN 10

No text below this comment has been changed. It's included here so you can
see what Archie actually produces without cloning the repo, building it, or
paying for your own Anthropic API key.
-->

## 1. System Summary

DeepInsight is an AI-powered research assistant that accepts natural-language queries, classifies them into one of eight research modes (decision, research, intelligence, perspectives, competitive, explainer, action, forecast), optionally walks the user through clarifying questions, then orchestrates a multi-model pipeline (Claude Haiku, Claude Sonnet, and Gemini Flash) to stream a structured research report. The tech stack is Next.js 16.2.2, React 19.2.4, the Vercel AI SDK (`ai` ^6.0.145, `@ai-sdk/react` ^3.0.147, `@ai-sdk/anthropic` ^3.0.66, `@ai-sdk/google` ^3.0.58), Clerk (`@clerk/nextjs` ^7.2.2) for auth, Neon (`@neondatabase/serverless` ^1.0.2) for persistence, Upstash for rate-limiting, and Tailwind CSS 4 with shadcn components. At 70 files and 7,063 total LOC the codebase is small-to-moderate in scale but architecturally complex due to multi-model orchestration, streaming output, and a parallel async clarification flow. The overall style is a single-page application with a thin API layer: one god-component owns all client state, one pipeline file owns all server-side orchestration, and a fan-out transformer feeds a flat tree of view components.

| Metric | Value |
|--------|-------|
| Files analysed | 70 |
| Total lines of code | 7,063 |
| Highest-risk file | [`app/page.tsx`] (risk score: 0.70) |
| Files with test coverage | 0 of 10 top-risk files have `hasTests=true` |

---

**Scope of this analysis:** Archie analyzed all 70 files in this repository, ranked them by risk, and examined the top 10 in detail for this report. The remaining 60 files were not individually assessed and are not covered by this report's findings.

## 2. Top 5 Architectural Risks

### Risk 1: God-component: 986-LOC page with complexity 81 manages all app state — `app/page.tsx`
**Severity:** High
**Why this matters:** A single untested component owns every state transition (idle → checking → questioning → researching → done), all API orchestration, session persistence, and the full render tree. Any regression — a bad merge, a hook ordering bug, a stale closure — silently breaks the entire user-facing product with no test safety net.
**Root cause:** Cyclomatic complexity of 81 and 986 LOC in one 'use client' file means the component has too many independent execution paths to reason about safely. `hasTests: false` confirms there is no automated regression coverage. The file contains at least 8 `useCallback` hooks with overlapping dependency arrays (e.g. `handleAnalyze`, `handleSubmitAnswer`, `handleContinueResearch`, `handleGoDeeper`) that all close over shared mutable state.
**Evidence:** Source shows `ResearchApp` holds 20+ `useState` calls, fires parallel `fetch` chains inside `handleAnalyze` with race-condition guards (`shownQ1`, `didStartResearch` local booleans), and directly calls `localStorage`, `sessionStorage`, `submit`, and `loadSessions` — all in one render scope. `hasTests: false` is confirmed in the context pack.

### Risk 2: Central output transformer has fanIn=15 and no error handling or tests — `ai/output/structured-output.ts`
**Severity:** High
**Why this matters:** Every one of the 15 view components that imports `toStructuredOutput` will silently receive malformed or empty data if the transformer throws or returns an unexpected shape during streaming — causing blank or broken report sections for users with no visible error.
**Root cause:** `toStructuredOutput` is called on partial streaming output (explicitly noted in source comments: 'Safe to call on partial streaming output') but `hasErrorHandling: false` means no try/catch wraps the transformation. With fanIn=15, any breaking change to the function signature or the `EliteResearchOutput` schema propagates to all 15 downstream view components simultaneously.
**Evidence:** Source confirms `toStructuredOutput` uses unsafe casts such as `(raw as Record<string, unknown>).headline as string ?? ''` for the forecast mode fields, which are not part of the typed schema. `hasErrorHandling: false` is confirmed. Graph snapshot shows 15 direct importers across all view components.

### Risk 3: Race condition in parallel clarification flow can silently skip questions or double-start research — `app/page.tsx`
**Severity:** High
**Why this matters:** If the `/api/clarify/next` promise resolves after `/api/clarify/plan` and the plan returns zero questions, `handleAnalyze` calls `startResearch()` while `firstQPromise.then(...)` may still be in-flight — resulting in research starting twice or a question appearing after research has already begun, corrupting the UI state machine.
**Root cause:** The `handleAnalyze` function uses two mutable local boolean flags (`shownQ1`, `didStartResearch`) to coordinate three concurrent async chains (`firstQPromise`, `classifyPromise`, `planPromise`) without any cancellation token or state machine guard. The `.then()` callback on `firstQPromise` checks `didStartResearch` but this flag is set in a separate `await` branch that may not have executed yet when the `.then()` fires.
**Evidence:** Source shows: `firstQPromise.then(firstQ => { if (shownQ1 || didStartResearch || ...) return; ... setAppState('questioning') }).catch(() => {})` running concurrently with `const [classifyResult, plan] = await Promise.all([classifyPromise, planPromise])` followed by `didStartResearch = true; startResearch()` — the `.then` callback and the `await` branch are not mutually exclusive.

### Risk 4: sessionStorage-based auth guard is bypassable and causes sign-out on legitimate page refreshes — `app/page.tsx`
**Severity:** Medium
**Why this matters:** Users who refresh the page mid-session will be signed out unexpectedly because `sessionStorage` is cleared on tab close but also on hard refresh in some browsers, creating a poor UX. Conversely, the guard provides no real security — a user can set `sessionStorage.setItem('deepinsight-session', '1')` in DevTools to bypass the sign-out entirely.
**Root cause:** The `useEffect` in `Page` reads `sessionStorage.getItem('deepinsight-session')` and calls `signOut` if absent, but the context pack shows no code that ever *writes* this key (it is not set anywhere in `app/page.tsx`). This means the guard either always fires (signing out every user on load) or relies on code outside the visible source to set the key — making the auth flow fragile and opaque.
**Evidence:** Source: `const hasSession = sessionStorage.getItem('deepinsight-session'); if (!hasSession) { signOut({ redirectUrl: '/sign-in' }); return; }` — no corresponding `sessionStorage.setItem('deepinsight-session', ...)` call exists anywhere in the `app/page.tsx` source. Clerk (`@clerk/nextjs: ^7.2.2`) already manages session state server-side, making this client-side guard redundant and error-prone.

### Risk 5: Research pipeline fires an unconditional early Gemini call that is sometimes wasted — `ai/graphs/research-pipeline.ts`
**Severity:** Medium
**Why this matters:** For every query where the user has not pre-selected a mode, the pipeline fires a Gemini live-search call before classification completes. If the resolved mode turns out to be `explainer` or `perspectives` (which are explicitly excluded from `GEMINI_SEARCH_MODES`), the result is discarded — wasting API quota and adding latency cost with no user benefit.
**Root cause:** `earlyGeminiPromise` is created unconditionally when `!clientMode && !prefetchedGemini`, but `GEMINI_SEARCH_MODES` excludes `explainer` and `perspectives`. The pipeline has no way to cancel the in-flight Gemini request once classification resolves to an excluded mode, so the call always completes and its result is silently dropped.
**Evidence:** Source: `const earlyGeminiPromise = (!clientMode && !prefetchedGemini) ? callGemini(prompt).catch(() => emptyGeminiResponse) : null` — fired before `classifyQuery` resolves. Later: `const GEMINI_SEARCH_MODES = new Set(['decision', 'research', 'intelligence', 'competitive', 'action', 'forecast'])` — `explainer` and `perspectives` are absent, so the early call is wasted for those modes.

## 3. Production Failure Scenarios

### Scenario 1: Race condition silently starts research twice, corrupting the UI state machine
**Trigger:** A user submits a query where `/api/clarify/next` is slow (e.g. >800 ms) but `/api/clarify/plan` returns zero questions quickly. This is a realistic network condition on cold-start serverless functions.

**Chain of failure:**
1. `handleAnalyze` in `app/page.tsx` fires `firstQPromise` and `planPromise` concurrently.
2. `planPromise` resolves first with `plan.questions.length === 0` and `shownQ1 === false`, so the `else if (!shownQ1)` branch executes: it `await`s `firstQPromise` and, if that also returns `done: true`, calls `startResearch()` — setting `didStartResearch = true` and transitioning `appState` to `'researching'`.
3. Milliseconds later, the `.then()` callback on the original `firstQPromise` fires (it was already resolved in the microtask queue). The check `if (shownQ1 || didStartResearch || ...)` should guard this — but `didStartResearch` was set in the `await` branch of the same async function, which may not have executed before the `.then()` callback fires if the JS event loop schedules the `.then()` before the `await` resumes.
4. `setAppState('questioning')` fires while `appState` is already `'researching'`, causing the clarification UI to render on top of the loading screen. `startResearch()` may also be called a second time, firing a duplicate `submit()` to `/api/research`.
5. The user sees a broken UI: a question card appears over the loading animation, and two streaming research responses may arrive, with the second overwriting the first mid-stream.

**Business impact:** Incorrect results or a visually broken report for any user whose network causes the described timing. The `useObject` hook's `object` state will be overwritten by whichever stream finishes last, potentially showing a partially-streamed result as the final answer.

**Likelihood:** Medium — the race window is narrow but the `.then()`/`await` interleaving is a real JavaScript scheduling hazard, and cold-start latency on serverless functions makes the triggering condition common.

---

### Scenario 2: `sessionStorage` guard signs out every user on hard refresh
**Trigger:** Any authenticated user presses F5 (hard refresh) or opens the app in a new tab. In Chrome and Firefox, `sessionStorage` is tab-scoped and survives soft navigation but is cleared on a new tab; some browsers also clear it on hard refresh depending on configuration.

**Chain of failure:**
1. The `useEffect` in `Page` (`app/page.tsx`) runs on mount and calls `sessionStorage.getItem('deepinsight-session')`.
2. The key is absent (new tab, hard refresh, or first load after browser restart).
3. `signOut({ redirectUrl: '/sign-in' })` is called immediately, even though the user has a valid Clerk session cookie.
4. Clerk's `signOut` invalidates the server-side session token, not just the client state — the user is fully logged out, not just redirected.
5. The user must re-authenticate. If they were mid-research (e.g. had a report open and refreshed to copy a URL), their session and any unsaved in-memory state is lost.
6. Because no code in `app/page.tsx` writes `sessionStorage.setItem('deepinsight-session', ...)`, the only way this guard ever passes is if another file (outside the visible source) sets it. If that file has a bug or is removed, every page load signs every user out.

**Business impact:** Complete loss of user session on any hard refresh or new-tab open. For a research tool where users frequently open results in new tabs or share links, this is a high-frequency UX failure that will drive churn. If the key-writing code is ever accidentally removed, the app becomes completely unusable for all users simultaneously.

**Likelihood:** High — the guard fires on every mount, the key-writing code is not visible in `app/page.tsx`, and the described browser behaviors (new tab clears `sessionStorage`) are standard and well-documented.

---

### Scenario 3: Wasted Gemini call for `explainer`/`perspectives` queries causes rate-limit exhaustion under load
**Trigger:** Multiple users concurrently submit queries that classify as `explainer` or `perspectives` mode. This is a normal usage pattern — "How does X work?" and "Arguments for and against Y?" are common research queries.

**Chain of failure:**
1. `runResearchPipeline` in `ai/graphs/research-pipeline.ts` evaluates `(!clientMode && !prefetchedGemini)` — both are falsy for a fresh query with no client-side mode pre-selection.
2. `earlyGeminiPromise = callGemini(prompt).catch(() => emptyGeminiResponse)` fires unconditionally before `classifyQuery` resolves.
3. `classifyQuery` resolves to `explainer` or `perspectives`. Neither mode is in `GEMINI_SEARCH_MODES`, so `geminiResult` is set to `Promise.resolve(emptyGeminiResponse)` — the early Gemini call's result is discarded.
4. The Gemini API call completes (consuming quota and adding ~1–2s latency) with its result thrown away.
5. Under concurrent load (e.g. 20 users simultaneously submitting explainer queries), 20 wasted Gemini calls fire. If the Gemini API quota is shared across all users (as is typical with a single API key), legitimate `decision`/`research` mode calls begin hitting 429 rate-limit errors.
6. `callGemini` catches the 429 and returns `emptyGeminiResponse`, so the pipeline degrades silently — research reports for modes that *need* Gemini (decision, competitive) are generated without live web data, producing lower-quality, potentially stale answers with no user-visible warning.

**Business impact:** Degraded report quality for paying users on high-value query modes (decision, competitive intelligence) during traffic spikes, caused by quota waste on queries that never needed Gemini. The degradation is silent — users receive a report that looks complete but lacks live web search data.

**Likelihood:** Medium — the trigger condition (explainer/perspectives queries) is common, but the impact only materialises at meaningful concurrent load. For a growing product, this becomes a High-likelihood issue within weeks of launch.

---

## 4. Refactor Plan (step-by-step)

### Step 1: Replace the `sessionStorage` auth guard with Clerk's server-side session check
**Why now:** This is the only risk that can make the entire application unusable for all users simultaneously — a single missing `setItem` call or a new-tab open triggers a forced sign-out. Fixing it unblocks all other work by ensuring the app is reliably accessible.
**File:** `app/page.tsx`
**Effort:** half day

> **Paste into Claude Code to implement this step:**
> In `app/page.tsx`, locate the `Page` component's `useEffect` that reads `sessionStorage.getItem('deepinsight-session')` and calls `signOut` if the key is absent. Remove this `useEffect` entirely — it is redundant because `@clerk/nextjs` ^7.2.2 already manages session validity server-side via middleware, and the `sessionStorage` key is not written anywhere in this file, making the guard unreliable. Replace it with nothing: Clerk's middleware (configured in `middleware.ts` or equivalent) should be the sole auth gate. If the intent was to force re-authentication after a browser restart (not just tab close), add `sessionStorage.setItem('deepinsight-session', '1')` in the `onFinish` callback of `useObject` (which already exists in `ResearchApp`) so the key is written after a successful research run — but only do this if the product requirement for browser-restart sign-out is confirmed. The acceptance criterion is: an authenticated user who hard-refreshes the page or opens the app in a new tab is NOT signed out and sees the idle research UI normally.

---

### Step 2: Eliminate the `handleAnalyze` race condition with a single async state machine
**Why now:** The race between `firstQPromise.then()` and the `await Promise.all([classifyPromise, planPromise])` branch can cause duplicate `startResearch()` calls and broken UI state. Fixing this before adding any new clarification features prevents the bug from becoming load-bearing.
**File:** `app/page.tsx`
**Effort:** 1-2 days

> **Paste into Claude Code to implement this step:**
> In `app/page.tsx`, refactor the `handleAnalyze` function to eliminate the mutable local boolean flags `shownQ1` and `didStartResearch`. The root problem is that a `.then()` callback and an `await` branch run concurrently and both can call `startResearch()` or `setAppState('questioning')`. Replace this pattern with a single `await`-based sequential flow: (1) fire `classifyPromise` and `firstQPromise` in parallel using `Promise.all`, awaiting both before making any state decisions; (2) use the resolved values to decide once — and only once — whether to show a question or start research; (3) remove the `.then()` callback on `firstQPromise` entirely. The `planPromise` can still be chained off `classifyPromise` as today. The key constraint is that `setAppState('questioning')` and `startResearch()` must each be called at most once per `handleAnalyze` invocation, enforced by the sequential `await` structure rather than mutable flags. Acceptance criterion: submitting a query 20 times in rapid succession (using a test harness or manual testing) never results in the questioning UI appearing while `appState === 'researching'`, and the network tab shows at most one request to `/api/research` per submission.

---

### Step 3: Add a try/catch wrapper around `toStructuredOutput` in `StructuredOutputView`
**Why now:** `toStructuredOutput` has `hasErrorHandling: false` and fanIn=15. A single uncaught exception during streaming (e.g. from the unsafe `(raw as Record<string, unknown>).headline as string` cast in forecast mode) will propagate to all 15 view components simultaneously. The `OutputErrorBoundary` in `app/page.tsx` catches render errors but not errors thrown during the transform call itself. This is a quick, high-leverage fix.
**File:** `components/research/StructuredOutputView.tsx`
**Effort:** < 1 hour

> **Paste into Claude Code to implement this step:**
> In `components/research/StructuredOutputView.tsx`, locate the call to `toStructuredOutput(data)` (imported from `ai/output/structured-output.ts`). Wrap this call in a try/catch block: if `toStructuredOutput` throws, catch the error, log it to the console with `console.error('[StructuredOutputView] transform failed:', err)`, and render a fallback UI element (e.g. a `<div>` with the text "Report rendering failed — please try again." styled consistently with the existing `OutputErrorBoundary` error state). Additionally, in `ai/output/structured-output.ts`, wrap the entire body of the `toStructuredOutput` function in a try/catch that catches any exception and returns a safe default `StructuredOutput` object (all arrays empty, all strings `''`, all nullable fields `null`) rather than throwing. This two-layer defence ensures that neither a bad cast nor an unexpected schema shape can blank out the entire report view. Acceptance criterion: passing `null`, `undefined`, and a completely empty object `{}` as the `data` prop to `StructuredOutputView` renders the fallback message without throwing a React error or crashing the component tree.

---

### Step 4: Gate the early Gemini call behind a mode-eligibility check
**Why now:** Every `explainer` and `perspectives` query wastes a Gemini API call whose result is immediately discarded. Fixing this before scaling reduces API costs and protects quota for modes that actually need live web search, preventing silent quality degradation under load.
**File:** `ai/graphs/research-pipeline.ts`
**Effort:** < 1 hour

> **Paste into Claude Code to implement this step:**
> In `ai/graphs/research-pipeline.ts`, locate the line `const earlyGeminiPromise = (!clientMode && !prefetchedGemini) ? callGemini(prompt).catch(() => emptyGeminiResponse) : null`. The `GEMINI_SEARCH_MODES` set is defined later in the same function as `new Set(['decision', 'research', 'intelligence', 'competitive', 'action', 'forecast'])`. Move the `GEMINI_SEARCH_MODES` constant to module scope (above `runResearchPipeline`) so it can be referenced before the mode is classified. Then change the `earlyGeminiPromise` condition to: `(!clientMode && !prefetchedGemini && (!clientMode || GEMINI_SEARCH_MODES.has(clientMode as QueryMode)))`. Since `clientMode` is falsy in this branch by definition, the early call should only fire when there is no client mode hint — which means we cannot know the mode yet. The correct fix is therefore to remove the early Gemini call entirely for the no-client-mode path and instead fire Gemini immediately after `classifyQuery` resolves (still before Phase 2), passing the classified mode as a gate: `if (GEMINI_SEARCH_MODES.has(mode)) { earlyGeminiPromise = callGemini(geminiPrompt)... }`. Restructure the pipeline so `classifyQuery` is awaited first (it is already fast — Haiku with 150 max tokens), then Gemini is fired conditionally, then `planResearch` runs in parallel with the Gemini call. Acceptance criterion: submitting an "explainer" or "perspectives" query results in zero calls to the Gemini API endpoint (verifiable via server logs or network inspection), while "decision" and "research" queries still receive Gemini results.

---

### Step 5: Extract `ResearchApp` state into a custom hook and split the render tree
**Why now:** With the four acute bugs addressed, this step tackles the structural root cause — the 986-LOC, complexity-81 god-component. Decomposing it makes all future changes safer and makes the codebase testable. This is the highest-effort item and should be scheduled as a dedicated sprint task.
**File:** `app/page.tsx`
**Effort:** 1 week

> **Paste into Claude Code to implement this step:**
> In `app/page.tsx`, extract all `useState`, `useCallback`, `useRef`, and `useEffect` logic from the `ResearchApp` function component into a new custom hook file at `hooks/useResearchApp.ts`. The hook should accept `{ onNewChat }: { onNewChat: () => void }` as its argument and return all state values and handler functions currently defined in `ResearchApp` (including `appState`, `prompt`, `detectedMode`, `handleAnalyze`, `handleSubmitAnswer`, `handleContinueResearch`, `handleGoDeeper`, `handleSkipToResearch`, `startResearch`, `firePresearch`, and all derived values like `isResearching`, `isInputDisabled`, etc.). After extraction, `ResearchApp` should contain only JSX, calling `const { ... } = useResearchApp({ onNewChat })` at the top. Additionally, split the JSX into at minimum three sub-components: `<IdleView>` (the textarea and mode cards, rendered when `appState === 'idle'`), `<QuestioningView>` (the clarification card flow), and `<ResultsView>` (the output, chat history, and follow-up controls). Each sub-component should live in its own file under `components/research/`. The acceptance criterion is: `app/page.tsx` is under 100 LOC after the refactor, `hooks/useResearchApp.ts` contains all stateful logic, and the application behaves identically to before the refactor (manually verify all five `appState` transitions: idle → checking → questioning → researching → done, and the continue-chat flow).

---

## 5. Senior Engineer Verdict

**Overall health rating:** Functional but fragile

**Biggest strength:** The server-side pipeline architecture in `ai/graphs/research-pipeline.ts` is genuinely well-designed — parallel model calls, graceful degradation on node failure, a 1.5s cap on source extraction, and clear phase separation show real systems-thinking. The decision to prefetch Gemini during clarification and reuse the result in the pipeline is a clever latency optimization.

**Biggest risk:** The `sessionStorage` auth guard in `app/page.tsx` has no corresponding write call visible in the source, meaning it either signs out every user on every hard refresh or depends on invisible code that, if removed, makes the app completely inaccessible to all authenticated users simultaneously.

**Recommended first action:** This week, assign one developer to remove the `sessionStorage` auth guard `useEffect` from `app/page.tsx` (Step 1 above) and verify that Clerk middleware alone gates the route — this is a sub-hour change that eliminates the highest-probability total-outage vector.

This is a solo or very small team building a genuinely ambitious product — multi-model orchestration, streaming structured output, and a clarification flow are non-trivial to get right, and the pipeline layer shows they understand distributed async systems. The fragility is concentrated in one place: `app/page.tsx` accumulated all complexity as the product grew, which is a normal early-stage pattern, not a sign of poor engineering judgment. The codebase is not ready to scale — the god-component has no tests and a race condition that will manifest more frequently under load — but the foundation (the pipeline, the transformer, the schema layer) is solid enough that the refactor plan above is a straightforward extraction, not a rewrite. With the five steps above completed over two to three sprints, this becomes a maintainable, testable system.
