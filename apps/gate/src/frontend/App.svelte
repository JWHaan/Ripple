<script lang="ts">
  import type { SpaceKey } from '@ripple/contracts';
  import type { PanelActionResult, PanelView } from '../types.ts';
  import { call, openExternal } from './bridge.ts';
  import AcceptRisk from './components/AcceptRisk.svelte';
  import Badge from './components/Badge.svelte';
  import Findings from './components/Findings.svelte';
  import Signoffs from './components/Signoffs.svelte';
  import { STATE_LABEL, formatDate, shortSha } from './format.ts';

  const PENDING_POLL_MS = 3000;
  const UNAVAILABLE_POLL_MS = 15000;

  let view = $state<PanelView | null>(null);
  let notice = $state<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  let signing = $state<SpaceKey | null>(null);
  let accepting = $state(false);
  let refreshing = $state(false);

  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      view = await call('getPanelView', {});
    } catch {
      view = { status: 'UNAVAILABLE', message: 'Ripple could not be reached. Retrying shortly.' };
    } finally {
      refreshing = false;
    }
  }

  function apply(result: PanelActionResult, success: string): void {
    view = result.view;
    notice = result.ok ? { tone: 'ok', text: success } : { tone: 'danger', text: result.message };
  }

  async function signoff(spaceKey: SpaceKey): Promise<void> {
    if (view?.status !== 'READY') return;
    signing = spaceKey;
    notice = null;
    try {
      apply(await call('submitSignoff', { headSha: view.headSha, spaceKey }), `Signed off for ${spaceKey}.`);
    } catch {
      notice = { tone: 'danger', text: 'The sign-off could not be sent. Try again.' };
    } finally {
      signing = null;
    }
  }

  async function acceptRisk(justification: string, dueDate: string): Promise<void> {
    if (view?.status !== 'READY') return;
    accepting = true;
    notice = null;
    try {
      apply(await call('acceptRisk', { headSha: view.headSha, justification, dueDate }), 'Risk accepted. The Jira ticket is linked below.');
    } catch {
      notice = { tone: 'danger', text: 'The request could not be sent. Try again.' };
    } finally {
      accepting = false;
    }
  }

  void refresh();

  // Poll only while something is expected to change on its own.
  $effect(() => {
    const current = view;
    const delay =
      current?.status === 'READY' && current.record.state === 'ANALYSIS_PENDING'
        ? PENDING_POLL_MS
        : current?.status === 'UNAVAILABLE'
          ? UNAVAILABLE_POLL_MS
          : null;
    if (delay === null) return;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  });

  /** The merge check's own text, except where it points at this panel. */
  function statusLine(current: Extract<PanelView, { status: 'READY' }>): string {
    if (current.record.state !== 'SIGNOFF_REQUIRED') return current.check.message;
    const waiting = current.outstandingSpaceKeys;
    const total = current.record.verdict.signoffRequirements.length;
    return `Waiting on ${waiting.length} of ${total} downstream sign-off${total === 1 ? '' : 's'}: ${waiting.join(', ')}. Or accept the risk below.`;
  }

  const LIKELIHOOD_TONE = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'danger' } as const;
</script>

