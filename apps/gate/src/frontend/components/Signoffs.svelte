<script lang="ts">
  import type { SignoffRequirement, SpaceKey } from '@ripple/contracts';
  import type { SignoffRecord, ViewerContext } from '../../types.ts';
  import { formatDate } from '../format.ts';

  let {
    requirements,
    signoffs,
    viewer,
    open,
    busy,
    onSignoff,
  }: {
    requirements: readonly SignoffRequirement[];
    signoffs: readonly SignoffRecord[];
    viewer: ViewerContext;
    /** True only while the gate is waiting on sign-offs for this commit. */
    open: boolean;
    busy: SpaceKey | null;
    onSignoff: (spaceKey: SpaceKey) => void;
  } = $props();

  const signedFor = (key: SpaceKey) => signoffs.find((signoff) => signoff.spaceKey === key);

  function owners(requirement: SignoffRequirement): string {
    const teams = requirement.ownership.teams.map((team) => team.displayName);
    if (teams.length > 0) return teams.join(', ');
    return requirement.ownership.lead?.displayName ?? 'No owner resolved';
  }

  const SOURCE_NOTE = {
    SPACE_TEAM: 'linked team',
    LEAD_TEAM: "project lead's team",
    LEAD_ONLY: 'project lead',
    UNRESOLVED: 'no owner found',
  } as const;

  /** Why the viewer cannot sign this space, or null when they can. Brain re-checks either way. */
  function blocker(requirement: SignoffRequirement): string | null {
    if (viewer.isPrAuthor) return 'Authors can’t sign their own change';
    if (requirement.roster.status === 'DEGRADED') return null;
    return viewer.rosterSpaceKeys.includes(requirement.spaceKey) ? null : 'Only the owning team can sign';
  }
</script>

<section class="card">
  <header>
    <h2>Downstream sign-offs</h2>
    <span class="meta">{signoffs.length} of {requirements.length} signed</span>
  </header>

  {#if requirements.length === 0}
    <p class="empty">No downstream space needs a sign-off for this change.</p>
  {:else}
    <ul>
      {#each requirements as requirement (requirement.spaceKey)}
        {@const signed = signedFor(requirement.spaceKey)}
        {@const why = blocker(requirement)}
        <li class:signed={signed !== undefined}>
          <div class="who">
            <div class="title">
              <code class="space">{requirement.spaceKey}</code>
              <span class="name">{requirement.spaceName}</span>
            </div>
            <div class="owners">
              {owners(requirement)}
              <span class="faint">· {SOURCE_NOTE[requirement.ownership.source]}</span>
            </div>
            {#if requirement.roster.status === 'DEGRADED'}
              <div class="degraded">Ownership could not be verified. Anyone except the author can sign, and the sign-off is flagged.</div>
            {/if}
          </div>

          <div class="action">
            {#if signed !== undefined}
              <span class="done">✓ {signed.signer.displayName}</span>
              <span class="faint small">{formatDate(signed.signedAt)}{signed.authorization === 'UNVERIFIED_ROSTER_DEGRADED' ? ' · unverified' : ''}</span>
            {:else if !open}
              <span class="faint">Not signed</span>
            {:else if why !== null}
              <span class="faint small">{why}</span>
            {:else}
              <button class="primary" disabled={busy !== null} onclick={() => onSignoff(requirement.spaceKey)}>
                {busy === requirement.spaceKey ? 'Signing…' : `Sign off for ${requirement.spaceKey}`}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
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
    margin-bottom: 14px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .meta,
  .faint {
    color: var(--faint);
    font-size: 12.5px;
  }
  .small {
    font-size: 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px 16px;
    padding: 14px 16px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-inner);
  }
  li.signed {
    border-color: color-mix(in srgb, var(--ok) 35%, var(--border));
  }
  .who {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .title {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .space {
    font-weight: 700;
  }
  .name {
    font-weight: 600;
  }
  .owners {
    color: var(--muted);
  }
  .degraded {
    margin-top: 6px;
    color: var(--warn);
    font-size: 12.5px;
  }
  .action {
    display: grid;
    justify-items: end;
    gap: 2px;
    text-align: right;
  }
  .done {
    color: var(--ok);
    font-weight: 600;
  }
  .primary {
    border: 0;
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 650;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: progress;
  }
  .empty {
    margin: 0;
    color: var(--muted);
  }
</style>
