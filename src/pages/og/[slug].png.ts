import type { APIRoute, GetStaticPaths } from 'astro';
import { catalogue, getPosts, type Post } from '../../lib/posts';
import { renderOg } from '../../lib/og';

export const getStaticPaths: GetStaticPaths = async () =>
  (await getPosts()).map((post) => ({ params: { slug: post.id }, props: { post } }));

export const GET: APIRoute = async ({ props }) => {
  const { post } = props as { post: Post };
  const png = await renderOg({
    title: post.data.title,
    kicker: `gpojani.me · transmission ${catalogue(post.number)}`,
    seed: post.data.title,
    rule: post.data.rule,
    cls: post.data.class,
  });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
