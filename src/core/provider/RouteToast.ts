// Non-blocking route switch toast — shown when the runtime switches to a different model

import type { ResolvedRoute } from '../../types/provider';

type ToastListener = (message: string, route: ResolvedRoute) => void;

let _listener: ToastListener | null = null;

export const RouteToast = {
  setListener(fn: ToastListener | null): void {
    _listener = fn;
  },

  notify(prev: ResolvedRoute | null, next: ResolvedRoute): void {
    if (!_listener) return;
    if (
      prev &&
      prev.providerId === next.providerId &&
      prev.modelId === next.modelId &&
      prev.adapterId === next.adapterId
    ) {
      return;
    }
    const message = `Using ${next.modelId} via ${next.groupName}`;
    _listener(message, next);
  },
};
