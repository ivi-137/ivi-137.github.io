/**
 * The browser transformer must compute what the JAX one computes.
 *   node scripts/check-coherence-net.mts <dir with base/ledger .json/.bin> <ref-base.json> <ref-ledger.json>
 */
import { readFileSync } from 'node:fs';
import { netFrom, type Manifest } from '../src/lib/coherence/net.ts';

const [dir, ...refs] = process.argv.slice(2);
let worst = 0;
for (const [name, refPath] of [['base', refs[0]], ['ledger', refs[1]]]) {
  const meta = JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8')) as Manifest;
  const bin = readFileSync(`${dir}/${name}.bin`);
  const net = netFrom(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  net.reset();
  let maxd = 0;
  ref.seq.forEach((tok: number, t: number) => {
    const lg = net.step(tok, t >= ref.g);
    if (t >= ref.g) {
      const r = ref.logits[t - ref.g];
      for (let i = 0; i < lg.length; i++) maxd = Math.max(maxd, Math.abs(lg[i] - r[i]));
    }
  });
  let ud = 0;
  if (ref.u && net.view) ref.u.forEach((u: number, i: number) => (ud = Math.max(ud, Math.abs(u - net.view!.u[i]))));
  console.log(name, 'max |Δlogit|', maxd.toExponential(2), ref.u ? `max |Δu| ${ud.toExponential(2)}` : '');
  worst = Math.max(worst, maxd, ud);
}
if (worst > 2e-3) (console.log('MISMATCH'), process.exit(1));
console.log('ok');
