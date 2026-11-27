/**
 * `@forge/resolver` adapter for the PR overview panel. The PR and the viewer come from the
 * invocation context Forge attaches server-side; the browser payload is treated as untrusted
 * input and validated in panel.ts.
 */
import ResolverExport from '@forge/resolver';
import { errorMessage } from '@ripple/contracts';
import { acceptRisk, getPanelView, panelContextFrom, submitSignoff } from '../panel.ts';
import type { PanelActionResult, PanelResolverApi, PanelView } from '../types.ts';
import { loadGateDeps } from './deps.ts';

type ResolverClass = typeof ResolverExport;
/**
 * `@forge/resolver` is CommonJS with `exports.default = Resolver`. This package is ESM, and
 * Node's (and esbuild's) interop hands a default import of CommonJS the whole
 * `module.exports`, so the class sits one level down. Typed for both shapes.
 */
const Resolver: ResolverClass = (ResolverExport as unknown as { readonly default?: ResolverClass }).default ?? ResolverExport;

const unavailable = (message: string): PanelView => ({ status: 'UNAVAILABLE', message });

function setup(context: unknown) {
  const deps = loadGateDeps();
  if (!deps.ok) return { error: `Ripple is not configured: ${deps.error.missing} is not set.` } as const;
  const parsed = panelContextFrom(context);
  if (!parsed.ok) return { error: 'Ripple could not identify this pull request or viewer.' } as const;
  return { deps: deps.value, context: parsed.value } as const;
}

const failedAction = (message: string): PanelActionResult => ({ ok: false, reason: 'UNAVAILABLE', message, view: unavailable(message) });

const resolver = new Resolver()
  .define<unknown, PanelResolverApi['getPanelView']['result']>('getPanelView', async ({ context }) => {
    const ready = setup(context);
    if ('error' in ready) return unavailable(ready.error);
    try {
      return await getPanelView(ready.deps, ready.context);
    } catch (cause) {
      console.error('panel getPanelView failed', errorMessage(cause));
      return unavailable('Ripple hit an internal error loading this pull request.');
    }
  })
  .define<unknown, PanelResolverApi['submitSignoff']['result']>('submitSignoff', async ({ context, payload }) => {
    const ready = setup(context);
    if ('error' in ready) return failedAction(ready.error);
    try {
      const result = await submitSignoff(ready.deps, ready.context, payload);
      console.log(`panel sign-off pr=${ready.context.pr.prId} by ${ready.context.viewer}: ${result.ok ? 'recorded' : result.reason}`);
      return result;
    } catch (cause) {
      console.error('panel submitSignoff failed', errorMessage(cause));
      return failedAction('Ripple hit an internal error recording the sign-off.');
    }
  })
  .define<unknown, PanelResolverApi['acceptRisk']['result']>('acceptRisk', async ({ context, payload }) => {
    const ready = setup(context);
    if ('error' in ready) return failedAction(ready.error);
    try {
      const result = await acceptRisk(ready.deps, ready.context, payload);
      console.log(`panel accept-risk pr=${ready.context.pr.prId} by ${ready.context.viewer}: ${result.ok ? 'recorded' : result.reason}`);
      return result;
    } catch (cause) {
      console.error('panel acceptRisk failed', errorMessage(cause));
      return failedAction('Ripple hit an internal error accepting the risk.');
    }
  });

export const panelResolver = resolver.getDefinitions();
