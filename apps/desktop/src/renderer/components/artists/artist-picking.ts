/**
 * The artist picked in the artists page's list, kept apart from the address. The router changes the
 * address in a transition, which would hold the list back until the artist's albums were drawn as well,
 * so the list follows this at once and the address follows the list.
 */
export type ArtistPicking = {
  /** `undefined` until one is picked, which shows the first. */
  readonly picked: string | undefined;
  /** The address as last seen. */
  readonly address: string | undefined;
  /** The artists the list has put in the address and the address has yet to reach, oldest first. */
  readonly sent: readonly string[];
};

export const startPicking = (address: string | undefined): ArtistPicking => ({ picked: address, address, sent: [] });

/**
 * The list picks `artist`, and `navigate` says whether the address is to name it. Picking the artist the
 * address names already, or is about to, changes nothing there.
 */
export function pickInList(state: ArtistPicking, artist: string): { state: ArtistPicking; navigate: boolean } {
  if (artist === (state.sent.at(-1) ?? state.address)) return { state: { ...state, picked: artist }, navigate: false };
  return { state: { ...state, picked: artist, sent: [...state.sent, artist] }, navigate: true };
}

/**
 * The address names `address`. An artist the list sent arrives after the list may have moved on, and
 * leaves the list alone, as do those sent before it, which the router may skip. Anything else, such as
 * the sidebar opening the page again with no artist, takes over, and what the list sent is dropped.
 */
export function followAddress(state: ArtistPicking, address: string | undefined): ArtistPicking {
  if (address === state.address) return state;
  const at = address === undefined ? -1 : state.sent.indexOf(address);
  if (at === -1) return { picked: address, address, sent: [] };
  return { ...state, address, sent: state.sent.slice(at + 1) };
}
