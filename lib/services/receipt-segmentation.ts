/**
 * Receipt segmentation — PURE JAVASCRIPT (no WASM, no opencv).
 *
 * Background: @techstark/opencv-js hangs on import inside the Next.js server
 * runtime (dev AND production build) — its WASM init wedges the request. It
 * only worked in plain `node` (the diag). So this is a from-scratch pure-JS
 * reimplementation of the same idea that produced the accurate boxes in the
 * diag: threshold the bright paper off the dark surface, label the connected
 * white blobs (= the receipts), and box each one. `sharp` is used only to
 * read raw pixels (it runs fine on the Mac and on Vercel).
 *
 * Given the full multi-receipt scan + one rough centre per receipt (the LLM's
 * strength), return one padded pixel box per receipt for the route to crop +
 * re-extract at full resolution (which is what makes line items readable).
 *
 * Steps:
 *   1. sharp → greyscale raw pixels.
 *   2. Downscale ~4x by max-pooling (faster CC + merges small text/gap holes
 *      so a receipt stays one blob; separated receipts keep their dark gap).
 *   3. Otsu threshold → bright paper = foreground.
 *   4. Connected-components labelling (8-connectivity) → blob per receipt,
 *      with its bounding box.
 *   5. Snap each seed to its blob; box = that blob's bbox (or, for touching
 *      receipts sharing one blob, split the blob's pixels by nearest seed).
 *   6. Scale boxes back to full res, pad generously (OVERLAPS ALLOWED — a
 *      crop never clips a receipt; neighbour bleed is fine), clamp.
 *
 * Returns one box per seed, index-aligned (box[i] ↔ seeds[i]); null where a
 * seed can't be resolved to a blob — the caller falls back to the seed's
 * rough polygon bbox for that receipt.
 */

import sharp from "sharp";

export interface ReceiptBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Otsu's method: pick the grey threshold that maximises between-class
 *  variance. `hist` is a 256-bin histogram; returns the threshold [0..255]. */
