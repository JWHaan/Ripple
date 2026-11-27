/**
 * Typed wrapper over `@forge/bridge`: the panel can only call resolver methods declared in
 * `PanelResolverApi`, with that method's payload, and gets that method's result type back.
 */
import { invoke, router } from '@forge/bridge';
import type { PanelResolverApi, PanelResolverMethod } from '../types.ts';

export async function call<M extends PanelResolverMethod>(
  method: M,
  payload: PanelResolverApi[M]['payload'],
): Promise<PanelResolverApi[M]['result']> {
  // The resolver returns exactly PanelResolverApi[M]['result'] (forge/panel-resolver.ts).
  return (await invoke(method, payload)) as PanelResolverApi[M]['result'];
}

/** Links leave the sandboxed iframe through the host, not a plain anchor. */
export function openExternal(url: string): void {
  void router.open(url);
}
