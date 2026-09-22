// Export: render every kept output frame through the compositor at full
// resolution, encode H.264 and AAC with WebCodecs, mux to MP4, and stream
// the bytes to Rust as they are produced. The preview and the export share
// `draw`, so what you saw is what you get.
import { invoke } from "@tauri-apps/api/core";
import { createFile, DataStream, Endianness, MP4BoxBuffer } from "mp4box";
import { Muxer, StreamTarget } from "mp4-muxer";
import { draw, type Track } from "./compositor";
import type { Edits, Project } from "./model";
import { outputMs, rateAt, speedPieces } from "./model";

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface Progress {
  phase: string;
  done: number;
  total: number;
}

export interface Cancel {
  cancelled: boolean;
}

/// The stretches of source time that survive trim and cuts, in order.
export function keptSegments(project: Project, edits: Edits) {
  const out = edits.trim.out_ms ?? project.duration_ms;
  let segs: { start: number; end: number }[] = [{ start: edits.trim.in_ms, end: out }];
  for (const c of [...edits.cuts].sort((a, b) => a.start - b.start)) {
    const next: typeof segs = [];
    for (const s of segs) {
      if (c.end <= s.start || c.start >= s.end) next.push(s);
      else {
        if (c.start > s.start) next.push({ start: s.start, end: c.start });
        if (c.end < s.end) next.push({ start: c.end, end: s.end });
      }
    }
    segs = next;
  }
  return segs.filter((s) => s.end - s.start > 1);
}

// ------------------------------------------------------------- decoding

interface Sample {
  cts: number;
  dts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data: Uint8Array;
}

/// The decoder configuration record for VideoDecoder: the payload of the
/// avcC (H.264) or hvcC (HEVC) box, serialised by mp4box and stripped of
/// its 8-byte box header.
function decoderDescription(entry: any): Uint8Array | undefined {
  const box = entry?.avcC ?? entry?.hvcC ?? entry?.av1C ?? entry?.vpcC;
  if (!box) return undefined;
  const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(ds);
  const bytes = new Uint8Array(ds.buffer as unknown as ArrayBuffer, 0, ds.getPosition());
  return bytes.slice(8);
}

/// Pulls source frames by timestamp, decoding just ahead of demand and
/// closing frames once they are behind. Sample-and-hold: the frame for
/// time t is the last frame at or before t.
export class SourceFrames {
  private samples: Sample[] = [];
  private fed = 0;
  private queue: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private decoder!: VideoDecoder;
  private firstUs = 0;
  private error: Error | null = null;
  /// The time being sought; frames behind it are released as they arrive
  /// so the decoder's output pool never fills up while skipping ahead.
  private targetUs = 0;
  cancel: Cancel = { cancelled: false };

  /// Drop every queued frame that a later queued frame already supersedes
  /// for the current target.
  private prune() {
    while (this.queue.length >= 2 && this.queue[1].timestamp <= this.targetUs) {
      this.queue.shift()!.close();
    }
  }