function otsuThreshold(hist: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export async function segmentReceiptBoxes(
  buffer: Buffer,
  seeds: Array<{ x: number; y: number }>,
  opts: { minAreaFrac?: number; padFrac?: number } = {}
): Promise<Array<ReceiptBox | null>> {
  const minAreaFrac = opts.minAreaFrac ?? 0.02;
  const padFrac = opts.padFrac ?? 0.06;
  if (!seeds.length) return [];

  // 1. Decode to greyscale raw pixels. sharp's .greyscale() may still emit
  //    3 channels (R=G=B), so read the channel count and stride by it.
  const { data: gray, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels || 1;
  if (!W || !H) return seeds.map(() => null);

  // 2. Downscale ~4x by max-pooling the grey value (keeps bright paper, and
  //    merges small dark text/barcode holes so a receipt stays one blob).
  const F = 4;
  const w = Math.max(1, Math.ceil(W / F));
  const h = Math.max(1, Math.ceil(H / F));
  const small = new Uint8Array(w * h);
  for (let sy = 0; sy < h; sy++) {
    const y0 = sy * F;
    const y1 = Math.min(H, y0 + F);
    for (let sx = 0; sx < w; sx++) {
      const x0 = sx * F;
      const x1 = Math.min(W, x0 + F);
      let mx = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * W;
        for (let xx = x0; xx < x1; xx++) {
          const v = gray[(row + xx) * ch]; // R channel (R=G=B after greyscale)
          if (v > mx) mx = v;
        }
      }
      small[sy * w + sx] = mx;
    }
  }

  // 3. Otsu threshold on the small image → bright paper = foreground.
  const hist = new Array(256).fill(0);
  for (let i = 0; i < small.length; i++) hist[small[i]]++;
  const t = otsuThreshold(hist, small.length);
  const fg = new Uint8Array(w * h); // 1 = paper
  for (let i = 0; i < small.length; i++) fg[i] = small[i] > t ? 1 : 0;

  // 4. Connected components (8-connectivity), iterative stack flood-fill.
  const labels = new Int32Array(w * h).fill(0);
  type Blob = { minX: number; minY: number; maxX: number; maxY: number; count: number };
  const blobs: Blob[] = []; // index = label-1
  const stack: number[] = [];
  const neigh = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
  for (let start = 0; start < fg.length; start++) {
    if (fg[start] === 0 || labels[start] !== 0) continue;
    const label = blobs.length + 1;
    const blob: Blob = { minX: w, minY: h, maxX: 0, maxY: 0, count: 0 };
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      if (px < blob.minX) blob.minX = px;
      if (px > blob.maxX) blob.maxX = px;
      if (py < blob.minY) blob.minY = py;
      if (py > blob.maxY) blob.maxY = py;
      blob.count++;
      for (let k = 0; k < 8; k++) {
        // Guard horizontal wrap-around for the diagonal/horizontal neighbours.
        if ((k === 0 || k === 4 || k === 6) && px === 0) continue;
        if ((k === 1 || k === 5 || k === 7) && px === w - 1) continue;
        const np = p + neigh[k];
        if (np < 0 || np >= fg.length) continue;
        if (fg[np] === 1 && labels[np] === 0) {
          labels[np] = label;
          stack.push(np);
        }
      }
    }
    blobs.push(blob);
  }

  const minCount = minAreaFrac * w * h;

  // Snap a seed (small-image px) to the nearest foreground pixel → its label.
  const labelAt = (sx: number, sy: number): number => {
    sx = Math.min(w - 1, Math.max(0, Math.round(sx)));
    sy = Math.min(h - 1, Math.max(0, Math.round(sy)));
    if (fg[sy * w + sx]) return labels[sy * w + sx];
    const maxR = Math.round(w * 0.12);
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const yy = sy + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring
          const xx = sx + dx;
          if (xx < 0 || xx >= w) continue;
          const idx = yy * w + xx;
          if (fg[idx]) return labels[idx];
        }
      }
    }
    return 0;
  };

  const seedSmall = seeds.map((s) => ({ x: (s.x * W) / F, y: (s.y * H) / F }));
  const seedLabel = seedSmall.map((p) => labelAt(p.x, p.y));

  // Group seed indices by blob label (to detect touching receipts).
  const seedsByLabel = new Map<number, number[]>();
  seedLabel.forEach((l, i) => {
    if (!l) return;
    let arr = seedsByLabel.get(l);
    if (!arr) {
      arr = [];
      seedsByLabel.set(l, arr);
    }
    arr.push(i);
  });

  // Convert a small-image bbox → padded full-res ReceiptBox.
  const toFull = (minX: number, minY: number, maxX: number, maxY: number): ReceiptBox => {
    let x0 = minX * F;
    let y0 = minY * F;
    let x1 = (maxX + 1) * F;
    let y1 = (maxY + 1) * F;
    const pad = padFrac * Math.max(x1 - x0, y1 - y0);
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad));
    y1 = Math.min(H, Math.ceil(y1 + pad));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };

  const out: Array<ReceiptBox | null> = seeds.map(() => null);

  for (const [label, sIdx] of Array.from(seedsByLabel.entries())) {
    const blob = blobs[label - 1];
    if (!blob || blob.count < minCount) continue; // too small / noise → null
    if (sIdx.length === 1) {
      out[sIdx[0]] = toFull(blob.minX, blob.minY, blob.maxX, blob.maxY);
    } else {
      // Touching receipts share one blob: split its pixels by nearest seed,
      // accumulating a bbox per seed (no Voronoi clip — overlaps allowed).
      const acc = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>(
        sIdx.map((i) => [i, { minX: w, minY: h, maxX: 0, maxY: 0 }])
      );
      for (let p = 0; p < labels.length; p++) {
        if (labels[p] !== label) continue;
        const px = p % w;
        const py = (p - px) / w;
        let best = sIdx[0];
        let bd = Infinity;
        for (const i of sIdx) {
          const dx = px - seedSmall[i].x;
          const dy = py - seedSmall[i].y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        const b = acc.get(best)!;
        if (px < b.minX) b.minX = px;
        if (px > b.maxX) b.maxX = px;
        if (py < b.minY) b.minY = py;
        if (py > b.maxY) b.maxY = py;
      }
      for (const [i, b] of Array.from(acc.entries())) {
        if (b.maxX < b.minX) continue;
        out[i] = toFull(b.minX, b.minY, b.maxX, b.maxY);
      }
    }
  }

  return out;
}
