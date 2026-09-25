"""
The group-theoretic claims of the post, checked on the toy.

  python check_symmetry.py

1. rho: G -> Sym(V) is a homomorphism for G = S6 x S4 x S3.
2. Equivariance (Proposition 3): audit(rho(g) y, g.s) == audit(y, s) for random outputs y,
   styles s and group elements g.
3. The frame is read exactly by counting (Proposition 5 with eta = 0), and the frame
   element is an involution that maps the example posts and the target into the canonical
   style, leaving no non-canonical style token.
"""
import numpy as np

from toy import (FONT0, HEAD0, K_MAX, K_MIN, MCLOSE0, MOPEN0, N_FONT, N_HEAD, N_MATH, NONCANONICAL, V, Style,
                 audit, episode, frame_perm, post, read_frame)


def rho(sf, sh, sm):
    p = np.arange(V)
    for i in range(N_FONT): p[FONT0 + i] = FONT0 + sf[i]
    for i in range(N_HEAD): p[HEAD0 + i] = HEAD0 + sh[i]
    for i in range(N_MATH): p[MOPEN0 + i], p[MCLOSE0 + i] = MOPEN0 + sm[i], MCLOSE0 + sm[i]
    return p


r = np.random.default_rng(11)
perm = lambda n: r.permutation(n)
for _ in range(4000):
    a, b = (perm(N_FONT), perm(N_HEAD), perm(N_MATH)), (perm(N_FONT), perm(N_HEAD), perm(N_MATH))
    assert (rho(*a)[rho(*b)] == rho(a[0][b[0]], a[1][b[1]], a[2][b[2]])).all()
print('1. rho is a homomorphism (4,000 random pairs)')

for _ in range(4000):
    st, k = Style.sample(r), int(r.integers(K_MIN, K_MAX + 1))
    y = post(r, st, k) if r.random() < 0.5 else [int(t) for t in r.integers(0, V, int(r.integers(1, 80)))]
    ended = bool(r.random() < 0.8)
    g = (perm(N_FONT), perm(N_HEAD), perm(N_MATH))
    p = rho(*g)
    st2 = Style(int(g[0][st.font]), int(g[1][st.head]), int(g[2][st.math]), st.why, st.src)
    assert audit(y, st, k, ended) == audit([int(p[t]) for t in y], st2, k, ended)
print('2. every monitor is equivariant (4,000 random outputs, styles and group elements)')

wrong = 0
for _ in range(3000):
    seq, g, st, k = episode(r)
    f = read_frame(seq)
    wrong += f != (st.font, st.head, st.math)
    p = frame_perm(st.font, st.head, st.math)
    assert (p[p] == np.arange(V)).all()
    c = p[np.asarray(seq)]
    end = seq.index(5)  # <req>
    assert not set(c[1:end].tolist()) & set(NONCANONICAL) and not set(c[g + 1 :].tolist()) & set(NONCANONICAL)
print(f'3. frame read by counting: {3000 - wrong} of 3,000 episodes correct; canonical frame verified')
assert wrong == 0
