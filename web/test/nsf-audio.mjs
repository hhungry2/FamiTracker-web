// Shared spectral comparison for NSF and tracker playback.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1)
      j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    for (let i = 0; i < n; i += length)
      for (let k = 0; k < length / 2; ++k) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const a = i + k, b = a + length / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
}

// How alike two sounds are, 0 to 1: the cosine of their magnitude spectra, window by
// window of 2048 samples, weighted by how loud the windows are
export function likeness(a, b, size = 2048) {
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const spectrum = (pcm, at) => {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; ++i)
      re[i] = pcm[at + i] * window[i];
    fft(re, im);
    return Float64Array.from({ length: size / 2 }, (_, i) => Math.hypot(re[i], im[i]));
  };
  let sum = 0, weight = 0;
  for (let at = 0; at + size <= Math.min(a.length, b.length); at += size) {
    const x = spectrum(a, at), y = spectrum(b, at);
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < x.length; ++i) {
      xy += x[i] * y[i];
      xx += x[i] * x[i];
      yy += y[i] * y[i];
    }
    const loud = Math.sqrt(xx) + Math.sqrt(yy);
    if (loud > 0) {
      sum += loud * xy / Math.sqrt(xx * yy || 1);
      weight += loud;
    }
  }
  return weight ? sum / weight : 1;
}
