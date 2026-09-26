// Spotify playback in the browser. Two lanes:
//  - previews: a 30-second MP3 from the catalogue, played with a plain <audio>; works for anyone.
//  - Web Playback SDK: full tracks, only when the connected account is Premium and the owner key
//    is set in this browser (the SDK needs an access token, which /api/spotify/token gates).

import { api } from "../api";

declare global {
  interface Window { onSpotifyWebPlaybackSDKReady?: () => void; Spotify?: SpotifyNS }
}
interface SpotifyNS { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer }
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (state: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export type Lane = "sdk" | "preview";

let sdkLoading: Promise<SpotifyNS> | null = null;
let player: SdkPlayer | null = null;
let deviceId: string | null = null;
let ready: Promise<string> | null = null;
let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  const t = await api.spotifyToken();
  tokenCache = { accessToken: t.accessToken, expiresAt: t.expiresAt };
  return t.accessToken;
}

function loadSdk(): Promise<SpotifyNS> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify!);
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.onerror = () => reject(new Error("Could not load the Spotify player."));
    document.head.appendChild(s);
  });
  return sdkLoading;
}

/** Connects the SDK player once and resolves with its device id. */
export function connectPlayer(): Promise<string> {
  if (ready) return ready;
  ready = (async () => {
    const Spotify = await loadSdk();
    player = new Spotify.Player({ name: "Crate Digger", getOAuthToken: (cb) => { token().then(cb).catch(() => cb("")); }, volume: 0.8 });
    const id = await new Promise<string>((resolve, reject) => {
      player!.addListener("ready", ({ device_id }) => resolve(device_id));
      player!.addListener("initialization_error", ({ message }) => reject(new Error(message)));
      player!.addListener("authentication_error", ({ message }) => reject(new Error(message)));
      player!.addListener("account_error", () => reject(new Error("Full playback needs Spotify Premium.")));
      player!.connect().then((ok) => { if (!ok) reject(new Error("The Spotify player did not connect.")); });
      window.setTimeout(() => reject(new Error("The Spotify player took too long to start.")), 15_000);
    });
    deviceId = id;
    return id;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function playUri(uri: string): Promise<void> {
  const id = deviceId ?? (await connectPlayer());
  const t = await token();
  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(id)}`, {
    method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ uris: [uri] }),
  });
  if (!res.ok && res.status !== 204) throw new Error(res.status === 403 ? "Full playback needs Spotify Premium." : `Spotify would not play that (${res.status}).`);
}

export async function pausePlayer(): Promise<void> {
  try { await player?.pause(); } catch { /* not playing */ }
}

export function onPlayerState(cb: (s: { paused: boolean; position: number; duration: number; uri?: string }) => void): void {
  player?.addListener("player_state_changed", (state) => {
    if (!state) return;
    cb({ paused: state.paused, position: state.position, duration: state.duration, uri: state.track_window?.current_track?.uri });
  });
}
