<script lang="ts">
  import type { Tone } from '../format.ts';

  let { tone, label, pulse = false }: { tone: Tone; label: string; pulse?: boolean } = $props();
</script>

<span class="badge" data-tone={tone}>
  <span class="dot" class:pulse></span>
  {label}
</span>

<style>
  .badge {
    --tone: var(--neutral);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 10px;
    border-radius: var(--radius-pill);
    border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
    background: color-mix(in srgb, var(--tone) 12%, transparent);
    color: var(--tone);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }
  .badge[data-tone='info'] { --tone: var(--info); }
  .badge[data-tone='warn'] { --tone: var(--warn); }
  .badge[data-tone='danger'] { --tone: var(--danger); }
  .badge[data-tone='ok'] { --tone: var(--ok); }
  .badge[data-tone='accent'] { --tone: var(--accent); }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .pulse {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