<main>
  <header class="top">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <span class="wordmark">Ripple</span>
      <span class="tagline">blast-radius gate</span>
    </div>
    {#if view?.status === 'READY'}
      {@const badge = STATE_LABEL[view.record.state]}
      <Badge tone={badge.tone} label={badge.label} pulse={view.record.state === 'ANALYSIS_PENDING'} />
    {/if}
  </header>

  {#if view === null}
    <section class="card quiet"><p>Loading the gate for this pull request…</p></section>
  {:else if view.status === 'UNAVAILABLE'}
    <section class="card quiet">
      <p>{view.message}</p>
      <button class="ghost" disabled={refreshing} onclick={() => void refresh()}>Retry</button>
    </section>
  {:else if view.status === 'NOT_OPEN'}
    <section class="card quiet"><p>This pull request is {view.prState.toLowerCase()}. Ripple only gates open pull requests.</p></section>
  {:else}
    {@const record = view.record}
    <section class="card status" data-check={view.check.status}>
      <div class="check">
        <span class="verdict">{view.check.status === 'FAILED' ? 'Merge blocked' : view.check.status === 'PASSED' ? 'Merge allowed' : 'Not gated'}</span>
        <p>{statusLine(view)}</p>
      </div>
      <dl class="facts">
        <div><dt>Commit</dt><dd class="mono">{shortSha(view.headSha)}</dd></div>
        <div><dt>Branch</dt><dd class="mono">{view.pullRequest.sourceBranch} → {view.pullRequest.destinationBranch}</dd></div>
        <div><dt>You</dt><dd>{view.viewer.displayName}{view.viewer.isPrAuthor ? ' (author)' : ''}</dd></div>
      </dl>
      <button class="icon" title="Refresh" aria-label="Refresh" disabled={refreshing} onclick={() => void refresh()}>↻</button>
    </section>

    {#if notice !== null}
      <div class="notice" data-tone={notice.tone} role="status">{notice.text}</div>
    {/if}

    {#if record.state === 'NO_SENSITIVE_SURFACE'}
      <section class="card quiet"><p>No schema, API contract, auth, config or shared-library surface was touched. Ripple stays out of the way.</p></section>
    {:else}
      {#if record.state === 'ANALYSIS_PENDING'}
        <section class="card quiet">
          <p>Brain is mapping the blast radius: downstream spaces, owning teams and rosters. This usually takes under a minute; the panel updates by itself.</p>
        </section>
      {:else if record.state === 'ANALYSIS_FAILED'}
        <section class="card alert">
          <h2>Analysis failed <code>{record.failure.code}</code></h2>
          <p>{record.failure.message}</p>
          <p class="faint">
            {view.willRetry
              ? `Attempt ${record.attempts} failed. Ripple retries automatically; refresh to check.`
              : 'Ripple will not retry this commit. Fix the cause and push a new commit.'}
          </p>
        </section>
      {:else if record.state === 'NOT_IN_CATALOG'}
        <section class="card alert">
          <h2>This repository isn’t in the catalog</h2>
          <p>This change touches a sensitive surface, but there is no <code>ripple.yml</code> declaring the service and its downstream Jira spaces, so no blast radius can be computed. Add one at the repository root to bring it under the gate.</p>
        </section>
      {/if}

      {#if 'verdict' in record}
        {@const narrative = record.verdict.narrative}
        {#if narrative.status === 'GROUNDED'}
          <section class="card">
            <header class="row">
              <h2>Impact</h2>
              <Badge tone={LIKELIHOOD_TONE[narrative.breakingLikelihood]} label={`${narrative.breakingLikelihood.toLowerCase()} breaking risk`} />
            </header>
            <p>{narrative.summary}</p>
            {#if narrative.spaceImpacts.length > 0}
              <ul class="impacts">
                {#each narrative.spaceImpacts as impact (impact.spaceKey)}
                  <li><code>{impact.spaceKey}</code> {impact.explanation}</li>
                {/each}
              </ul>
            {/if}
            <p class="faint small">AI summary, checked against retrieved Jira and graph facts. It explains the change; it never decides the merge.</p>
          </section>
        {/if}

        {#if record.state === 'RISK_ACCEPTED'}
          {@const exception = record.exception}
          <section class="card accepted">
            <header class="row">
              <h2>Risk accepted by {exception.acceptedBy.displayName}</h2>
              <button class="link" onclick={() => openExternal(exception.ticket.issueUrl)}>{exception.ticket.issueKey} ↗</button>
            </header>
            <p>“{exception.justification}”</p>
            <p class="faint">
              Follow-up due {formatDate(exception.dueDate)} · {exception.outstandingSpaces.length} sign-off{exception.outstandingSpaces.length === 1 ? '' : 's'} waived: {exception.outstandingSpaces.join(', ')}
            </p>
          </section>
        {/if}

        <Signoffs
          requirements={record.verdict.signoffRequirements}
          signoffs={record.signoffs}
          viewer={view.viewer}
          open={record.state === 'SIGNOFF_REQUIRED'}
          busy={signing}
          onSignoff={(spaceKey) => void signoff(spaceKey)}
        />

        {#if record.state === 'SIGNOFF_REQUIRED'}
          <AcceptRisk isPrAuthor={view.viewer.isPrAuthor} busy={accepting} onSubmit={(j, d) => void acceptRisk(j, d)} />
        {/if}
      {/if}

      <Findings diff={record.diff} />
    {/if}
  {/if}
</main>

<style>
  main {
    display: grid;
    gap: var(--gap);
    padding: 16px;
    max-width: 960px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent), 0 0 0 8px color-mix(in srgb, var(--accent) 9%, transparent);
  }
  .wordmark {
    font-weight: 700;
    letter-spacing: -0.01em;
    font-size: 15px;
  }
  .tagline {
    color: var(--faint);
    font-size: 12.5px;
  }
  .card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px 22px;
  }
  .card p {
    margin: 0 0 8px;
  }
  .card p:last-child {
    margin-bottom: 0;
  }
  .card h2 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
  }
  .quiet {
    color: var(--muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .alert {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
  }
  .accepted {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }
  .status {
    display: grid;
    gap: 14px;
    padding-right: 64px;
  }
  .status[data-check='FAILED'] {
    border-color: color-mix(in srgb, var(--warn) 40%, var(--border));
  }
  .status[data-check='PASSED'] {
    border-color: color-mix(in srgb, var(--ok) 40%, var(--border));
  }
  .verdict {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .status[data-check='FAILED'] .verdict {
    color: var(--warn);
  }
  .status[data-check='PASSED'] .verdict {
    color: var(--ok);
  }
  .check p {
    margin: 4px 0 0;
    color: var(--muted);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 28px;
    margin: 0;
  }
  .facts div {
    display: grid;
  }
  dt {
    color: var(--faint);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  dd {
    margin: 0;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .row h2 {
    margin: 0;
  }
  .impacts {
    margin: 8px 0 10px;
    padding-left: 18px;
    display: grid;
    gap: 4px;
    color: var(--muted);
  }
  .impacts code {
    color: var(--text);
    margin-right: 4px;
  }
  .notice {
    border-radius: var(--radius-inner);
    padding: 10px 14px;
    font-weight: 500;
  }
  .notice[data-tone='ok'] {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
  }
  .notice[data-tone='danger'] {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }
  .faint {
    color: var(--faint);
  }
  .small {
    font-size: 12px;
  }
  button {
    cursor: pointer;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 7px 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .icon {
    position: absolute;
    top: 18px;
    right: 18px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--surface-raised);
    font-size: 16px;
    line-height: 1;
  }
  .icon:disabled {
    opacity: 0.5;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font-weight: 650;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
