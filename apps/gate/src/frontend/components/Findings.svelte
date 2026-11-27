<script lang="ts">
  import type { DiffSummary } from '@ripple/contracts';
  import { SEVERITY_TONE } from '../format.ts';

  let { diff }: { diff: DiffSummary } = $props();
</script>

<section class="card">
  <header>
    <h2>What this change touches</h2>
    <span class="meta">{diff.filesChanged} file{diff.filesChanged === 1 ? '' : 's'} · +{diff.linesAdded} −{diff.linesRemoved}</span>
  </header>

  {#if diff.findings.length === 0}
    <p class="empty">No cross-cutting surface was detected.</p>
  {:else}
    <ul>
      {#each diff.findings as finding (finding.ruleId + finding.filePath)}
        <li data-tone={SEVERITY_TONE[finding.severity]}>
          <div class="row">
            <code class="rule">{finding.ruleId}</code>
            <span class="severity">{finding.severity.toLowerCase()}</span>
          </div>
          <code class="path">{finding.filePath}</code>
          <p class="statement">{finding.statement}</p>
          {#if finding.excerpt}
            <pre class="excerpt">{finding.excerpt}</pre>
          {/if}
        </li>
      {/each}
    </ul>
    {#if diff.truncated}
      <p class="empty">The diff was large, so some findings or excerpts were cut.</p>
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px 22px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 14px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .meta {
    color: var(--faint);
    font-size: 12.5px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  li {
    --tone: var(--neutral);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-left: 3px solid var(--tone);
    border-radius: var(--radius-inner);
    padding: 12px 14px;
    display: grid;
    gap: 4px;
  }
  li[data-tone='info'] { --tone: var(--info); }
  li[data-tone='warn'] { --tone: var(--warn); }
  li[data-tone='danger'] { --tone: var(--danger); }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .rule {
    color: var(--text);
    font-weight: 600;
  }
  .severity {
    color: var(--tone);
    font-size: 12px;
    font-weight: 600;
    text-transform: capitalize;
  }
  .path {
    color: var(--muted);
    word-break: break-all;
  }
  .statement {
    margin: 4px 0 0;
  }
  .excerpt {
    margin: 6px 0 0;
    padding: 10px 12px;
    background: var(--bg);
    border-radius: 10px;
    color: var(--muted);
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 160px;
    overflow: auto;
  }
  .empty {
    margin: 0;
    color: var(--muted);
  }
</style>