  static async open(url: string, step: (phase: string) => void): Promise<SourceFrames> {
    const s = new SourceFrames();
    step("Loading source");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`source fetch failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    step(`Parsing source (${(buf.byteLength / 1048576).toFixed(0)} MB)`);
    const file = createFile();
    let config: VideoDecoderConfig | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      file.onError = (_m: string, msg: string) => reject(new Error(msg));
      file.onReady = (info: any) => {
        const track = info.videoTracks[0];
        if (!track) {
          reject(new Error("no video track in source"));
          return;
        }
        const trak: any = file.getTrackById(track.id);
        const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        config = {
          codec: track.codec,
          codedWidth: track.video?.width ?? track.track_width,
          codedHeight: track.video?.height ?? track.track_height,
          description: decoderDescription(entry),
          hardwareAcceleration: "prefer-hardware",
        };
        file.setExtractionOptions(track.id, null, { nbSamples: 200 });
        file.start();
        resolve();
      };
    });
    file.onSamples = (_id: number, _user: unknown, samples: unknown[]) => {
      s.samples.push(...(samples as Sample[]));
    };
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
    file.flush();
    await ready;
    if (s.samples.length === 0) throw new Error("no frames in source");
    s.firstUs = (s.samples[0].cts * 1e6) / s.samples[0].timescale;
    step(`Configuring decoder (${config!.codec}, ${s.samples.length} frames)`);

    s.decoder = new VideoDecoder({
      output: (frame) => {
        s.queue.push(frame);
        s.prune();
      },
      error: (e) => {
        s.error = e;
      },
    });
    let support = await VideoDecoder.isConfigSupported(config!);
    if (!support.supported) {
      config!.hardwareAcceleration = "no-preference";
      support = await VideoDecoder.isConfigSupported(config!);
    }
    if (!support.supported) throw new Error(`this machine cannot decode ${config!.codec}`);
    s.decoder.configure(config!);
    return s;
  }

  private feedOne() {
    const smp = this.samples[this.fed++];
    this.decoder.decode(
      new EncodedVideoChunk({
        type: smp.is_sync ? "key" : "delta",
        timestamp: (smp.cts * 1e6) / smp.timescale - this.firstUs,
        duration: (smp.duration * 1e6) / smp.timescale,
        data: smp.data,
      }),
    );
  }

  /// The frame to draw for source time `ms`.
  async at(ms: number): Promise<VideoFrame | null> {
    if (this.error) throw this.error;
    const tUs = ms * 1000;
    this.targetUs = tUs;
    this.prune();
    // Decode until a frame beyond t exists (so the one before it is final)
    // or the source is exhausted.
    for (;;) {
      if (this.cancel.cancelled) throw new Error("cancelled");
      if (this.error) throw this.error;
      const last = this.queue[this.queue.length - 1];
      if (last && last.timestamp > tUs) break;
      if (this.fed >= this.samples.length) {
        await this.decoder.flush();
        break;
      }
      // Keep the pipeline shallow; the wait times out so cancellation
      // and decoder errors are noticed even if nothing dequeues.
      if (this.decoder.decodeQueueSize > 12) {
        await new Promise<void>((r) => {
          const done = () => {
            window.clearTimeout(timer);
            r();
          };
          const timer = window.setTimeout(done, 1000);
          this.decoder.addEventListener("dequeue", done, { once: true });
        });
        continue;
      }
      this.feedOne();
      if (this.fed % 8 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
    // Advance: keep the last frame at or before t, close the rest behind.
    while (this.queue.length && this.queue[0].timestamp <= tUs) {
      this.current?.close();
      this.current = this.queue.shift()!;
    }
    return this.current;
  }

  close() {
    this.current?.close();
    for (const f of this.queue) f.close();
    this.queue = [];
    try {
      this.decoder.close();
    } catch {
      // already closed
    }
  }
}

// ------------------------------------------------------------- helpers

function seekTo(v: HTMLVideoElement, seconds: number) {
  return new Promise<void>((resolve) => {
    if (Math.abs(v.currentTime - seconds) < 0.002 && v.readyState >= 2) {
      resolve();
      return;
    }
    const timer = window.setTimeout(done, 700);
    function done() {
      window.clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    }
    v.addEventListener("seeked", done);
    v.currentTime = seconds;
  });
}

/// Narration for the kept segments, as one 48 kHz buffer in output time.
async function narration(
  project: Project,
  cameraUrl: string,
  segs: { start: number; end: number }[],
  speeds: Edits["speeds"],
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  if (!project.camera?.has_audio) return null;
  const ctxA = new AudioContext({ sampleRate: 48000 });
  let buf: AudioBuffer;
  try {
    buf = await ctxA.decodeAudioData(await (await fetch(cameraUrl)).arrayBuffer());
  } catch {
    await ctxA.close();
    return null;
  }
  await ctxA.close();
  const rate = buf.sampleRate;
  const chans = Math.min(2, buf.numberOfChannels);
  const pieces = speedPieces(segs, speeds);
  const totalMs = outputMs(segs, speeds);
  const total = Math.ceil((totalMs / 1000) * rate);
  const out = Array.from({ length: chans }, () => new Float32Array(total));
  let outPos = 0;
  for (const s of pieces) {
    // A sped-up or slowed stretch is resampled to keep the narration in
    // step with the picture; the pitch moves with it.
    const n = Math.round(((s.end - s.start) / s.rate / 1000) * rate);
    // Camera time runs offset_ms behind source time.
    const camStart = Math.round(((s.start - project.camera.offset_ms) / 1000) * rate);
    for (let c = 0; c < chans; c++) {
      const src = buf.getChannelData(c);
      for (let i = 0; i < n && outPos + i < total; i++) {
        const j = camStart + Math.round(i * s.rate);
        out[c][outPos + i] = j >= 0 && j < src.length ? src[j] : 0;
      }
    }
    outPos += n;
  }
  return { channels: out, sampleRate: rate };
}

// --------------------------------------------------------------- export

export async function exportVideo(
  opts: ExportOptions,
  project: Project,
  edits: Edits,
  track: Track,
  dir: string,
  name: string,
  sourceUrl: string,
  cameraUrl: string | null,
  cam: HTMLVideoElement | null,
  logo: HTMLImageElement | null,
  background: HTMLImageElement | null,
  onProgress: (p: Progress) => void,
  cancel: Cancel,
): Promise<string> {
  const segs = keptSegments(project, edits);
  const totalMs = outputMs(segs, edits.speeds);
  const frameUs = 1e6 / opts.fps;
  const totalFrames = Math.max(1, Math.floor((totalMs * 1000) / frameUs));

  // Each stage reports, and logs to the terminal, so a stall is locatable.
  const step = (phase: string) => {
    onProgress({ phase, done: 0, total: totalFrames });
    void invoke("log_error", { message: `export: ${phase}` });
  };
  const source = await SourceFrames.open(sourceUrl, step);
  source.cancel = cancel;

  // Output file, streamed to Rust as the muxer produces bytes.
  step("Opening output file");
  const path = await invoke<string>("export_open", { dir, name });
  let writes: Promise<void> = Promise.resolve();
  let failed: Error | null = null;
  const target = new StreamTarget({
    onData: (data, position) => {
      const copy = new Uint8Array(data);
      writes = writes.then(async () => {
        if (failed) return;
        try {
          await invoke("export_write", copy, { headers: { "x-offset": String(position) } });
        } catch (e) {
          failed = e instanceof Error ? e : new Error(String(e));
        }
      });
    },
    chunked: true,
    chunkSize: 4 * 1024 * 1024,
  });

  if (cameraUrl) step("Decoding narration");
  const audio = cameraUrl ? await narration(project, cameraUrl, segs, edits.speeds) : null;
  step(audio ? "Configuring encoders (with narration)" : "Configuring encoders (no narration)");
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: opts.width, height: opts.height, frameRate: opts.fps },
    audio: audio
      ? { codec: "aac", sampleRate: audio.sampleRate, numberOfChannels: audio.channels.length }
      : undefined,
    fastStart: false,
    firstTimestampBehavior: "offset",
  });

  const videoConfig: VideoEncoderConfig = {
    codec: "avc1.640028",
    width: opts.width,
    height: opts.height,
    bitrate: opts.bitrate,
    framerate: opts.fps,
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "quality",
    avc: { format: "avc" },
  };
  if (!(await VideoEncoder.isConfigSupported(videoConfig)).supported) {
    videoConfig.hardwareAcceleration = "prefer-software";
    if (!(await VideoEncoder.isConfigSupported(videoConfig)).supported) {
      source.close();
      throw new Error("H.264 encoding is not available here");
    }
  }
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure(videoConfig);

  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

  const showCam = !!(cam && project.camera?.has_video && edits.camera.show);
  step(`Rendering ${totalFrames} frames`);
  try {
    // Video: walk the kept segments at the output frame rate.
    let i = 0;
    let segIndex = 0;
    let segPos = 0; // ms into the current segment
    while (i < totalFrames && segIndex < segs.length) {
      if (cancel.cancelled) throw new Error("cancelled");
      const seg = segs[segIndex];
      const tSrc = seg.start + segPos;
      if (tSrc >= seg.end) {
        segPos -= seg.end - seg.start;
        segIndex++;
        continue;
      }
      const frame = await source.at(tSrc);
      if (encodeError) throw encodeError;
      if (frame) {
        if (showCam) await seekTo(cam!, Math.max(0, (tSrc - project.camera!.offset_ms) / 1000));
        draw(ctx, { t: tSrc, source: frame, camera: showCam ? cam : null, logo, background }, project, edits, track);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
        encoder.encode(vf, { keyFrame: i % (opts.fps * 2) === 0 });
        vf.close();
        while (encoder.encodeQueueSize > 6) {
          await new Promise<void>((r) => encoder.addEventListener("dequeue", () => r(), { once: true }));
        }
      }
      i++;
      // A speed block covers more (or less) source time per output frame.
      segPos += (1000 / opts.fps) * rateAt(edits.speeds, tSrc);
      if (i === 1 || i % 5 === 0) onProgress({ phase: "Rendering", done: i, total: totalFrames });
      if (i === 1 || i % 300 === 0) void invoke("log_error", { message: `export: frame ${i} of ${totalFrames}` });
    }
    await encoder.flush();

    // Audio: hand the narration over in 20 ms slices.
    if (audio) {
      onProgress({ phase: "Encoding narration", done: totalFrames, total: totalFrames });
      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          encodeError = e;
        },
      });
      aenc.configure({
        codec: "mp4a.40.2",
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.channels.length,
        bitrate: 128_000,
      });
      const slice = Math.round(audio.sampleRate * 0.02);
      const n = audio.channels[0].length;
      for (let pos = 0; pos < n; pos += slice) {
        if (cancel.cancelled) throw new Error("cancelled");
        const len = Math.min(slice, n - pos);
        const data = new Float32Array(len * audio.channels.length);
        audio.channels.forEach((ch, c) => data.set(ch.subarray(pos, pos + len), c * len));
        aenc.encode(
          new AudioData({
            format: "f32-planar",
            sampleRate: audio.sampleRate,
            numberOfFrames: len,
            numberOfChannels: audio.channels.length,
            timestamp: Math.round((pos / audio.sampleRate) * 1e6),
            data,
          }),
        );
        if (aenc.encodeQueueSize > 16) {
          await new Promise<void>((r) => aenc.addEventListener("dequeue", () => r(), { once: true }));
        }
      }
      await aenc.flush();
      aenc.close();
      if (encodeError) throw encodeError;
    }

    onProgress({ phase: "Writing file", done: totalFrames, total: totalFrames });
    muxer.finalize();
    await writes;
    if (failed) throw failed;
    await invoke("export_close");
    return path;
  } catch (e) {
    await writes.catch(() => {});
    await invoke("export_abort").catch(() => {});
    void invoke("log_error", { message: `export failed: ${String(e instanceof Error ? e.message : e)}` });
    throw e;
  } finally {
    try {
      encoder.close();
    } catch {
      // already closed
    }
    source.close();
  }
}
