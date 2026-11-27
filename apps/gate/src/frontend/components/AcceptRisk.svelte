<script lang="ts">
  import { MAX_JUSTIFICATION_CHARS, MIN_JUSTIFICATION_CHARS } from '../../../../../packages/contracts/src/types.ts';
  import { isoDateFromToday } from '../format.ts';

  let {
    isPrAuthor,
    busy,
    onSubmit,
  }: {
    isPrAuthor: boolean;
    busy: boolean;
    onSubmit: (justification: string, dueDate: string) => void;
  } = $props();

  let expanded = $state(false);
  let justification = $state('');
  let dueDate = $state(isoDateFromToday(14));

  const length = $derived(justification.trim().length);
  const valid = $derived(length >= MIN_JUSTIFICATION_CHARS && length <= MAX_JUSTIFICATION_CHARS && dueDate !== '');
</script>

<section class="card">
  <header>
    <div>
      <h2>Accept the risk instead</h2>
      <p class="lede">
        Merge without the missing sign-offs. Ripple files a Jira ticket with this evidence and a due date, and
        links it to this commit.
        {#if !isPrAuthor}Only the PR author or the lead of the service’s Jira space can do this.{/if}
      </p>
    </div>
    {#if !expanded}
      <button class="ghost" onclick={() => (expanded = true)}>Accept risk…</button>
    {/if}
  </header>

  {#if expanded}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) onSubmit(justification.trim(), dueDate);
      }}
    >
      <label>
        <span>Why is merging now worth the risk?</span>
        <textarea bind:value={justification} rows="3" maxlength={MAX_JUSTIFICATION_CHARS} placeholder="e.g. Hotfix for an incident; mobile and reporting teams notified in #release."></textarea>
        <span class="hint">{length < MIN_JUSTIFICATION_CHARS ? `At least ${MIN_JUSTIFICATION_CHARS} characters` : `${length} / ${MAX_JUSTIFICATION_CHARS}`}</span>
      </label>
      <label class="date">
        <span>Follow-up due</span>
        <input type="date" bind:value={dueDate} min={isoDateFromToday(0)} />
      </label>
      <div class="buttons">
        <button type="button" class="ghost" disabled={busy} onclick={() => (expanded = false)}>Cancel</button>
        <button type="submit" class="danger" disabled={!valid || busy}>{busy ? 'Filing ticket…' : 'Accept risk and file ticket'}</button>
      </div>
    </form>
  {/if}
</section>

<style>
  .card {
    background: var(--surface);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    padding: 20px 22px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
  }
  .lede {
    margin: 0;
    color: var(--muted);
    max-width: 62ch;
  }
  form {
    display: grid;
    gap: 14px;
    margin-top: 16px;
  }
  label {
    display: grid;
    gap: 6px;
  }
  label > span:first-child {
    font-weight: 600;
    font-size: 13px;
  }
  textarea,
  input {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-inner);
    padding: 10px 12px;
    resize: vertical;
  }
  input {
    width: max-content;
    color-scheme: dark;
  }
  .hint {
    color: var(--faint);
    font-size: 12px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  button {
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    font-weight: 650;
    cursor: pointer;
    white-space: nowrap;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border-strong);
  }
  .danger {
    border: 0;
    background: var(--danger);
    color: #1f0c08;
  }
</style>
