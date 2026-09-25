export const SITE = {
  title: 'gpojani',
  tagline: 'Field notes on emergence, complexity & machines not from here',
  description:
    'A blog about cellular automata, complex systems, computational complexity theory and the strange technology that falls out of them.',
  author: 'Gianni Pojani',
  authorGiven: 'Gianni',
  authorFamily: 'Pojani',
  github: 'ivi-137',
  lang: 'en',
  /** The colony channel worker (see /chat). Empty = chat shows as offline. */
  chatUrl: import.meta.env.DEV ? 'http://127.0.0.1:8787' : (import.meta.env.PUBLIC_CHAT_URL ?? ''),
};
