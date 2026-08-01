/** μ-law 8kHz <-> PCM s16le 16kHz transcoding for the telephony<->Vapi bridge. */

const BIAS = 0x84;
const CLIP = 32635;

export function mulawDecode(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    let u = ~mulaw[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    out[i] = sign ? -sample : sample;
  }
  return out;
}

export function mulawEncode(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i];
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** 8k -> 16k by linear interpolation. */
export function upsample2x(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    out[2 * i] = pcm[i];
    out[2 * i + 1] = i + 1 < pcm.length ? (pcm[i] + pcm[i + 1]) >> 1 : pcm[i];
  }
  return out;
}

/** 16k -> 8k by averaging pairs. */
export function downsample2x(pcm: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = (pcm[2 * i] + pcm[2 * i + 1]) >> 1;
  }
  return out;
}

export function int16ToBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
  return out;
}

export function bufferToInt16(buf: Buffer): Int16Array {
  // Element-wise copy: pooled ws Buffers can sit at odd byteOffsets, where an
  // Int16Array view would throw or read garbage.
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Root-mean-square level of a PCM chunk; ~0 = silence, >500 = clear speech. */
export function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.round(Math.sqrt(sum / pcm.length));
}
