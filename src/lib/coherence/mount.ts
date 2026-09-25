/** Everything live in "You need coherence", loaded only on pages that use it. */
import { mountAudit } from './audit-ui';
import { mountDemo } from './demo';
import { mountFigures } from './figures';

export function mountCoherence(root: ParentNode = document) {
  mountFigures(root);
  root.querySelectorAll<HTMLElement>('[data-ledger-demo]').forEach(mountDemo);
  root.querySelectorAll<HTMLElement>('[data-audit]').forEach(mountAudit);
}
