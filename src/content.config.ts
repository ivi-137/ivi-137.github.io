import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { CLASS_IDS } from './lib/classes';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    /** Complexity class — the blog's only taxonomy. */
    class: z.enum(CLASS_IDS).default('P'),
    /** Pin the sigil to a specific elementary CA rule (0–255). Otherwise derived from the title. */
    rule: z.number().int().min(0).max(255).optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
