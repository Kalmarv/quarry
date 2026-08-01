import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseMagnet, parseTorrentFile } from "./torrent";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("parseTorrentFile", () => {
  test("infohash is SHA-1 of the raw info dict bytes", () => {
    const info = "d4:name8:test.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae";
    const torrent = enc(`d8:announce20:http://tracker/annce4:info${info}e`);
    const expected = createHash("sha1").update(enc(info)).digest("hex");
    const { hash, name } = parseTorrentFile(torrent);
    expect(hash).toBe(expected);
    expect(name).toBe("test.mkv");
  });

  test("throws on a torrent without an info dict", () => {
    expect(() => parseTorrentFile(enc("d3:foo3:bare"))).toThrow();
  });
});

describe("parseMagnet", () => {
  const hex = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";

  test("hex btih", () => {
    const { hash, name } = parseMagnet(
      `magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=Some.Release.2160p`,
    );
    expect(hash).toBe(hex);
    expect(name).toBe("Some.Release.2160p");
  });

  test("base32 btih decodes to the same hex", () => {
    // base32 of the same 20 bytes
    const bytes = Buffer.from(hex, "hex");
    const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const b of bytes) bits += b.toString(2).padStart(8, "0");
    let b32 = "";
    for (let i = 0; i + 5 <= bits.length; i += 5) b32 += B32[parseInt(bits.slice(i, i + 5), 2)];
    const { hash } = parseMagnet(`magnet:?xt=urn:btih:${b32}`);
    expect(hash).toBe(hex);
  });

  test("rejects a magnet without btih", () => {
    expect(() => parseMagnet("magnet:?dn=nope")).toThrow();
  });
});
