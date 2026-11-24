# Textures used by the Shooting Range (render-hq.js)

All files are CC0 (public domain). Total weight about 2.7 MB.

| File | What | Source | Licence |
|---|---|---|---|
| wood_albedo_2k.webp, wood_normal_2k.webp, wood_rough_2k.webp | AK stock, grip and handguards (walnut), desktop | Poly Haven, "American Walnut Veneer" by Jenelle van Heerden, https://polyhaven.com/a/american_walnut_veneer (2K JPG maps, re-encoded to WebP) | CC0 |
| wood_albedo_1k.webp, wood_normal_1k.webp, wood_rough_1k.webp | the same maps at 1K, used on phones | as above, downscaled | CC0 |
| studio_small_08_1k.hdr (shipped as studio_small_08_1k.hdr.b64.txt, base64) | image-based lighting (PMREM environment) | Poly Haven, "Studio Small 08" by Sergej Majboroda, https://polyhaven.com/a/studio_small_08 (1K HDR) | CC0 |
| steel_rough.webp, steel_normal.webp | blued / parkerized steel: fine machining marks and grain (roughness + normal detail) | generated for this page (numpy band-limited noise, seed 1947; script in the session scratchpad, mktex.py) | CC0 (dedicated by the author) |
| phosphate_rough.webp | phosphate finish of the internal parts (matte crystalline roughness) | generated for this page, same method | CC0 (dedicated by the author) |

The Makarov grip panels are bakelite on the real pistol; they use an untextured dark-brown polymer material with a
light clearcoat, not wood. The range floor (concrete / dirt / wood deck / steel plate) is drawn procedurally on a
canvas at run time and ships no files.
