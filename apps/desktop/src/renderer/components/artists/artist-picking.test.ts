import { describe, expect, it } from "vitest";

import { followAddress, pickInList, startPicking, type ArtistPicking } from "#/components/artists/artist-picking";

/** Picks each of `artists` in the list, and says which of them were sent to the address. */
const pick = (state: ArtistPicking, ...artists: string[]) =>
  artists.reduce(
    ({ state, navigated }, artist) => {
      const next = pickInList(state, artist);
      return { state: next.state, navigated: next.navigate ? [...navigated, artist] : navigated };
    },
    { state, navigated: [] as string[] },
  );

describe("picking an artist", () => {
  it("follows the list at once, and is left alone by the addresses it sent as they arrive", () => {
    const { state, navigated } = pick(startPicking("a"), "b", "c");
    expect(navigated).toEqual(["b", "c"]);
    expect(state.picked).toBe("c");

    const arrived = followAddress(state, "b");
    expect(arrived.picked).toBe("c");
    expect(followAddress(arrived, "c")).toEqual({ picked: "c", address: "c", sent: [] });
  });

  it("is left alone when the router skips an address the list sent", () => {
    const { state } = pick(startPicking("a"), "b", "c");
    expect(followAddress(state, "c")).toEqual({ picked: "c", address: "c", sent: [] });
  });

  it("follows an address the list did not send", () => {
    expect(followAddress(startPicking("a"), "b").picked).toBe("b");
    expect(followAddress(startPicking("a"), undefined).picked).toBeUndefined();
  });

  it("does not wait for the address it names already, so that the address can still pick that artist later", () => {
    const { state, navigated } = pick(startPicking("a"), "a");
    expect(navigated).toEqual([]);

    const elsewhere = followAddress(state, "b");
    expect(elsewhere.picked).toBe("b");
    expect(followAddress(elsewhere, "a").picked).toBe("a");
  });

  it("drops what the list sent once the address goes elsewhere", () => {
    const { state } = pick(startPicking("a"), "b");
    const elsewhere = followAddress(state, "c");
    expect(elsewhere).toEqual({ picked: "c", address: "c", sent: [] });
    expect(followAddress(elsewhere, "b").picked).toBe("b");
  });
});
