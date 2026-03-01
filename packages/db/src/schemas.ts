import { z } from "zod";

export const AlbumSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artist: z.string().nullable(),
  artistId: z.string().nullable(),
  coverArt: z.string().nullable(),
  songCount: z.number().int().nonnegative(),
  duration: z.number().int().nonnegative(),
  playCount: z.number().int().nullable(),
  year: z.number().int().nullable(),
  genre: z.string().nullable(),
  created: z.string(),
  starred: z.string().nullable(),
  played: z.string().nullable(),
  userRating: z.number().int().nullable(),
  sortName: z.string().nullable(),
  musicBrainzId: z.string().nullable(),
  isCompilation: z.boolean().nullable(),
  syncedAt: z.string(),
});

export type Album = z.infer<typeof AlbumSchema>;

export const GetAlbumListOptionsSchema = z.object({
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type GetAlbumListOptions = z.infer<typeof GetAlbumListOptionsSchema>;
