// Shapes shared by the worker and the client (the client imports this file too).

export type Source = "discogs" | "spotify";

export interface Record {
  /** "dg:m:12345" for a Discogs master, "dg:r:12345" for a release, "sp:album:..." for Spotify. */
  id: string;
  source: Source;
  title: string;
  artist: string;
  artistId?: number;
  year?: number;
  label?: string;
  genres: string[];
  styles: string[];
  /** Full-resolution cover URL (proxied through /api/image). */
  cover: string;
  /** Small thumbnail URL (proxied). */
  thumb: string;
  /** Link back to the source page. */
  url: string;
}

export interface Track {
  position: string;
  title: string;
  duration?: string;
  /** YouTube video id when Discogs lists one that matches the track. */
  youtube?: string;
  spotifyUri?: string;
}

export interface RecordDetail extends Record {
  tracks: Track[];
  videos: { id: string; title: string }[];
  notes?: string;
  formats?: string[];
  country?: string;
}

export interface ArtistDetail {
  id: number;
  name: string;
  profile?: string;
  image?: string;
  records: Record[];
  keyTracks: { title: string; record: Record }[];
}

export interface TopTen {
  id: string;
  slug: string;
  title: string;
  blurb: string;
  items: Record[]; // up to 10, ordered
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistTrack {
  record: Record;
  track: Track;
  note: string; // DJ intro note
}

export interface Playlist {
  id: string;
  title: string;
  blurb: string;
  tracks: PlaylistTrack[];
  spotifyPlaylistId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Crate {
  key: string;
  label: string;
  records: Record[];
}

export interface Status {
  discogs: { token: boolean; cache: number };
  spotify: { configured: boolean; connected: boolean };
  ownerKeySet: boolean;
  unlocked: boolean;
}
