// Shapes shared by the worker and the client (the client imports this file too).

export type Source = "discogs" | "spotify";

export interface Record {
  /** "sp:album:<id>" for a Spotify album; "dg:m:<id>" / "dg:r:<id>" for legacy Discogs items. */
  id: string;
  source: Source;
  title: string;
  artist: string;
  /** Spotify artist id (string) or, for legacy Discogs items, a numeric Discogs id. */
  artistId?: string | number;
  kind?: "album" | "single" | "compilation";
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
  /** Track artist when it differs from the album artist (compilations, features). */
  artist?: string;
  /** YouTube video id when Discogs lists one that matches the track. */
  youtube?: string;
  /** Spotify track matched to this one (filled lazily; see /api/spotify/match). */
  spotifyUri?: string;
  spotifyUrl?: string;
  /** 30-second MP3 preview from Spotify, when the catalogue has one. */
  previewUrl?: string;
}

export interface SpotifyMatch {
  uri: string;
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  previewUrl?: string;
  url: string;
  /** 0–1: how sure the matcher is. Below ~0.7 is worth a glance. */
  confidence: number;
}

export interface RecordDetail extends Record {
  tracks: Track[];
  totalTracks?: number;
  releaseDate?: string;
}

/** What Discogs knows about a release: the back of the sleeve. Fetched on demand only. */
export interface Sleeve {
  url: string;
  title: string;
  artist: string;
  year?: number;
  label?: string;
  catno?: string;
  country?: string;
  formats?: string[];
  genres: string[];
  styles: string[];
  notes?: string;
  tracks: { position: string; title: string; duration?: string }[];
  cover?: string;
}

export interface ArtistCard {
  id: string;
  name: string;
  image?: string;
  thumb?: string;
  genres: string[];
  followers?: number;
  url: string;
}

export interface ArtistDetail extends ArtistCard {
  popularity?: number;
  topTracks: { track: Track; record: Record }[];
  records: Record[];
}

export interface TopTenItem {
  record: Record;
  /** The chosen track; absent when the album itself was added. Export uses the album's first track then. */
  track?: Track;
}

export interface TopTen {
  id: string;
  slug: string;
  title: string;
  blurb: string;
  items: TopTenItem[]; // up to 10, ordered
  spotifyPlaylistId?: string;
  spotifyUrl?: string;
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
  spotifyUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Crate {
  key: string;
  label: string;
  records: Record[];
}

export interface Status {
  /** Discogs is optional now: it powers the "read the sleeve" panel only. */
  discogs: { token: boolean; cache: number };
  spotify: { configured: boolean; connected: boolean; user?: { id: string; name: string; product?: string; url?: string } };
  ownerKeySet: boolean;
  unlocked: boolean;
}
